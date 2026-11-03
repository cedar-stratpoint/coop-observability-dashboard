// The Supabase side of SyncStore. Service role, server side only (RLS on, no policies; see supabase/shopee_sync.sql).
// Nothing here reads or writes a Shopee password.
import type {SupabaseClient} from '@supabase/supabase-js';
import type {JobPatch, SyncStore} from './store';
import type {DayResult, Heartbeat, Job, JobStatus, LoginState} from './types';

type HeartbeatRow = {last_seen: string | null; login_state: LoginState | null; login_checked_at: string | null; remote_ready: boolean | null};
type JobRow = {id: string; requested_by: string; days: string[]; status: JobStatus; claimed_at: string | null; heartbeat_at: string | null; import_ids: string[] | null; error: string | null; created_at: string; finished_at: string | null; progress: Record<string, DayResult> | null; awaiting_since: string | null};

const HEARTBEAT_COLS = 'last_seen,login_state,login_checked_at,remote_ready';
const HEARTBEAT_ID = 1; // the one worker: a single row keyed by a constant
const JOB_COLS = 'id,requested_by,days,status,claimed_at,heartbeat_at,import_ids,error,created_at,finished_at,progress,awaiting_since';
const toHeartbeat = (r: HeartbeatRow): Heartbeat => ({lastSeen: r.last_seen, loginState: r.login_state ?? null, loginCheckedAt: r.login_checked_at ?? null, remoteReady: r.remote_ready ?? false});
const toJob = (r: JobRow): Job => ({id: r.id, requestedBy: r.requested_by, days: r.days, status: r.status, claimedAt: r.claimed_at, heartbeatAt: r.heartbeat_at, importIds: r.import_ids ?? [], error: r.error, createdAt: r.created_at, finishedAt: r.finished_at, progress: r.progress ?? {}, awaitingSince: r.awaiting_since ?? null});
const UNIQUE_VIOLATION = '23505';

function fail(what: string, error: {message: string} | null): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

export function supabaseSyncStore(sb: SupabaseClient): SyncStore {
  return {
    async getHeartbeat() {
      const {data, error} = await sb.from('shopee_sync_worker').select(HEARTBEAT_COLS).eq('id', HEARTBEAT_ID).limit(1);
      fail('reading the worker heartbeat', error);
      return data?.[0] ? toHeartbeat(data[0] as HeartbeatRow) : null;
    },
    async touchHeartbeat(r, now) {
      // an upsert on the constant id: columns the report leaves out are not in the payload, so they keep their values
      const row = {id: HEARTBEAT_ID, last_seen: now.toISOString(), ...(r.login && {login_state: r.login.state, login_checked_at: r.login.checkedAt}), ...(r.remoteReady !== undefined && {remote_ready: r.remoteReady})};
      const {data, error} = await sb.from('shopee_sync_worker').upsert(row, {onConflict: 'id'}).select(HEARTBEAT_COLS).single(); // pagination-ok: one primary key
      fail('recording the heartbeat', error);
      return toHeartbeat(data as HeartbeatRow);
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
    async claimJob(jobId) {
      // One SQL statement (claim_shopee_sync_job in supabase/shopee_sync.sql): queued -> running, only while the worker's last login is Ready.
      const {data, error} = await sb.rpc('claim_shopee_sync_job', {p_job: jobId});
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
      if (patch.awaitingSince !== undefined) change.awaiting_since = patch.awaitingSince;
      const {data, error} = await sb.from('shopee_sync_jobs').update(change).eq('id', id).in('status', [...from]).select(JOB_COLS); // pagination-ok: one primary key
      if (error?.code === UNIQUE_VIOLATION) return null;
      fail('changing the sync job', error);
      return data?.[0] ? toJob(data[0] as JobRow) : null;
    },
  };
}
