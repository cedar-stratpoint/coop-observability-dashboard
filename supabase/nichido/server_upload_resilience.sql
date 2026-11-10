-- Server-driven scan upload: reliability tune after the first real 98-page run.
-- Plan: knowledge/tasks/2026-11-09-server-driven-upload.md.
-- Applied to Nichido Staging (jcqlnrvplaapvcxyhcns) 2026-11-10 via MCP migrations
-- `goldline_pump_tune_concurrency` and `goldline_pump_auto_retry_stalls`. Additive only.
--
-- Why: on the first 98-page run, 5 reads never connected. pg_net's HTTP log showed the whole
-- 300s budget spent on DNS resolution (DNS time == timeout) under the 36-wide burst — the
-- request never reached the read-page function, so the page sat in 'processing' until the
-- reaper reset it to 'failed', stranding real inventory pages until a manual re-read.
--
-- Two changes:
--   1. Turn the pump burst down (max_inflight 36 -> 12, k 6 -> 4, timeout 300s -> 180s) so there
--      are far fewer simultaneous DNS lookups and a stuck slot frees sooner.
--   2. Auto-retry a stalled read (new pg_cron reaper) up to a bounded number of times before
--      failing, so a transient DNS timeout self-heals instead of silently dropping a page.
-- To pause: select cron.unschedule('goldline-reap-stalls'); (and 'goldline-pump-reads').

-- 1 ── Pump re-tuned. Body is identical to P1 (server_upload_p1_pump.sql) apart from the lower
--      defaults and the shorter per-call timeout.
create or replace function public.goldline_pump_reads(k int default 4, max_inflight int default 12)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
  v_inflight int;
  v_take int;
  v_sent int := 0;
  r record;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'goldline_read_page_url' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'goldline_pump_secret' limit 1;
  if v_url is null or v_secret is null then
    return 0; -- not wired yet; nothing to do
  end if;

  select count(*) into v_inflight
  from public.uploads
  where status = 'processing' and kind = 'inventory_pdf' and claimed_at is not null;
  v_take := least(k, greatest(0, max_inflight - v_inflight));
  if v_take <= 0 then
    return 0;
  end if;

  for r in
    update public.uploads u
    set status = 'processing', claimed_at = now()
    from (
      select id
      from public.uploads
      where status = 'queued' and kind = 'inventory_pdf'
      order by created_at
      limit v_take
      for update skip locked
    ) sub
    where u.id = sub.id
    returning u.id, u.company_id
  loop
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object('uploadId', r.id::text, 'company', r.company_id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-goldline-pump-secret', v_secret),
      timeout_milliseconds := 180000
    );
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end;
$$;

-- 2 ── Auto-retry stalls. Count how many times a page has been re-queued after a stall, so the
--      retry is bounded and can never loop.
alter table public.uploads add column if not exists read_attempts int not null default 0;

-- Re-queue reads stuck in 'processing' past the read-page function's max duration (so the
-- function is certainly dead — a DNS hang, a platform kill, a lost dispatch), up to max_attempts,
-- then fail with a re-read reason. stall_minutes MUST stay above the read-page maxDuration (300s)
-- so a still-running read is never re-queued — that would risk a double read / double inventory.
create or replace function public.goldline_reap_stalls(stall_minutes int default 7, max_attempts int default 2)
returns table(requeued int, failed int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req int := 0;
  v_fail int := 0;
begin
  with stuck as (
    select id, read_attempts
    from public.uploads
    where status = 'processing'
      and kind = 'inventory_pdf'
      and claimed_at is not null
      and claimed_at < now() - make_interval(mins => stall_minutes)
    for update skip locked
  ),
  requeue as (
    update public.uploads u
    set status = 'queued', claimed_at = null, read_attempts = u.read_attempts + 1,
        reject_reason = null, error_detail = null
    from stuck
    where u.id = stuck.id and stuck.read_attempts < max_attempts
    returning 1
  ),
  giveup as (
    update public.uploads u
    set status = 'failed', claimed_at = null,
        reject_reason = 'The read stalled and did not finish. Re-read this page to try again.',
        error_detail = 'auto-reset: stalled past the read window after ' || max_attempts || ' attempts'
    from stuck
    where u.id = stuck.id and stuck.read_attempts >= max_attempts
    returning 1
  )
  select (select count(*) from requeue), (select count(*) from giveup) into v_req, v_fail;
  requeued := v_req;
  failed := v_fail;
  return next;
end;
$$;

-- Run the reaper every minute. Idempotent via the unschedule guard so re-applying doesn't stack
-- duplicate jobs. (pg_cron sub-minute schedules are '[1-59] seconds'; 60 is out of range, so a
-- once-a-minute cron expression is used instead — a 7-minute stall window doesn't need finer.)
do $$
begin
  perform cron.unschedule('goldline-reap-stalls');
exception when others then
  null; -- job didn't exist yet
end $$;
select cron.schedule('goldline-reap-stalls', '* * * * *', 'select public.goldline_reap_stalls();');
