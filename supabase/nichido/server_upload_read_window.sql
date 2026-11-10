-- Server-driven scan upload: widen the read window for dense pages.
-- Plan: knowledge/tasks/2026-11-09-server-driven-upload.md.
-- Applied to Nichido Staging (jcqlnrvplaapvcxyhcns) 2026-11-10 via MCP migration
-- `goldline_dense_page_read_window`. Additive only; supersedes the timeouts in
-- server_upload_resilience.sql.
--
-- Why: on the reuploads, a subset of dense V1 pages read for ~250-300s and some tipped over
-- the 300s read limit, stalling (then auto-retrying, then failing). They need more time, not
-- more retries. The read routes' maxDuration goes 300 -> 600 (app PR); these are the matching
-- DB halves.
--
-- Invariant kept: read maxDuration (600s/10m) <= pump per-call timeout (600s)
--                 < DB stall reaper (12m) < app backstop reaper (STALE_READ_MIN 15m),
-- so a read that is still running is never re-queued or failed (no double read / double stock).

-- Pump: per-call timeout 300s -> 600s (concurrency unchanged: k=4, max_inflight=12).
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
    return 0;
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
      timeout_milliseconds := 600000
    );
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end;
$$;

-- Auto-retry reaper: stall window 7 -> 12 min, so it stays ABOVE the 600s (10 min) read window
-- and never re-queues a still-running read. Body otherwise unchanged from server_upload_resilience.sql.
create or replace function public.goldline_reap_stalls(stall_minutes int default 12, max_attempts int default 2)
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
