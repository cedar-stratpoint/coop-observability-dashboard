// What the Overview card and the Settings screen show, built from the rows. Pure: no clock, no database.
import {missingClosedDays} from './missing-days';
import {sameEmail, canAddWorker} from './routing';
import {isOnline, staleSweep} from './rules';
import {syncGate} from './service';
import {isActive, type DayResult, type Job, type JobStatus, type SessionState, type Worker} from './types';

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
}
export interface ShopeeSyncStatus {
  signedInAs: string;
  isAdmin: boolean;
  /** True when the archive database is not configured: nothing is stored and every action is refused. */
  mock: boolean;
  workers: SyncWorkerView[];
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
}

export function buildSyncStatus(i: StatusInput): ShopeeSyncStatus {
  const me = i.viewer.email.trim().toLowerCase();
  // a job nobody picked up, or whose worker went quiet, is shown as the sweep will end it
  const swept = new Map(staleSweep(i.now, i.jobs).map((s) => [s.id, s]));
  const jobs: Job[] = i.jobs.map((j) => {
    const s = swept.get(j.id);
    return s ? {...j, status: s.to, error: s.error, finishedAt: j.finishedAt ?? i.now.toISOString()} : j;
  });
  const workerName = (id: string | null) => i.workers.find((w) => w.id === id)?.name ?? null;
  const view = (j: Job): SyncJobView => ({id: j.id, requestedBy: j.requestedBy, mine: sameEmail(j.requestedBy, me), days: j.days, status: j.status, error: j.error, progress: j.progress, createdAt: j.createdAt, finishedAt: j.finishedAt, workerName: workerName(j.claimedBy)});
  const sorted = [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const current = sorted.find((j) => j.status === 'queued' || isActive(j.status));
  const last = sorted.find((j) => j.status !== 'queued' && !isActive(j.status));
  const live = i.workers.filter((w) => !w.revokedAt);
  const gate = syncGate({who: me, now: i.now, jobs, workers: i.workers, loadedDays: i.loadedDays});
  const missing = missingClosedDays(i.loadedDays, i.now);
  const cap = canAddWorker(i.workers, me);
  return {
    signedInAs: me,
    isAdmin: i.viewer.isAdmin,
    mock: false,
    workers: live
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
