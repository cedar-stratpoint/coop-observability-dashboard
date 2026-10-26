// The Supabase side of SyncStore. Service role, server side only (RLS on, no policies; see supabase/shopee_sync.sql).
// Token and code columns are only ever compared and stored as hashes; nothing here reads or writes a Shopee password.
import type {SupabaseClient} from '@supabase/supabase-js';
import type {JobPatch, SyncStore} from './store';
import type {DayResult, Enrolment, Job, JobStatus, SessionState, Worker} from './types';

type WorkerRow = {id: string; owner_email: string; name: string; token_hash: string; last_seen: string | null; session_state: SessionState; created_at: string; revoked_at: string | null};
type JobRow = {id: string; requested_by: string; days: string[]; status: JobStatus; claimed_by: string | null; claimed_at: string | null; heartbeat_at: string | null; import_ids: string[] | null; error: string | null; created_at: string; finished_at: string | null; progress: Record<string, DayResult> | null};

const WORKER_COLS = 'id,owner_email,name,token_hash,last_seen,session_state,created_at,revoked_at';
const JOB_COLS = 'id,requested_by,days,status,claimed_by,claimed_at,heartbeat_at,import_ids,error,created_at,finished_at,progress';
const toWorker = (r: WorkerRow): Worker => ({id: r.id, ownerEmail: r.owner_email, name: r.name, tokenHash: r.token_hash, lastSeen: r.last_seen, sessionState: r.session_state, createdAt: r.created_at, revokedAt: r.revoked_at});
const toJob = (r: JobRow): Job => ({id: r.id, requestedBy: r.requested_by, days: r.days, status: r.status, claimedBy: r.claimed_by, claimedAt: r.claimed_at, heartbeatAt: r.heartbeat_at, importIds: r.import_ids ?? [], error: r.error, createdAt: r.created_at, finishedAt: r.finished_at, progress: r.progress ?? {}});
const UNIQUE_VIOLATION = '23505';

function fail(what: string, error: {message: string} | null): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

export function supabaseSyncStore(sb: SupabaseClient): SyncStore {
  return {
    async listWorkers() {
      const {data, error} = await sb.from('shopee_sync_workers').select(WORKER_COLS).order('created_at').limit(200); // pagination-ok: capped at 3 live workers
      fail('reading the workers', error);
      return (data as WorkerRow[] | null)?.map(toWorker) ?? [];
    },
    async findWorkerByTokenHash(tokenHash) {
      const {data, error} = await sb.from('shopee_sync_workers').select(WORKER_COLS).eq('token_hash', tokenHash).limit(1);
      fail('reading the worker', error);
      return data?.[0] ? toWorker(data[0] as WorkerRow) : null;
    },
    async createWorker(w, now) {
      const {data, error} = await sb.from('shopee_sync_workers').insert({owner_email: w.ownerEmail, name: w.name, token_hash: w.tokenHash, created_at: now.toISOString()}).select(WORKER_COLS).single();
      fail('adding the worker', error);
      return toWorker(data as WorkerRow);
    },
    async touchWorker(id, sessionState, now) {
      const {error} = await sb.from('shopee_sync_workers').update({last_seen: now.toISOString(), session_state: sessionState}).eq('id', id); // pagination-ok: one primary key
      fail('recording the poll', error);
    },
    async revokeWorker(id, now) {
      const {data, error} = await sb.from('shopee_sync_workers').update({revoked_at: now.toISOString()}).eq('id', id).is('revoked_at', null).select('id'); // pagination-ok: one primary key
      fail('revoking the worker', error);
      return (data ?? []).length === 1;
    },
    async createEnrolment(e) {
      const {error} = await sb.from('shopee_sync_enrolments').insert({code_hash: e.codeHash, owner_email: e.ownerEmail, worker_name: e.workerName, expires_at: e.expiresAt});
      fail('making the enrolment code', error);
    },
    async redeemEnrolment(codeHash, tokenHash, now, caps) {
      // One SQL function (supabase/shopee_sync.sql): consume the code, check both caps and add the worker in a single transaction.
      const {data, error} = await sb.rpc('redeem_shopee_sync_enrolment', {p_code_hash: codeHash, p_token_hash: tokenHash, p_now: now.toISOString(), p_per_person: caps.perPerson, p_per_team: caps.perTeam});
      fail('redeeming the enrolment code', error);
      const row = (Array.isArray(data) ? data[0] : data) as ({outcome: 'ok' | 'capped' | 'invalid'; owner_email: string | null} & Partial<WorkerRow>) | undefined;
      if (!row || row.outcome === 'invalid') return {status: 'invalid'};
      if (row.outcome === 'capped') return {status: 'capped', ownerEmail: row.owner_email ?? ''};
      return {status: 'ok', worker: toWorker(row as unknown as WorkerRow)};
    },
    async recentJobs(limit) {
      const {data, error} = await sb.from('shopee_sync_jobs').select(JOB_COLS).order('created_at', {ascending: false}).limit(limit); // pagination-ok: a bounded recent window
      fail('reading the sync jobs', error);
      return (data as JobRow[] | null)?.map(toJob) ?? [];
    },
    async getJob(id) {
      const {data, error} = await sb.from('shopee_sync_jobs').select(JOB_COLS).eq('id', id).limit(1);
      fail('reading the sync job', error);
      return data?.[0] ? toJob(data[0] as JobRow) : null;
    },
    async createJob(j, now) {
      const {data, error} = await sb.from('shopee_sync_jobs').insert({requested_by: j.requestedBy, days: j.days, created_at: now.toISOString()}).select(JOB_COLS).single();
      if (error?.code === UNIQUE_VIOLATION) return 'conflict'; // a sync is already queued (unique index)
      fail('creating the sync job', error);
      return toJob(data as JobRow);
    },
    async claimJob(jobId, workerId) {
      // One SQL statement (supabase/shopee_sync.sql): queued -> running, and only for a ready, non-revoked worker owned by the presser.
      const {data, error} = await sb.rpc('claim_shopee_sync_job', {p_job: jobId, p_worker: workerId});
      if (error?.code === UNIQUE_VIOLATION) return null; // another sync is already in flight (unique index)
      fail('claiming the sync job', error);
      const row = (Array.isArray(data) ? data[0] : data) as JobRow | undefined;
      return row ? toJob(row) : null;
    },
    async transitionJob(id, from, patch: JobPatch) {
      const change: Record<string, unknown> = {};
      if (patch.status !== undefined) change.status = patch.status;
      if (patch.error !== undefined) change.error = patch.error;
      if (patch.importIds !== undefined) change.import_ids = patch.importIds;
      if (patch.progress !== undefined) change.progress = patch.progress;
      if (patch.heartbeatAt !== undefined) change.heartbeat_at = patch.heartbeatAt;
      if (patch.finishedAt !== undefined) change.finished_at = patch.finishedAt;
      const {data, error} = await sb.from('shopee_sync_jobs').update(change).eq('id', id).in('status', [...from]).select(JOB_COLS); // pagination-ok: one primary key
      if (error?.code === UNIQUE_VIOLATION) return null;
      fail('changing the sync job', error);
      return data?.[0] ? toJob(data[0] as JobRow) : null;
    },
  };
}
