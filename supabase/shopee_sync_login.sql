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
-- need not be owned by the person who pressed Sync. The app passes true only for a worker flagged is_cloud.
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

-- Which worker is THE cloud worker is stored, not guessed from the owner's email: an admin's own laptop must never become a shared worker or speak for
-- the box's Shopee login. The flag is set once, at enrolment, and only for the cloud variant made by a SHOPEE_SYNC_ADMINS member (the app checks that).
alter table public.shopee_sync_enrolments add column if not exists is_cloud boolean not null default false;
alter table public.shopee_sync_workers add column if not exists is_cloud boolean not null default false;

-- Redeem an enrolment code (as redeem_shopee_sync_enrolment in shopee_sync.sql) and carry the enrolment's is_cloud to the worker, in the same transaction.
create or replace function public.redeem_shopee_sync_enrolment_v2(p_code_hash text, p_token_hash text, p_now timestamptz, p_per_person int, p_per_team int)
returns table (outcome text, owner_email text, id uuid, name text, token_hash text, last_seen timestamptz, session_state text, created_at timestamptz, revoked_at timestamptz, is_cloud boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.shopee_sync_enrolments%rowtype;
  w public.shopee_sync_workers%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('shopee_sync_enrol'));
  select * into e from public.shopee_sync_enrolments x where x.code_hash = p_code_hash and x.used_at is null and x.expires_at > p_now for update;
  if not found then
    return query select 'invalid'::text, null::text, null::uuid, null::text, null::text, null::timestamptz, null::text, null::timestamptz, null::timestamptz, null::boolean;
    return;
  end if;
  if (select count(*) from public.shopee_sync_workers k where k.revoked_at is null) >= p_per_team
     or (select count(*) from public.shopee_sync_workers k where k.revoked_at is null and lower(k.owner_email) = lower(e.owner_email)) >= p_per_person then
    return query select 'capped'::text, e.owner_email, null::uuid, null::text, null::text, null::timestamptz, null::text, null::timestamptz, null::timestamptz, null::boolean;
    return;
  end if;
  update public.shopee_sync_enrolments set used_at = p_now where code_hash = p_code_hash;
  insert into public.shopee_sync_workers (owner_email, name, token_hash, created_at, is_cloud) values (e.owner_email, e.worker_name, p_token_hash, p_now, e.is_cloud) returning * into w;
  return query select 'ok'::text, w.owner_email, w.id, w.name, w.token_hash, w.last_seen, w.session_state, w.created_at, w.revoked_at, w.is_cloud;
end;
$$;
revoke all on function public.redeem_shopee_sync_enrolment_v2(text, text, timestamptz, int, int) from public, anon, authenticated;
grant execute on function public.redeem_shopee_sync_enrolment_v2(text, text, timestamptz, int, int) to service_role;
