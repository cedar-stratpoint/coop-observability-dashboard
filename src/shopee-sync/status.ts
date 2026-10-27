// What the Overview card and the Settings screen show, built from the rows. Pure: no clock, no database.
import {missingClosedDays} from './missing-days';
import {canAddWorker, cloudLogin, isCloudWorker, sameEmail} from './routing';
import {isOnline, staleSweep} from './rules';
import {syncGate} from './service';
import {isActive, type DayResult, type Job, type JobStatus, type LoginState, type SessionState, type Worker} from './types';

export interface SyncWorkerView {
  id: string;
  name: string;
  ownerEmail: string;
  /** Enrolled by the viewer (an admin also sees other people's Macs, with own = false). */
  own: boolean;
  online: boolean;
  sessionState: SessionState;
  lastSeen: string | null;
  createdAt: string;
  /** When this Mac last started a sync. */
  lastSyncAt: string | null;
}
/** The server is Asleep (idle, wakes for a job), Online (seen within 2 minutes), or Offline (a job waited for it and it did not come). */
export type CloudState = 'asleep' | 'online' | 'offline';
/** A queued job that has waited this long with no worker seen means the server did not wake. */
export const WAKE_GRACE_MS = 10 * 60_000;
export interface CloudWorkerView {
  id: string;
  name: string;
  ownerEmail: string;
  state: CloudState;
  lastSeen: string | null;
  loginState: LoginState | null;
  loginCheckedAt: string | null;
  remoteReady: boolean;
  /** Only an admin gets the address; everyone else sees null. */
  remoteUrl: string | null;
}
export interface LoginView {
  state: LoginState | 'unknown';
  checkedAt: string | null;
  ageSeconds: number | null;
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
  workerName: string | null;
  /** When it paused for an admin to sign in (drives the 60-minute expiry text). */
  awaitingSince: string | null;
  /** Runs (or will run) on the shared cloud worker, so an admin signs in to Shopee; a Mac job is signed in by its owner on that Mac. */
  cloud: boolean;
}
export interface ShopeeSyncStatus {
  signedInAs: string;
  isAdmin: boolean;
  /** True when the archive database is not configured: nothing is stored and every action is refused. */
  mock: boolean;
  workers: SyncWorkerView[];
  /** The shared cloud worker(s), visible to everyone allowed; never tokens. */
  cloudWorkers: CloudWorkerView[];
  /** The last known Shopee login of the cloud worker, kept while the server sleeps. */
  login: LoginView;
  /** Any worker (cloud or Mac) was seen within 2 minutes. */
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
  canAddMac: {ok: true} | {ok: false; reason: string};
}

export interface StatusInput {
  viewer: {email: string; isAdmin: boolean};
  now: Date;
  workers: readonly Worker[];
  jobs: readonly Job[];
  loadedDays: readonly string[];
  /** SHOPEE_SYNC_ADMINS, lower-cased. */
  admins?: readonly string[];
}

export function buildSyncStatus(i: StatusInput): ShopeeSyncStatus {
  const me = i.viewer.email.trim().toLowerCase();
  // a job nobody picked up, or whose worker went quiet, is shown as the sweep will end it
  const swept = new Map(staleSweep(i.now, i.jobs).map((s) => [s.id, s]));
  const jobs: Job[] = i.jobs.map((j) => {
    const s = swept.get(j.id);
    return s ? {...j, status: s.to, error: s.error, finishedAt: j.finishedAt ?? i.now.toISOString()} : j;
  });
  const live = i.workers.filter((w) => !w.revokedAt);
  const cloud = live.filter((w) => isCloudWorker(w, i.admins ?? []));
  const workerName = (id: string | null) => i.workers.find((w) => w.id === id)?.name ?? null;
  const view = (j: Job): SyncJobView => ({id: j.id, requestedBy: j.requestedBy, mine: sameEmail(j.requestedBy, me), days: j.days, status: j.status, error: j.error, progress: j.progress, createdAt: j.createdAt, finishedAt: j.finishedAt, workerName: workerName(j.claimedBy), awaitingSince: j.awaitingSince, cloud: j.claimedBy ? cloud.some((w) => w.id === j.claimedBy) : cloud.length > 0});
  const sorted = [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const current = sorted.find((j) => j.status === 'queued' || isActive(j.status));
  const last = sorted.find((j) => j.status !== 'queued' && !isActive(j.status));
  const admins = i.admins ?? [];
  const gate = syncGate({who: me, now: i.now, jobs, workers: i.workers, loadedDays: i.loadedDays, admins});
  const cl = cloudLogin(i.workers, admins);
  const stateOf = (w: Worker): CloudState => {
    if (isOnline(w.lastSeen, i.now)) return 'online';
    const waited = jobs.some((j) => (j.status === 'queued' && i.now.getTime() - Date.parse(j.createdAt) > WAKE_GRACE_MS) || (j.status === 'expired' && j.error === 'worker offline' && i.now.getTime() - Date.parse(j.finishedAt ?? j.createdAt) < 3_600_000));
    return waited ? 'offline' : 'asleep';
  };
  const cloudViews: CloudWorkerView[] = cloud.map((w) => ({id: w.id, name: w.name, ownerEmail: w.ownerEmail, state: stateOf(w), lastSeen: w.lastSeen, loginState: w.loginState, loginCheckedAt: w.loginCheckedAt, remoteReady: w.remoteReady, remoteUrl: i.viewer.isAdmin ? w.remoteUrl : null}));
  const missing = missingClosedDays(i.loadedDays, i.now);
  const cap = canAddWorker(i.workers, me);
  return {
    signedInAs: me,
    isAdmin: i.viewer.isAdmin,
    mock: false,
    cloudWorkers: cloudViews,
    login: {state: cl.state, checkedAt: cl.checkedAt, ageSeconds: cl.checkedAt ? Math.max(0, Math.floor((i.now.getTime() - Date.parse(cl.checkedAt)) / 1000)) : null},
    workerOnline: live.some((w) => isOnline(w.lastSeen, i.now)),
    remoteReady: cloud.some((w) => w.remoteReady),
    remoteUrl: i.viewer.isAdmin ? (cloud.find((w) => w.remoteUrl)?.remoteUrl ?? null) : null,
    workers: live
      .filter((w) => !isCloudWorker(w, admins))
      .filter((w) => i.viewer.isAdmin || sameEmail(w.ownerEmail, me))
      .map((w) => ({id: w.id, name: w.name, ownerEmail: w.ownerEmail, own: sameEmail(w.ownerEmail, me), online: isOnline(w.lastSeen, i.now), sessionState: w.sessionState, lastSeen: w.lastSeen, createdAt: w.createdAt, lastSyncAt: sorted.find((j) => j.claimedBy === w.id)?.claimedAt ?? null})),
    currentJob: current ? view(current) : null,
    lastJob: last ? view(last) : null,
    missingDays: missing.days,
    moreMissing: missing.more,
    canSync: gate.ok ? {ok: true, days: gate.days.length} : {ok: false, reason: gate.error},
    canAddMac: cap ? {ok: false, reason: cap} : {ok: true},
  };
}
