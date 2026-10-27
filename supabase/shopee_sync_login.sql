-- shopee_sync_login.sql: OWNED BY zoomy-observability-dashboard (Shopee same-day sync, the one cloud worker). ADDITIVE on top of shopee_sync.sql:
-- apply that first. Applied BY HAND in the archive project's SQL editor (LOCAL Docker first, then staging; PROD with the co-worker's OK). Idempotent.
-- Service role only: RLS stays on and there are still no policies (the tables were set up in shopee_sync.sql).
-- Plan: knowledge/tasks/2026-10-26-shopee-same-day-sync-plan.md (SYN-04, SYN-05, SYN-08).
--
-- Still NO column for a Shopee password, code or session: the login checker reports only a state, and an admin types the password in the
-- worker's own Chrome through the remote browser.

-- What the cloud worker's login checker last saw, reported on its polls. It survives the server sleeping, so the card can show "Signed in,
-- checked 2 hours ago" while the box is off.
alter table public.shopee_sync_workers add column if not exists login_state text;
alter table public.shopee_sync_workers drop constraint if exists shopee_sync_workers_login_state_check;
alter table public.shopee_sync_workers add constraint shopee_sync_workers_login_state_check check (login_state is null or login_state in ('ready', 'needs_password', 'signed_out'));
alter table public.shopee_sync_workers add column if not exists login_checked_at timestamptz;
alter table public.shopee_sync_workers add column if not exists remote_ready boolean not null default false;   -- the worker's remote browser (noVNC) is up
alter table public.shopee_sync_workers add column if not exists remote_url text;                                -- admin-set address of the protected remote browser

-- When a job last paused for a person to sign in: the 60-minute expiry counts from here (heartbeats keep coming while it waits).
alter table public.shopee_sync_jobs add column if not exists awaiting_since timestamptz;

-- The claim for the shared cloud worker: the same single atomic statement as claim_shopee_sync_job, except that when p_any_owner is true the worker
-- need not be owned by the person who pressed Sync. The app passes true only for a worker enrolled by a SHOPEE_SYNC_ADMINS email.
create or replace function public.claim_shopee_sync_job_shared(p_job uuid, p_worker uuid, p_any_owner boolean default false)
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
                  where w.id = p_worker and w.revoked_at is null and w.session_state = 'ready'
                    and (p_any_owner or lower(w.owner_email) = lower(j.requested_by)))
  returning j.*;
$$;
revoke all on function public.claim_shopee_sync_job_shared(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.claim_shopee_sync_job_shared(uuid, uuid, boolean) to service_role;
