// What the Overview sync card says and offers, as pure functions of the status. No React, no clock of its own (callers pass `now`).
// The card is a thin view over this. Nothing here asks for, or has room for, a Shopee password: an admin types it in the worker's own browser through the remote browser link.
import type {JobStatus} from './types';
import type {ShopeeSyncStatus, SyncJobView} from './status';
import {AWAITING_EXPIRY_MS} from './rules';

const DAY_MS = 86_400_000;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "12 seconds ago", "3 hours ago", "never". */
export function agoText(iso: string | null, now: Date): string {
  if (!iso) return 'never';
  const s = Math.floor((now.getTime() - Date.parse(iso)) / 1000);
  if (Number.isNaN(s)) return 'never';
  if (s < 0) return 'just now';
  if (s < 60) return `${plural(s, 'second')} ago`;
  if (s < 3600) return `${plural(Math.floor(s / 60), 'minute')} ago`;
  if (s < 86_400) return `${plural(Math.floor(s / 3600), 'hour')} ago`;
  return `${plural(Math.floor(s / 86_400), 'day')} ago`;
}

const dayLabel = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.toLocaleDateString('en-GB', {weekday: 'short', timeZone: 'UTC'})} ${d.getUTCDate()} ${d.toLocaleDateString('en-GB', {month: 'short', timeZone: 'UTC'})}`;
};

/** "Mon 19 Oct to Sun 25 Oct, 7 days"; says "with gaps" when the days are not one run. */
export function rangeText(days: readonly string[]): string {
  if (days.length === 0) return '';
  const sorted = [...days].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = Math.round((Date.parse(last) - Date.parse(first)) / DAY_MS) + 1;
  const count = plural(sorted.length, 'day') + (span === sorted.length ? '' : ' with gaps');
  return first === last ? `${dayLabel(first)}, ${count}` : `${dayLabel(first)} to ${dayLabel(last)}, ${count}`;
}

/** The cloud worker's last known login needs an admin to sign in to Shopee. */
export const needsSignIn = (s: ShopeeSyncStatus): boolean => s.login.state === 'needs_password' || s.login.state === 'signed_out';

/** The card (and its Sync button) is always there once the status is real: Sync is how anyone gets the latest data, behind or not. */
export const cardVisible = (s: ShopeeSyncStatus | null, _now?: Date): boolean => Boolean(s && !s.mock);
/** The small "Behind" tag on the Shopee chip. */
export const behindTag = (s: ShopeeSyncStatus | null): boolean => Boolean(s && !s.mock && s.missingDays.length > 0);

export function syncButton(s: ShopeeSyncStatus): {label: string; disabled: boolean; reason: string | null} {
  if (s.canSync.ok) return {label: s.canSync.refresh ? 'Sync latest data' : `Sync ${plural(s.canSync.days, 'missing day')}`, disabled: false, reason: null};
  const other = s.currentJob && !s.currentJob.mine;
  return {label: 'Sync Shopee', disabled: true, reason: other ? 'Waiting for another sync to finish.' : s.canSync.reason};
}

/** Shown in place of the login and server lines when the cloud worker has never sent a heartbeat: an admin gets the pointer, everyone else a plain note. */
export const noWorkerText = (s: ShopeeSyncStatus): string =>
  s.isAdmin ? 'The cloud worker has not connected yet. Set SHOPEE_SYNC_WORKER_TOKEN here and on the worker (see docs/shopee-sync-runbook.md).' : 'Sync is not set up yet.';

export type JobAction = 'cancel' | 'retry' | 'confirm';
export type Tone = 'neutral' | 'info' | 'warn' | 'good' | 'crit';
export interface StatusMeta {
  status: JobStatus;
  label: string;
  tone: Tone;
  title: string;
  body: string;
  actions: JobAction[];
}

const sentence = (t: string): string => (/[.!?]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);
const loadedDays = (j: SyncJobView): string[] => j.days.filter((d) => j.progress[d]?.state === 'loaded').sort();

/** `workerOnline`: the worker was seen in the last 2 minutes (a queued job then is being picked up, not waiting for the server to wake). */
export function statusMeta(j: SyncJobView, who: {isAdmin: boolean; workerOnline?: boolean} = {isAdmin: false}): StatusMeta {
  const total = j.days.length;
  const done = loadedDays(j).length;
  const m = (label: string, tone: Tone, title: string, body: string, actions: JobAction[]): StatusMeta => ({status: j.status, label, tone, title, body, actions: j.mine || who.isAdmin ? actions : []});
  switch (j.status) {
    case 'queued':
      if (who.workerOnline === false) return m('Waking the server', 'info', 'Waking the server', 'About 1 to 4 minutes. The server was asleep, so it is being started. A sync nobody picks up ends after 30 minutes.', ['cancel']);
      return m('Queued', 'neutral', 'Sync requested', `Waiting for ${plural(total, 'day')} to be picked up by the worker. A sync nobody picks up ends after 30 minutes.`, ['cancel']);
    case 'running':
      return m('Running', 'info', 'Exporting from Shopee', `The worker is in Seller Centre: ${done} of ${plural(total, 'day')} done. This can take a few minutes, one day a minute at most.`, ['cancel']);
    case 'awaiting_verification': {
      const minutes = Math.round(AWAITING_EXPIRY_MS / 60_000);
      return who.isAdmin
        ? m('Needs your sign-in', 'warn', 'Shopee needs your sign-in', `Open the remote browser and type the Shopee password in the worker's Chrome, not in Coop. The sync continues by itself. It expires after about ${minutes} minutes.`, ['cancel'])
        : m('Waiting for an admin', 'warn', 'Waiting for an admin', `Shopee asked for the password. Please ask an admin. The sync resumes by itself after an admin signs in, and expires after about ${minutes} minutes.`, ['cancel']);
    }
    case 'importing':
      return m('Importing', 'info', 'Importing orders', `${done} of ${plural(total, 'day')} received. Checking dates and totals before anything is saved.`, ['cancel']);
    case 'done': {
      const last = loadedDays(j).pop() ?? [...j.days].sort().pop() ?? '';
      return m('Done', 'good', `Loaded through ${dayLabel(last)}`, `${plural(done || total, 'day')} loaded, provisional until each day settles. The Monday import can refresh them.`, []);
    }
    case 'failed':
      return m('Failed', 'crit', 'Sync failed', `${sentence(j.error ?? 'The worker reported a failure')} Days already loaded are kept; Retry loads the rest.`, ['retry']);
    case 'review':
      return m('Review', 'warn', 'Needs your review', 'The totals differ from what is loaded by more than the sync allows on its own. Nothing is applied until you confirm.', ['confirm']);
    case 'expired':
      if (j.error === 'worker offline') return m('Server did not wake', 'crit', 'The server did not wake', 'Nothing picked the sync up in time. Nothing was changed, and the Monday import is unaffected. Try again.', ['retry']);
      return m('Expired', 'neutral', 'Sync expired', `${sentence(j.error ?? 'Nobody picked it up in time')} Nothing was loaded.`, ['retry']);
  }
}

export const POLL_MS = 3000;
/** Poll only while a sync is current (queued or in flight); an idle card never polls. */
export const pollInterval = (s: ShopeeSyncStatus | null): number | null => (s && !s.mock && s.currentJob ? POLL_MS : null);

export interface Step {
  label: string;
  state: 'done' | 'now' | 'todo' | 'bad';
}
export interface ProgressBar {
  /** 0 to 1, or null when the worker has not reported a finished day yet (the bar then just shows it is alive). */
  value: number | null;
  label: string;
}
/** The bar above the steps: days the worker has finished (any outcome) out of the days in the job. Null when a bar would mean nothing (failed, expired, no days). */
export function progressBar(j: SyncJobView): ProgressBar | null {
  const total = j.days.length;
  if (total === 0 || j.status === 'failed' || j.status === 'expired') return null;
  if (j.status === 'done') return {value: 1, label: `${plural(total, 'day')} loaded`};
  const settled = j.days.filter((d) => j.progress[d]).length;
  if (j.status === 'queued') return {value: null, label: 'Waiting for the worker'};
  if (settled === 0) return {value: null, label: `0 of ${plural(total, 'day')}`};
  return {value: settled / total, label: `${settled} of ${plural(total, 'day')}`};
}

/** The little progress list under the status: Requested, Exporting, (Admin signs in), Importing, Done. */
export function stepsFor(j: SyncJobView): Step[] {
  const verify = j.status === 'awaiting_verification';
  const names = ['Requested', 'Exporting from Shopee', ...(verify ? ['Admin signs in'] : []), 'Importing orders', 'Done'];
  const imp = names.indexOf('Importing orders');
  const exp = 1;
  const failedAt = Object.keys(j.progress).length > 0 ? imp : exp;
  const at: Record<JobStatus, number> = {queued: 0, running: exp, awaiting_verification: 2, importing: imp, review: imp, done: names.length, failed: failedAt, expired: 0};
  const cur = at[j.status];
  return names.map((label, i) => ({label, state: j.status === 'failed' && i === cur ? 'bad' : i < cur ? 'done' : i === cur ? 'now' : 'todo'}));
}

export interface LoginLine {
  state: ShopeeSyncStatus['login']['state'];
  label: string;
  tone: Tone;
  text: string;
}
/** The Shopee login as the card shows it: the last known state and how old that check is. It is kept while the server sleeps. */
export function loginLine(s: ShopeeSyncStatus, now: Date): LoginLine {
  const age = agoText(s.login.checkedAt, now);
  switch (s.login.state) {
    case 'ready':
      return {state: 'ready', label: 'Ready', tone: 'good', text: `Signed in, checked ${age}`};
    case 'needs_password':
      return {state: 'needs_password', label: 'Needs password', tone: 'warn', text: `Last known: needs the password, checked ${age}`};
    case 'signed_out':
      return {state: 'signed_out', label: 'Signed out', tone: 'crit', text: `Last known: signed out, checked ${age}`};
    default:
      if (s.login.stale) return {state: 'unknown', label: 'Check is old', tone: 'neutral', text: `Last check was ${age}`};
      return {state: 'unknown', label: 'Not checked', tone: 'neutral', text: 'No check has run yet'};
  }
}

/** The cloud server: asleep (a Sync wakes it), waking (a job is queued and nobody is awake), online, or offline (it did not wake). Null when the worker has never connected. */
export function serverLine(s: ShopeeSyncStatus, now: Date): {kind: 'online' | 'asleep' | 'waking' | 'offline'; text: string} | null {
  const w = s.worker;
  if (!w) return null;
  const seen = w.lastSeen ? `last seen ${agoText(w.lastSeen, now)}` : 'never seen yet';
  if (s.workerOnline) return {kind: 'online', text: `Server online, ${seen}.`};
  if (w.state === 'offline') return {kind: 'offline', text: `The server did not wake, ${seen}. Please ask an admin.`};
  if (s.currentJob?.status === 'queued') return {kind: 'waking', text: 'Waking the server, about 1 to 4 minutes.'};
  // Sync wakes it only when the login is Ready; otherwise Sync is off and promising a wake would contradict the button.
  return {kind: 'asleep', text: s.login.state === 'ready' ? `Server asleep. Sync will wake it, about 1 to 4 minutes (${seen}).` : `Server asleep, ${seen}.`};
}
