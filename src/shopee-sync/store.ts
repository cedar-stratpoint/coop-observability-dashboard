// Everything the sync touches in the database goes through SyncStore, so the rules are tested without one (see test/support/shopee-sync-fake-store.ts).
// The Supabase side is store-supabase.ts. Job changes are compare-and-set, the pattern of ImportStore.transition in src/shopee-import/pipeline.ts.
import type {DayResult, Heartbeat, Job, JobStatus, WorkerReport} from './types';

export interface JobPatch {
  status?: JobStatus;
  error?: string | null;
  importIds?: string[];
  progress?: Record<string, DayResult>;
  heartbeatAt?: string;
  finishedAt?: string | null;
  awaitingSince?: string | null;
}

export interface SyncStore {
  /** The cloud worker's heartbeat row, or null when it has never connected. */
  getHeartbeat(): Promise<Heartbeat | null>;
  /** A claim or progress call: records last_seen and what the worker reports (Shopee login, remote browser). Fields it leaves out are kept. Returns the row as it now stands. */
  touchHeartbeat(report: WorkerReport, now: Date): Promise<Heartbeat>;

  /** Newest first. Enough history for the daily cap (6) and the cooldown. */
  recentJobs(limit: number): Promise<Job[]>;
  getJob(id: string): Promise<Job | null>;
  /** 'conflict' when the database refuses a second queued sync. */
  createJob(j: {requestedBy: string; days: string[]}, now: Date): Promise<Job | 'conflict'>;
  /** queued -> running, atomically; null if it is no longer queued, another sync is in flight, or the worker's last login is not Ready. */
  claimJob(jobId: string, now: Date): Promise<Job | null>;
  /** Apply `patch` only if the job's status is one of `from`. Null when it was not (someone else changed it first). */
  transitionJob(id: string, from: readonly JobStatus[], patch: JobPatch): Promise<Job | null>;
}
