-- Server-driven scan upload, P1: the claim + pump.
-- Plan: knowledge/tasks/2026-11-09-server-driven-upload.md.
-- Applied to Nichido Staging (jcqlnrvplaapvcxyhcns) 2026-11-09 via MCP migration
-- `goldline_server_upload_p1_pump`. Additive only; idles until the P0 flag enqueues
-- 'queued' rows AND the two vault secrets below are set, so it changes nothing on apply.
--
-- Requires extensions pg_cron + pg_net + supabase_vault (all present on Nichido Staging).
--
-- ONE manual wiring step per environment, done once the read-page route is deployed:
--   1. Set Vercel env GOLDLINE_PUMP_SECRET on the dashboard project (any strong random string).
--   2. Set the two vault secrets below to the read-page URL and the SAME secret:
--        select vault.create_secret('https://<dashboard-host>/api/goldline/read-page', 'goldline_read_page_url');
--        select vault.create_secret('<same value as GOLDLINE_PUMP_SECRET>', 'goldline_pump_secret');
--   3. Set GOLDLINE_SERVER_UPLOAD_COMPANIES to the pilot company id (Nichido) so ingest enqueues.
-- To pause the pump: select cron.unschedule('goldline-pump-reads');

-- When a queued page was claimed by the pump (queued -> processing). Lets the app's stale-read
-- reaper tell a genuinely-stuck claim from a page still waiting in the queue.
alter table public.uploads add column if not exists claimed_at timestamptz;

-- The claim query scans only queued inventory pages, oldest first; a small partial index keeps
-- that cheap even as the uploads table grows.
create index if not exists uploads_queued_inventory_idx
  on public.uploads (created_at)
  where status = 'queued' and kind = 'inventory_pdf';

-- The pump: claim up to k queued inventory pages (flip queued -> processing + stamp claimed_at,
-- atomically, skipping rows another tick already locked) and fire one async read per page at the
-- secret-guarded /api/goldline/read-page route. The status flip IS the claim, so a page can
-- never be dispatched (and inventory-read) twice. max_inflight caps concurrent reads so the
-- queue can't fan out into an unbounded burst of Vision calls. No config in vault = no-op.
create or replace function public.goldline_pump_reads(k int default 6, max_inflight int default 36)
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

  -- Hold concurrency under the ceiling: in-flight = claimed reads not yet finished.
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
      timeout_milliseconds := 300000
    );
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end;
$$;

-- Run the pump every 30 seconds (pg_cron 1.6 supports sub-minute intervals). Idempotent via the
-- unschedule guard so re-applying doesn't stack duplicate jobs.
do $$
begin
  perform cron.unschedule('goldline-pump-reads');
exception when others then
  null; -- job didn't exist yet
end $$;
select cron.schedule('goldline-pump-reads', '30 seconds', 'select public.goldline_pump_reads();');
