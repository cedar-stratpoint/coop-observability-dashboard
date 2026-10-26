// Shared shapes of the Shopee same-day sync: workers (a Mac running the sync worker), one-time enrolments, and jobs.
// Nothing here carries a Shopee password or code: the person types it in the Shopee tab on the worker Mac (see the plan, SYN-05).
export const JOB_STATUSES = ['queued', 'running', 'awaiting_verification', 'importing', 'done', 'failed', 'review', 'expired'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
/** In flight on a worker: counts toward the one-sync-at-a-time rule and needs a heartbeat. */
export const ACTIVE_STATUSES = ['running', 'awaiting_verification', 'importing'] as const satisfies readonly JobStatus[];
export const isActive = (s: JobStatus): boolean => (ACTIVE_STATUSES as readonly string[]).includes(s);

export type SessionState = 'signed_out' | 'ready' | 'expired';
export const SESSION_STATES: readonly SessionState[] = ['signed_out', 'ready', 'expired'];

export interface Worker {
  id: string;
  ownerEmail: string;
  name: string;
  tokenHash: string;
  lastSeen: string | null;
  sessionState: SessionState;
  createdAt: string;
  revokedAt: string | null;
}
export interface Enrolment {
  codeHash: string;
  ownerEmail: string;
  workerName: string;
  expiresAt: string;
  usedAt: string | null;
}
/** What the worker reports for one day of a job. */
export type DayState = 'loaded' | 'review' | 'failed' | 'skipped';
export interface DayResult {
  state: DayState;
  importId?: string;
  note?: string;
}
export interface Job {
  id: string;
  requestedBy: string;
  days: string[];
  status: JobStatus;
  claimedBy: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  importIds: string[];
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  progress: Record<string, DayResult>;
}
