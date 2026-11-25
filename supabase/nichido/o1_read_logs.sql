-- o1 · read_logs — observability for the scan-read pipeline.
--
-- One row per page the uploader reads (and per store-assign attempt), capturing the
-- inputs, the classifier/extract summary, timings, and the final outcome (incl. the real
-- error on a failure). Durable so a failed or mis-read page can be debugged after the
-- fact and the reader hardened. Written best-effort by the server (service role) — never
-- blocks an upload. Small (~1 KB/row of summary + a lean `detail` jsonb; the full
-- extraction rows live in `extractions`, not here). Additive, Staging first.

create table if not exists public.read_logs (
  id             uuid primary key default gen_random_uuid(),
  company_id     text not null references public.companies(id) on delete cascade,
  event          text not null default 'page_read',   -- page_read | assign_store | assign_ba
  -- keep the log after the upload itself is deleted, so a post-mortem survives cleanup
  upload_id      uuid references public.uploads(id) on delete set null,
  batch_id       uuid,
  source         text,                                 -- the scan drop this page came from
  filename       text,
  page           integer,
  file_size      bigint,
  stage          text,                                 -- last stage reached (classified | read | error)
  status         text,                                 -- needs_review | rejected | failed | committed | ok
  page_kind      text,                                 -- inventory | sales | blank | unknown
  form_version   text,                                 -- legacy | v1 | v2 | unknown
  orientation    integer,
  store_code     text,                                 -- snapped to the registry
  store_from     text,                                 -- raw code the classifier read
  row_count      integer,
  doc_confidence numeric,
  flagged        integer,
  off_manifest   integer,
  classify_ms    integer,
  read_ms        integer,
  error          text,
  detail         jsonb,                                -- raw classifier output, snap candidates, error context
  created_at     timestamptz not null default now()
);

create index if not exists read_logs_company_created_idx on public.read_logs (company_id, created_at desc);
create index if not exists read_logs_upload_idx on public.read_logs (upload_id);
create index if not exists read_logs_status_idx on public.read_logs (company_id, status);
create index if not exists read_logs_event_idx on public.read_logs (company_id, event);

-- Service-role only, like every other Nichido table (the server writes/reads with the
-- service key; anon/authenticated get nothing).
alter table public.read_logs enable row level security;
revoke all on public.read_logs from anon, authenticated;

-- Retention: logs are a debugging aid, not a permanent record. Purge old rows so the
-- table can't grow without bound.
create schema if not exists private;

create or replace function private.purge_read_logs(p_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from public.read_logs where created_at < now() - make_interval(days => greatest(1, p_days));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

revoke all on function private.purge_read_logs(integer) from anon, authenticated;

-- Self-schedule a nightly purge when pg_cron is available; a no-op otherwise.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('purge_read_logs', '17 3 * * *', 'select private.purge_read_logs(90)');
  end if;
exception when others then
  null; -- scheduling is optional; the function can also be called by hand
end $$;
