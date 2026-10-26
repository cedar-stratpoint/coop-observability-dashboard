-- shopee_sync.sql: OWNED BY zoomy-observability-dashboard (Shopee same-day sync, src/shopee-sync/).
-- Applied BY HAND in the archive project's SQL editor (local Docker first, then staging; PROD with the co-worker's OK). Idempotent.
-- Service role only: RLS on, no policies, all privileges revoked from anon and authenticated.
-- Plan: knowledge/tasks/2026-10-26-shopee-same-day-sync-plan.md (SYN-02, SYN-08).
--
-- There is deliberately NO column for a Shopee password, code or session: the person types it in the Shopee tab on the worker Mac.
-- Secret columns use the name parts token_hash / code_hash so Ask Coop's guard hides them.

create table if not exists public.shopee_sync_workers (
  id             uuid primary key default gen_random_uuid(),
  owner_email    text not null,                          -- who enrolled this Mac; only they can sync on it
  name           text not null,
  token_hash     text not null unique,                   -- sha256 of the worker's token (the token is shown once, never stored)
  last_seen      timestamptz,                            -- every poll
  session_state  text not null default 'signed_out' check (session_state in ('signed_out', 'ready', 'expired')),
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz
);
create index if not exists shopee_sync_workers_owner_idx on public.shopee_sync_workers (owner_email) where revoked_at is null;

create table if not exists public.shopee_sync_enrolments (
  code_hash    text primary key,                         -- sha256 of the one-time code
  owner_email  text not null,
  worker_name  text not null,
  expires_at   timestamptz not null,                     -- 15 minutes after it was made
  used_at      timestamptz                               -- single use
);

create table if not exists public.shopee_sync_jobs (
  id            uuid primary key default gen_random_uuid(),
  requested_by  text not null,
  days          date[] not null check (cardinality(days) between 1 and 31),
  status        text not null default 'queued' check (status in ('queued', 'running', 'awaiting_verification', 'importing', 'done', 'failed', 'review', 'expired')),
  claimed_by    uuid references public.shopee_sync_workers (id),
  claimed_at    timestamptz,
  heartbeat_at  timestamptz,
  import_ids    uuid[] not null default '{}',            -- link only: import_runs stays the ledger and the only writer of daily facts
  error         text,
  created_at    timestamptz not null default now(),
  finished_at   timestamptz,
  progress      jsonb not null default '{}'::jsonb       -- per-day results: { "2026-10-25": { "state": "loaded", "importId": "..." } }
);
create index if not exists shopee_sync_jobs_created_idx on public.shopee_sync_jobs (created_at desc);
-- One sync in flight for the whole team (one Shopee account): the database refuses a second claim, however the race falls.
create unique index if not exists shopee_sync_jobs_one_active_uq on public.shopee_sync_jobs ((true)) where status in ('running', 'awaiting_verification', 'importing');
-- One queued job at a time as well, so two people pressing together cannot both queue.
create unique index if not exists shopee_sync_jobs_one_queued_uq on public.shopee_sync_jobs ((true)) where status = 'queued';

alter table public.shopee_sync_workers enable row level security;
alter table public.shopee_sync_enrolments enable row level security;
alter table public.shopee_sync_jobs enable row level security;
revoke all on public.shopee_sync_workers, public.shopee_sync_enrolments, public.shopee_sync_jobs from anon, authenticated;

-- The claim: queued -> running for one job, atomic. Two workers racing for the same job: exactly one row comes back.
-- The service-role client may also do the same compare-and-set as a plain UPDATE (src/shopee-sync/store-supabase.ts); this function is the
-- single statement for it and also checks, inside the statement, that the worker is ready, not revoked and owned by the presser.
create or replace function public.claim_shopee_sync_job(p_job uuid, p_worker uuid)
returns setof public.shopee_sync_jobs
language sql
security definer
set search_path = public
as $$
  update public.shopee_sync_jobs j
     set status = 'running', claimed_by = p_worker, claimed_at = now(), heartbeat_at = now()
   where j.id = p_job
     and j.status = 'queued'
     and exists (select 1 from public.shopee_sync_workers w
                  where w.id = p_worker and w.revoked_at is null and w.session_state = 'ready' and lower(w.owner_email) = lower(j.requested_by))
  returning j.*;
$$;
revoke all on function public.claim_shopee_sync_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_shopee_sync_job(uuid, uuid) to service_role;
