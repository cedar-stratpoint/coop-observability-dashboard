-- shopee_sync.sql: OWNED BY zoomy-observability-dashboard (Shopee same-day sync, src/shopee-sync/).
-- Applied BY HAND in the archive project's SQL editor (local Docker first, then staging; PROD with the co-worker's OK). Idempotent and additive.
-- Service role only: RLS on, no policies, all privileges revoked from anon and authenticated.
-- Plan: knowledge/tasks/2026-10-26-shopee-same-day-sync-plan.md (SYN-02, SYN-04, SYN-05) and
--       knowledge/tasks/2026-10-29-shopee-sync-dashboard-cloud-realign-plan.md (one cloud worker, one shared secret).
--
-- There is exactly ONE worker, the cloud box, authenticated by one shared secret in env (SHOPEE_SYNC_WORKER_TOKEN), so the database holds no worker
-- identity and no secret: just one heartbeat row and the jobs. There is deliberately NO column for a Shopee password, code or session: an admin
-- types it in the worker's own Chrome through the remote browser.

-- The cloud worker's heartbeat: ONE row, keyed by a constant id. Every claim and progress call updates it; the card and the wake decision read it.
-- The login state survives the server sleeping, so the card can show "Signed in, checked 2 hours ago" while the box is off.
create table if not exists public.shopee_sync_worker (
  id                smallint primary key default 1 check (id = 1),
  last_seen         timestamptz,                         -- every poll; "online" means within 2 minutes
  login_state       text check (login_state is null or login_state in ('ready', 'needs_password', 'signed_out')),
  login_checked_at  timestamptz,
  remote_ready      boolean not null default false       -- the worker's remote browser (noVNC) is up
);

create table if not exists public.shopee_sync_jobs (
  id              uuid primary key default gen_random_uuid(),
  requested_by    text not null,
  days            date[] not null check (cardinality(days) between 1 and 31),
  status          text not null default 'queued' check (status in ('queued', 'running', 'awaiting_verification', 'importing', 'done', 'failed', 'review', 'expired')),
  claimed_at      timestamptz,
  heartbeat_at    timestamptz,
  import_ids      uuid[] not null default '{}',          -- link only: import_runs stays the ledger and the only writer of daily facts
  error           text,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz,
  progress        jsonb not null default '{}'::jsonb,    -- per-day results: { "2026-10-25": { "state": "loaded", "importId": "..." } }
  awaiting_since  timestamptz                            -- when the job last paused for an admin to sign in: the 60-minute expiry counts from here
);
create index if not exists shopee_sync_jobs_created_idx on public.shopee_sync_jobs (created_at desc);
-- One sync in flight for the whole team (one Shopee account): the database refuses a second claim, however the race falls.
create unique index if not exists shopee_sync_jobs_one_active_uq on public.shopee_sync_jobs ((true)) where status in ('running', 'awaiting_verification', 'importing');
-- One queued job at a time as well, so two people pressing together cannot both queue.
create unique index if not exists shopee_sync_jobs_one_queued_uq on public.shopee_sync_jobs ((true)) where status = 'queued';

alter table public.shopee_sync_worker enable row level security;
alter table public.shopee_sync_jobs enable row level security;
revoke all on public.shopee_sync_worker, public.shopee_sync_jobs from anon, authenticated;

-- The claim: queued -> running for one job, atomic. Two polls racing for the same job: exactly one row comes back (and the unique index above
-- refuses a second in-flight sync). Checked inside the statement: the worker's last login is Ready.
create or replace function public.claim_shopee_sync_job(p_job uuid)
returns setof public.shopee_sync_jobs
language sql
security definer
set search_path = public
as $$
  update public.shopee_sync_jobs j
     set status = 'running', claimed_at = now(), heartbeat_at = now()
   where j.id = p_job
     and j.status = 'queued'
     and exists (select 1 from public.shopee_sync_worker w where w.id = 1 and w.login_state = 'ready')
  returning j.*;
$$;
revoke all on function public.claim_shopee_sync_job(uuid) from public, anon, authenticated;
grant execute on function public.claim_shopee_sync_job(uuid) to service_role;
