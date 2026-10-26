// Everything the sync touches in the database goes through SyncStore, so the rules are tested without one (see test/support/shopee-sync-fake-store.ts).
// The Supabase side is store-supabase.ts. Job changes are compare-and-set, the pattern of ImportStore.transition in src/shopee-import/pipeline.ts.
import type {DayResult, Enrolment, Job, JobStatus, SessionState, Worker} from './types';

export interface JobPatch {
  status?: JobStatus;
  error?: string | null;
  importIds?: string[];
  progress?: Record<string, DayResult>;
  heartbeatAt?: string;
  finishedAt?: string | null;
}

export interface SyncStore {
  /** Every worker, revoked ones included (the caps and the screens filter). */
  listWorkers(): Promise<Worker[]>;
  findWorkerByTokenHash(tokenHash: string): Promise<Worker | null>;
  createWorker(w: {ownerEmail: string; name: string; tokenHash: string}, now: Date): Promise<Worker>;
  /** A poll: records last_seen and the session state the worker reports. */
  touchWorker(id: string, sessionState: SessionState, now: Date): Promise<void>;
  /** False when it was already revoked or does not exist. */
  revokeWorker(id: string, now: Date): Promise<boolean>;

  createEnrolment(e: Enrolment): Promise<void>;
  /** Marks the code used and returns it, only if it exists, is unused and is unexpired, in one atomic step. Otherwise null. */
  consumeEnrolment(codeHash: string, now: Date): Promise<Enrolment | null>;

  /** Newest first. Enough history for the daily cap (6) and the cooldown. */
  recentJobs(limit: number): Promise<Job[]>;
  getJob(id: string): Promise<Job | null>;
  /** 'conflict' when the database refuses a second queued sync. */
  createJob(j: {requestedBy: string; days: string[]}, now: Date): Promise<Job | 'conflict'>;
  /** queued -> running for this worker, atomically; null if another worker got it, it is no longer queued, or another sync is in flight. */
  claimJob(jobId: string, workerId: string, now: Date): Promise<Job | null>;
  /** Apply `patch` only if the job's status is one of `from`. Null when it was not (someone else changed it first). */
  transitionJob(id: string, from: readonly JobStatus[], patch: JobPatch): Promise<Job | null>;
}
