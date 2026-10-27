// Everything the sync touches in the database goes through SyncStore, so the rules are tested without one (see test/support/shopee-sync-fake-store.ts).
// The Supabase side is store-supabase.ts. Job changes are compare-and-set, the pattern of ImportStore.transition in src/shopee-import/pipeline.ts.
import type {DayResult, Enrolment, Job, JobStatus, Worker, WorkerReport} from './types';

export interface JobPatch {
  status?: JobStatus;
  error?: string | null;
  importIds?: string[];
  progress?: Record<string, DayResult>;
  heartbeatAt?: string;
  finishedAt?: string | null;
  awaitingSince?: string | null;
}

export type RedeemResult = {status: 'ok'; worker: Worker} | {status: 'capped'; ownerEmail: string} | {status: 'invalid'};

export interface SyncStore {
  /** Every worker, revoked ones included (the caps and the screens filter). */
  listWorkers(): Promise<Worker[]>;
  findWorkerByTokenHash(tokenHash: string): Promise<Worker | null>;
  createWorker(w: {ownerEmail: string; name: string; tokenHash: string; isCloud?: boolean}, now: Date): Promise<Worker>;
  /** A poll: records last_seen and what the worker reports (session state, Shopee login check, remote browser). Fields it leaves out are kept. */
  touchWorker(id: string, report: WorkerReport, now: Date): Promise<void>;
  /** Admin sets or clears (null) the remote browser address. False when the worker is revoked or does not exist. */
  setRemoteUrl(id: string, url: string | null): Promise<boolean>;
  /** False when it was already revoked or does not exist. */
  revokeWorker(id: string, now: Date): Promise<boolean>;

  createEnrolment(e: Enrolment): Promise<void>;
  /**
   * Redeems a one-time code for a new worker in ONE atomic step: the code must exist, be unused and unexpired, AND the person and team caps must
   * leave room. A capped redemption does not spend the code (it works again once a Mac is removed). 'invalid' covers unknown, used and expired.
   */
  redeemEnrolment(codeHash: string, tokenHash: string, now: Date, caps: {perPerson: number; perTeam: number}): Promise<RedeemResult>;

  /** Newest first. Enough history for the daily cap (6) and the cooldown. */
  recentJobs(limit: number): Promise<Job[]>;
  getJob(id: string): Promise<Job | null>;
  /** 'conflict' when the database refuses a second queued sync. */
  createJob(j: {requestedBy: string; days: string[]}, now: Date): Promise<Job | 'conflict'>;
  /**
   * queued -> running for this worker, atomically; null if another worker got it, it is no longer queued, or another sync is in flight.
   * `anyOwner`: the worker is the shared cloud worker, so it may take a job whoever pressed Sync (otherwise only its owner's).
   */
  claimJob(jobId: string, workerId: string, now: Date, opts?: {anyOwner?: boolean}): Promise<Job | null>;
  /** Apply `patch` only if the job's status is one of `from`. Null when it was not (someone else changed it first). */
  transitionJob(id: string, from: readonly JobStatus[], patch: JobPatch): Promise<Job | null>;
}
