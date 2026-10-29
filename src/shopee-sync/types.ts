// Shared shapes of the Shopee same-day sync: the ONE cloud worker's heartbeat, and jobs.
// Nothing here carries a Shopee password or code: an admin types it in the worker's own Chrome through the remote browser (see the plan, SYN-05).
export const JOB_STATUSES = ['queued', 'running', 'awaiting_verification', 'importing', 'done', 'failed', 'review', 'expired'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
/** In flight on a worker: counts toward the one-sync-at-a-time rule and needs a heartbeat. */
export const ACTIVE_STATUSES = ['running', 'awaiting_verification', 'importing'] as const satisfies readonly JobStatus[];
export const isActive = (s: JobStatus): boolean => (ACTIVE_STATUSES as readonly string[]).includes(s);

/** What the cloud worker's login checker last saw at Seller Centre. 'needs_password' and 'signed_out' both need an admin to sign in. */
export type LoginState = 'ready' | 'needs_password' | 'signed_out';
export const LOGIN_STATES: readonly LoginState[] = ['ready', 'needs_password', 'signed_out'];
/** What the worker says about itself in a poll: its Shopee login, and whether its remote browser is up. Both optional. */
export interface WorkerReport {
  login?: {state: LoginState; checkedAt: string};
  remoteReady?: boolean;
}

/** The cloud worker's one heartbeat row: written by every claim and progress call, read by the card and the wake decision. */
export interface Heartbeat {
  lastSeen: string | null;
  /** Last known Shopee login (null until the worker has reported one). Survives the server sleeping. */
  loginState: LoginState | null;
  loginCheckedAt: string | null;
  /** The worker's remote browser (noVNC) is up. */
  remoteReady: boolean;
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
