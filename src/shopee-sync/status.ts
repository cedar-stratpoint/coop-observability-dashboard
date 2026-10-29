// What the Overview card shows, built from the rows. Pure: no clock, no database.
import {missingClosedDays} from './missing-days';
import {cloudLogin, sameEmail} from './routing';
import {isOnline, staleSweep} from './rules';
import {syncGate} from './service';
import {isActive, type DayResult, type Heartbeat, type Job, type JobStatus, type LoginState} from './types';

/** The server is Asleep (idle, wakes for a job), Online (seen within 2 minutes), or Offline (a job waited for it and it did not come). */
export type CloudState = 'asleep' | 'online' | 'offline';
/** A queued job that has waited this long with no worker seen means the server did not wake. */
export const WAKE_GRACE_MS = 10 * 60_000;
export interface LoginView {
  state: LoginState | 'unknown';
  checkedAt: string | null;
  ageSeconds: number | null;
  /** A Ready check older than 24 hours: shown as unknown, so Sync waits for a fresh one. */
  stale: boolean;
}
export interface SyncJobView {
  id: string;
  requestedBy: string;
  mine: boolean;
  days: string[];
  status: JobStatus;
  error: string | null;
  progress: Record<string, DayResult>;
  createdAt: string;
  finishedAt: string | null;
  /** When it paused for an admin to sign in (drives the 60-minute expiry text). */
  awaitingSince: string | null;
}
export interface ShopeeSyncStatus {
  signedInAs: string;
  isAdmin: boolean;
  /** True when the archive database is not configured: nothing is stored and every action is refused. */
  mock: boolean;
  /** The cloud worker, or null when it has never sent a heartbeat. */
  worker: {state: CloudState; lastSeen: string | null} | null;
  /** The last known Shopee login of the cloud worker, kept while the server sleeps. */
  login: LoginView;
  /** The cloud worker was seen within 2 minutes. */
  workerOnline: boolean;
  /** The cloud worker's remote browser is up. */
  remoteReady: boolean;
  /** Admin only: the protected remote browser address (null for everyone else, and when not set). */
  remoteUrl: string | null;
  /** The queued or in-flight sync (one team-wide), if any. */
  currentJob: SyncJobView | null;
  /** The newest finished sync (done, failed, review or expired). */
  lastJob: SyncJobView | null;
  missingDays: string[];
  /** Missing closed days beyond the 31 one job can carry. */
  moreMissing: number;
  canSync: {ok: true; days: number} | {ok: false; reason: string};
}

export interface StatusInput {
  viewer: {email: string; isAdmin: boolean};
  now: Date;
  heartbeat: Heartbeat | null;
  /** SHOPEE_SYNC_REMOTE_URL, already checked; only an admin is given it. */
  remoteUrl: string | null;
  jobs: readonly Job[];
  loadedDays: readonly string[];
}

export function buildSyncStatus(i: StatusInput): ShopeeSyncStatus {
  const me = i.viewer.email.trim().toLowerCase();
  // a job nobody picked up, or whose worker went quiet, is shown as the sweep will end it
  const swept = new Map(staleSweep(i.now, i.jobs).map((s) => [s.id, s]));
  const jobs: Job[] = i.jobs.map((j) => {
    const s = swept.get(j.id);
    return s ? {...j, status: s.to, error: s.error, finishedAt: j.finishedAt ?? i.now.toISOString()} : j;
  });
  const view = (j: Job): SyncJobView => ({id: j.id, requestedBy: j.requestedBy, mine: sameEmail(j.requestedBy, me), days: j.days, status: j.status, error: j.error, progress: j.progress, createdAt: j.createdAt, finishedAt: j.finishedAt, awaitingSince: j.awaitingSince});
  const sorted = [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const current = sorted.find((j) => j.status === 'queued' || isActive(j.status));
  const last = sorted.find((j) => j.status !== 'queued' && !isActive(j.status));
  const gate = syncGate({now: i.now, jobs, heartbeat: i.heartbeat, loadedDays: i.loadedDays});
  const cl = cloudLogin(i.heartbeat, i.now);
  const online = isOnline(i.heartbeat?.lastSeen ?? null, i.now);
  const waited = jobs.some((j) => (j.status === 'queued' && i.now.getTime() - Date.parse(j.createdAt) > WAKE_GRACE_MS) || (j.status === 'expired' && j.error === 'worker offline' && i.now.getTime() - Date.parse(j.finishedAt ?? j.createdAt) < 3_600_000));
  const missing = missingClosedDays(i.loadedDays, i.now);
  return {
    signedInAs: me,
    isAdmin: i.viewer.isAdmin,
    mock: false,
    worker: i.heartbeat ? {state: online ? 'online' : waited ? 'offline' : 'asleep', lastSeen: i.heartbeat.lastSeen} : null,
    login: {state: cl.state, checkedAt: cl.checkedAt, ageSeconds: cl.checkedAt ? Math.max(0, Math.floor((i.now.getTime() - Date.parse(cl.checkedAt)) / 1000)) : null, stale: cl.stale},
    workerOnline: online,
    remoteReady: i.heartbeat?.remoteReady ?? false,
    remoteUrl: i.viewer.isAdmin ? i.remoteUrl : null,
    currentJob: current ? view(current) : null,
    lastJob: last ? view(last) : null,
    missingDays: missing.days,
    moreMissing: missing.more,
    canSync: gate.ok ? {ok: true, days: gate.days.length} : {ok: false, reason: gate.error},
  };
}
