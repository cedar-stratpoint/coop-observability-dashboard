-- L7 batch mode — the poller that ingests deferred anchored reads.
-- Plan: knowledge/tasks/2026-11-18-l7-batch-mode-scope.md
--
-- With GOLDLINE_BATCH_READ_COMPANIES set, the pump's read-page call runs classify + locate inline
-- and submits the expensive anchored read to the Anthropic Message Batches API (50% off, async),
-- leaving the page in a new 'queued_batch' status with its batch id in uploads.anthropic_batch_id.
-- This migration adds that column and a short-interval cron that POSTs /api/goldline/batch-poll,
-- which checks those batches and ingests the ended ones (sync-read fallback for failed/stale slots).
--
-- Additive + idempotent. Flag-off (no company in GOLDLINE_BATCH_READ_COMPANIES) means no page ever
-- reaches 'queued_batch', so this cron finds nothing and the pipeline behaves exactly as before.
--
-- Timeout-window note: the existing stall reaper (goldline_reap_stalls) only touches
-- status='processing', so a 'queued_batch' page is invisible to it — this poller owns that
-- lifecycle, with its own in-app stale-batch fallback (25h, past the Batches API 24h SLA).

-- 1 ── The batch id each queued page's anchored read was submitted in.
alter table public.uploads add column if not exists anthropic_batch_id text;

-- 2 ── Poller: nudge the app to ingest ended batches. Only fires when there is queued_batch work,
-- so the cron is nearly free when batch mode is off or idle. Reuses the pump's vault url + secret;
-- the poll endpoint sits next to read-page, so derive it by swapping the path.
create or replace function public.goldline_poll_batches()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
begin
  -- Nothing waiting on a batch → do no work (no vault read, no HTTP).
  if not exists (
    select 1 from public.uploads
    where status = 'queued_batch' and kind = 'inventory_pdf' and anthropic_batch_id is not null
  ) then
    return 0;
  end if;

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'goldline_read_page_url' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'goldline_pump_secret' limit 1;
  if v_url is null or v_secret is null then
    return 0; -- not wired yet; nothing to do
  end if;
  -- The batch-poll route lives beside read-page on the same host.
  v_url := replace(v_url, '/read-page', '/batch-poll');

  perform net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-goldline-pump-secret', v_secret),
    timeout_milliseconds := 300000
  );
  return 1;
end;
$$;

-- 3 ── Schedule it every 30s (same cadence as the pump). Unschedule first so re-running is safe.
select cron.unschedule('goldline-batch-poll')
where exists (select 1 from cron.job where jobname = 'goldline-batch-poll');

select cron.schedule('goldline-batch-poll', '30 seconds', 'select public.goldline_poll_batches();');
