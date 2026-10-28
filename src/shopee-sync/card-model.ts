// What the Overview sync card says and offers, as pure functions of the status. No React, no clock of its own (callers pass `now`).
// The card is a thin view over this. Nothing here asks for, or has room for, a Shopee password: the person types it in the Shopee browser on their Mac.
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

/** The card shows only when Shopee is behind or a sync is current or finished within the last day. */
export function cardVisible(s: ShopeeSyncStatus | null, now: Date): boolean {
  if (!s || s.mock) return false;
  if (s.missingDays.length > 0 || s.currentJob) return true;
  if (s.isAdmin && needsSignIn(s)) return true; // an admin is told on the card even when nothing is behind
  const fin = s.lastJob?.finishedAt;
  return Boolean(fin && now.getTime() - Date.parse(fin) < DAY_MS);
}
/** The small "Behind" tag on the Shopee chip. */
export const behindTag = (s: ShopeeSyncStatus | null): boolean => Boolean(s && !s.mock && s.missingDays.length > 0);

/** Which Mac a sync is on: "your Mac" for yours, otherwise the Mac's name (the requester's email only while nobody has claimed the job). */
export const macOf = (j: SyncJobView): string => (j.mine ? (j.workerName ?? 'your Mac') : (j.workerName ?? `${j.requestedBy}'s Mac`));

/**
 * The status as seen from the viewed window: only the missing days inside [from, to] (YYYY-MM-DD) count, so an older week with no gaps shows no card.
 * `outsideWindow` is how many missing days the sync will also load that are not in this window.
 */
export function scopeToWindow(s: ShopeeSyncStatus, from: string, to: string): ShopeeSyncStatus & {outsideWindow: number};
export function scopeToWindow(s: ShopeeSyncStatus | null, from: string, to: string): (ShopeeSyncStatus & {outsideWindow: number}) | null;
export function scopeToWindow(s: ShopeeSyncStatus | null, from: string, to: string): (ShopeeSyncStatus & {outsideWindow: number}) | null {
  if (!s) return null;
  const inside = s.missingDays.filter((d) => d >= from && d <= to);
  const outside = s.missingDays.length - inside.length;
  return {...s, missingDays: inside, moreMissing: outside === 0 ? s.moreMissing : 0, outsideWindow: outside};
}

export function syncButton(s: ShopeeSyncStatus): {label: string; disabled: boolean; reason: string | null} {
  if (s.canSync.ok) return {label: `Sync ${plural(s.canSync.days, 'missing day')}`, disabled: false, reason: null};
  const other = s.currentJob && !s.currentJob.mine ? s.currentJob : null;
  return {label: 'Sync Shopee', disabled: true, reason: other ? `Waiting for ${macOf(other)} to finish its sync.` : s.canSync.reason};
}

export function workerLine(s: ShopeeSyncStatus, now: Date): {kind: 'online' | 'offline' | 'none'; text: string} {
  const own = s.workers.filter((w) => w.own);
  if (own.length === 0) return {kind: 'none', text: 'You have not added a Mac yet.'};
  const seen = (w: (typeof own)[number]) => (w.lastSeen ? Date.parse(w.lastSeen) : 0);
  const online = own.filter((w) => w.online).sort((a, b) => seen(b) - seen(a))[0];
  if (online) return {kind: 'online', text: `Your Mac ${online.name} is online, last seen ${agoText(online.lastSeen, now)}.`};
  const newest = [...own].sort((a, b) => seen(b) - seen(a))[0];
  return {kind: 'offline', text: `None of your Macs is online. Add a Mac or wake yours (${newest.name} was last seen ${agoText(newest.lastSeen, now)}).`};
}

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

/** `cloud`: the job runs on the shared cloud worker. `workerOnline`: some worker was seen in the last 2 minutes (a queued job then is being picked up, not waiting for the server to wake). */
export function statusMeta(j: SyncJobView, who: {isAdmin: boolean; workerOnline?: boolean} = {isAdmin: false}): StatusMeta {
  // Another person's Mac is not named to you: their sync is theirs to babysit.
  const mac = j.cloud ? (j.workerName ?? 'The worker') : macOf(j);
  const total = j.days.length;
  const done = loadedDays(j).length;
  const m = (label: string, tone: Tone, title: string, body: string, actions: JobAction[]): StatusMeta => ({status: j.status, label, tone, title, body, actions: j.mine || who.isAdmin ? actions : []});
  switch (j.status) {
    case 'queued':
      if (j.cloud && who.workerOnline === false) return m('Waking the server', 'info', 'Waking the server', 'About 1 to 4 minutes. The server was asleep, so it is being started. A sync nobody picks up ends after 30 minutes.', ['cancel']);
      if (j.cloud) return m('Queued', 'neutral', 'Sync requested', `Waiting for ${plural(total, 'day')} to be picked up by the worker. A sync nobody picks up ends after 30 minutes.`, ['cancel']);
      return m('Queued', 'neutral', 'Sync requested', `Waiting for ${plural(total, 'day')} to be picked up by your Mac. A sync nobody picks up ends after 30 minutes.`, ['cancel']);
    case 'running':
      return m('Running', 'info', 'Exporting from Shopee', `${mac} is in Seller Centre: ${done} of ${plural(total, 'day')} done. This can take a few minutes, one day a minute at most.`, ['cancel']);
    case 'awaiting_verification': {
      if (j.cloud) {
        const minutes = Math.round(AWAITING_EXPIRY_MS / 60_000);
        return who.isAdmin
          ? m('Needs your sign-in', 'warn', 'Shopee needs your sign-in', `Open the remote browser and type the Shopee password in the worker's Chrome, not in Coop. The sync continues by itself. It expires after about ${minutes} minutes.`, ['cancel'])
          : m('Waiting for an admin', 'warn', 'Waiting for an admin', `Shopee asked for the password. Please ask an admin. The sync resumes by itself after an admin signs in, and expires after about ${minutes} minutes.`, ['cancel']);
      }
      return m(j.mine ? 'Needs your password' : 'Waiting for a password', 'warn', j.mine ? 'Shopee needs you to verify' : `Waiting for ${mac} to verify`, j.mine ? `Open the Shopee browser on ${mac} and type the password there. The sync continues by itself. Coop never sees the password.` : `Someone has to type the Shopee password on ${mac}. Your sync can start after theirs.`, ['cancel']);
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
      if (j.cloud && j.error === 'worker offline') return m('Server did not wake', 'crit', 'The server did not wake', 'Nothing picked the sync up in time. Nothing was changed, and the Monday import is unaffected. Try again.', ['retry']);
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
/** The little progress list under the status: Requested, Exporting, (Verify on the Mac), Importing, Done. */
export function stepsFor(j: SyncJobView): Step[] {
  const verify = j.status === 'awaiting_verification';
  const names = ['Requested', 'Exporting from Shopee', ...(verify ? [j.cloud ? 'Admin signs in' : 'Verify on the Mac'] : []), 'Importing orders', 'Done'];
  const imp = names.indexOf('Importing orders');
  const exp = 1;
  const failedAt = Object.keys(j.progress).length > 0 ? imp : exp;
  const at: Record<JobStatus, number> = {queued: 0, running: exp, awaiting_verification: 2, importing: imp, review: imp, done: names.length, failed: failedAt, expired: 0};
  const cur = at[j.status];
  return names.map((label, i) => ({label, state: j.status === 'failed' && i === cur ? 'bad' : i < cur ? 'done' : i === cur ? 'now' : 'todo'}));
}

export interface MacStatus {
  key: 'online' | 'offline' | 'signin' | 'first';
  label: string;
  tone: Tone;
}
/** One Mac's state for the Settings list: online, offline, needs sign-in (Seller Centre), or waiting for its first sign-in. */
export function macStatus(w: {online: boolean; lastSeen: string | null; sessionState: 'signed_out' | 'ready' | 'expired'}): MacStatus {
  if (!w.lastSeen && w.sessionState === 'signed_out') return {key: 'first', label: 'Waiting for first sign-in', tone: 'neutral'};
  if (!w.online) return {key: 'offline', label: 'Offline', tone: 'neutral'};
  if (w.sessionState !== 'ready') return {key: 'signin', label: 'Needs sign-in', tone: 'warn'};
  return {key: 'online', label: 'Online', tone: 'good'};
}
export const SESSION_LABEL = {ready: 'Signed in to Seller Centre', signed_out: 'Not signed in', expired: 'Session expired'} as const;

/** The server leaves the dashboard address as a placeholder; the browser knows it. The worker image stays a placeholder until one is published. */
export const enrolCommand = (command: string, origin: string): string => command.replace('<DASHBOARD_ADDRESS>', origin);

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

/** The cloud server: asleep (a Sync wakes it), waking (a job is queued and nobody is awake), online, or offline (it did not wake). Null when there is no cloud worker. */
export function serverLine(s: ShopeeSyncStatus, now: Date): {kind: 'online' | 'asleep' | 'waking' | 'offline'; text: string} | null {
  const w = [...s.cloudWorkers].sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))[0];
  if (!w) return null;
  const seen = w.lastSeen ? `last seen ${agoText(w.lastSeen, now)}` : 'never seen yet';
  if (s.workerOnline) return {kind: 'online', text: `Server online, ${seen}.`};
  if (w.state === 'offline') return {kind: 'offline', text: `The server did not wake, ${seen}. Please ask an admin.`};
  if (s.currentJob?.status === 'queued') return {kind: 'waking', text: 'Waking the server, about 1 to 4 minutes.'};
  // Sync wakes it only when the login is Ready; otherwise Sync is off and promising a wake would contradict the button.
  return {kind: 'asleep', text: s.login.state === 'ready' ? `Server asleep. Sync will wake it, about 1 to 4 minutes (${seen}).` : `Server asleep, ${seen}.`};
}
