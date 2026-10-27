// Shared shapes of the Shopee same-day sync: workers (a Mac running the sync worker), one-time enrolments, and jobs.
// Nothing here carries a Shopee password or code: the person types it in the Shopee tab on the worker Mac (see the plan, SYN-05).
export const JOB_STATUSES = ['queued', 'running', 'awaiting_verification', 'importing', 'done', 'failed', 'review', 'expired'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
/** In flight on a worker: counts toward the one-sync-at-a-time rule and needs a heartbeat. */
export const ACTIVE_STATUSES = ['running', 'awaiting_verification', 'importing'] as const satisfies readonly JobStatus[];
export const isActive = (s: JobStatus): boolean => (ACTIVE_STATUSES as readonly string[]).includes(s);

export type SessionState = 'signed_out' | 'ready' | 'expired';
export const SESSION_STATES: readonly SessionState[] = ['signed_out', 'ready', 'expired'];

/** What the cloud worker's login checker last saw at Seller Centre. 'needs_password' and 'signed_out' both need an admin to sign in. */
export type LoginState = 'ready' | 'needs_password' | 'signed_out';
export const LOGIN_STATES: readonly LoginState[] = ['ready', 'needs_password', 'signed_out'];
/** A worker's report of its Shopee login, and whether its remote browser is up. Both optional in a poll: old workers send neither. */
export interface WorkerReport {
  sessionState?: SessionState;
  login?: {state: LoginState; checkedAt: string};
  remoteReady?: boolean;
}

export interface Worker {
  id: string;
  ownerEmail: string;
  name: string;
  tokenHash: string;
  lastSeen: string | null;
  sessionState: SessionState;
  createdAt: string;
  revokedAt: string | null;
  /** Last known Shopee login (null until the worker has reported one). Survives the server sleeping. */
  loginState: LoginState | null;
  loginCheckedAt: string | null;
  /** The worker's remote browser (noVNC) is up. */
  remoteReady: boolean;
  /** Admin-set address of the protected remote browser; never sent to a non-admin. */
  remoteUrl: string | null;
  /** The shared cloud worker, set once at enrolment by a SHOPEE_SYNC_ADMINS member. Only this flag makes a worker serve everyone and speak for the Shopee login. */
  isCloud: boolean;
}
export interface Enrolment {
  codeHash: string;
  ownerEmail: string;
  workerName: string;
  expiresAt: string;
  usedAt: string | null;
  /** The worker this code makes is the cloud worker. */
  isCloud: boolean;
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
  /** When the job last paused for a person to sign in to Shopee (null otherwise). Drives the 60-minute expiry. */
  awaitingSince: string | null;
}
