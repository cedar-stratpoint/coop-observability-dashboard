// The rules of the sync as plain functions over SyncStore: press Sync, cancel, confirm a review, and the stale-job sweep.
// The server actions (src/shopee-sync-actions.ts) and the worker routes (api.ts) are thin shells around these; authentication is theirs.
import {periodIsWindow, syncStamp} from '../shopee-import/api';
import {applyRun, type ImportStore} from '../shopee-import/pipeline';
import type {SyncStore} from './store';
import {latestClosedDay, missingClosedDays, oldestReachable} from './missing-days';
import {cloudLogin, sameEmail} from './routing';
import {startBlock, staleSweep} from './rules';
import {isActive, type DayResult, type Heartbeat, type Job} from './types';
import {issuedWindows, windowPlan} from './windows';

export interface SyncDeps {
  store: SyncStore;
  now: () => Date;
  /** Days that have figures in the archive (the same list the import coverage uses). */
  loadLoadedDays: () => Promise<string[]>;
  /** SHOPEE_SYNC_REMOTE_URL, already checked (https, SHOPEE_SYNC_REMOTE_HOSTS). The card hands it to a Coop Admin only. */
  remoteUrl?: string | null;
}
export type Fail = {ok: false; error: string};
export interface Actor {
  email: string;
  isAdmin: boolean;
}
const fail = (error: string): Fail => ({ok: false, error});
export const RECENT_JOBS = 50;

/** Fail in-flight jobs that lost their worker and expire queued ones nobody claimed; returns the jobs as they now stand, newest first. */
export async function sweepJobs(store: SyncStore, now: Date): Promise<Job[]> {
  const jobs = await store.recentJobs(RECENT_JOBS);
  const swept = staleSweep(now, jobs);
  if (swept.length === 0) return jobs;
  for (const s of swept) await store.transitionJob(s.id, [s.from], {status: s.to, error: s.error, finishedAt: now.toISOString()});
  return store.recentJobs(RECENT_JOBS);
}

/** Whether `who` may press Sync now: the days it would load, or the plain reason it may not. Pure; the card and the action both use it. */
export const NEEDS_ADMIN = 'Shopee needs an admin to sign in. Please ask an admin.';
export const NO_WORKER = 'The cloud worker has not connected yet.';

export function syncGate(i: {now: Date; jobs: readonly Job[]; heartbeat: Heartbeat | null; loadedDays: readonly string[]}): {ok: true; days: string[]; more: number; refresh: boolean} | Fail {
  const missing = missingClosedDays(i.loadedDays, i.now);
  // Nothing missing is not a reason to refuse: the press still runs the whole process on the latest closed day, and the import decides whether it changed.
  const refresh = missing.days.length === 0;
  // The job holds only what its windows cover (MAX_WEEK_WINDOWS and MAX_DAY_WINDOWS): newer days that do not fit wait for the next press and are counted in `more`.
  const plan = windowPlan(refresh ? [latestClosedDay(i.now)] : missing.days, i.now);
  const days = (refresh ? [latestClosedDay(i.now)] : missing.days).filter((d) => !plan.dropped.includes(d));
  const more = missing.more + plan.dropped.length;
  // A known-bad login needs an admin. An old or never-taken check does NOT block: the box may be asleep, so the press must be able to wake it,
  // and the worker re-checks the login itself when it claims the job (pausing for a sign-in if it is not ready).
  const login = cloudLogin(i.heartbeat, i.now);
  if (login.state === 'needs_password' || login.state === 'signed_out') return fail(NEEDS_ADMIN);
  if (!login.hasWorker) return fail(NO_WORKER);
  const blocked = startBlock(i.now, i.jobs);
  return blocked ? fail(blocked) : {ok: true, days, more, refresh};
}

/**
 * The job's days that are still missing: not loaded, and still within reach (a day that has aged past REACHABLE_DAYS while the job ran is left for the Monday import).
 * A sync is Done only when this is empty. Oldest first.
 */
export function remainingDays(job: Pick<Job, 'days'>, loadedDays: readonly string[], now: Date): string[] {
  const have = new Set(loadedDays);
  const oldest = oldestReachable(now);
  return [...job.days].sort().filter((d) => !have.has(d) && d >= oldest);
}

const SHOWN_DAYS = 10;
/** "Still missing: 2026-10-20, 2026-10-21" (long lists are cut), plus the non-sales files that failed, named by window and type. */
export function stillMissingMessage(days: readonly string[], progress: Record<string, DayResult>): string {
  const failedFiles = Object.entries(progress).filter(([k, v]) => k.includes('/') && v.state === 'failed').map(([k]) => k);
  const list = days.length > SHOWN_DAYS ? `${days.slice(0, SHOWN_DAYS).join(', ')} and ${days.length - SHOWN_DAYS} more` : days.join(', ');
  return `Still missing: ${list}.${failedFiles.length ? ` Failed files: ${failedFiles.join(', ')}.` : ''}`;
}

/** Marks every job day that now has figures in the archive as loaded, so the card counts it. Never downgrades; days without figures are left as they are. */
export async function markLoadedProgress(store: SyncStore, jobId: string, loadedDays: readonly string[]): Promise<void> {
  const job = await store.getJob(jobId);
  if (!job) return;
  const have = new Set(loadedDays);
  const progress = {...job.progress};
  let changed = false;
  for (const d of job.days) {
    if (have.has(d) && progress[d]?.state !== 'loaded') {
      progress[d] = {...progress[d], state: 'loaded'};
      changed = true;
    }
  }
  if (changed) await store.transitionJob(job.id, [job.status], {progress});
}

export async function requestSync(d: SyncDeps, email: string): Promise<{ok: true; job: Job} | Fail> {
  const who = email.trim().toLowerCase();
  const now = d.now();
  const jobs = await sweepJobs(d.store, now);
  const gate = syncGate({now, jobs, heartbeat: await d.store.getHeartbeat(), loadedDays: await d.loadLoadedDays()});
  if (!gate.ok) return gate;
  const job = await d.store.createJob({requestedBy: who, days: gate.days}, now);
  return job === 'conflict' ? fail('A Shopee sync is already queued or running. Wait for it to finish.') : {ok: true, job};
}

/** The requester or an admin may stop a queued or running sync. It ends as failed with the reason, and the worker is told on its next report. */
export async function cancelSync(d: SyncDeps, who: Actor, jobId: string): Promise<{ok: true} | Fail> {
  const job = await d.store.getJob(jobId);
  if (!job) return fail('That sync no longer exists.');
  if (!who.isAdmin && !sameEmail(job.requestedBy, who.email)) return fail('Only the person who started a sync can cancel it.');
  if (job.status !== 'queued' && !isActive(job.status)) return fail('That sync has already finished.');
  const done = await d.store.transitionJob(jobId, [job.status], {status: 'failed', error: `Cancelled by ${who.email.trim().toLowerCase()}`, finishedAt: d.now().toISOString()});
  return done ? {ok: true} : fail('That sync changed while you were cancelling it. Refresh and try again.');
}

/** The person confirms a job that ended in review: its staged imports are applied as they were planned (the same step as the import API's apply). */
export async function confirmReview(d: SyncDeps, imports: ImportStore, who: Actor, jobId: string): Promise<{ok: true} | Fail> {
  const job = await d.store.getJob(jobId);
  if (!job) return fail('That sync no longer exists.');
  if (!who.isAdmin && !sameEmail(job.requestedBy, who.email)) return fail('Only the person who started a sync can confirm it.');
  if (job.status !== 'review') return fail('That sync is not waiting for review.');
  // Check every run before applying any: a run only counts if this job planned it, for a window issued to the job, of a type that window carries.
  const windows = issuedWindows(job.days, job.createdAt, d.now());
  const toApply: string[] = [];
  for (const id of job.importIds) {
    const run = await imports.getRun(id);
    if (run?.status === 'accepted') continue; // already applied
    if (!run || run.status !== 'staged') return fail('One of the imports was replaced or removed since this sync ran. Run Sync again.');
    if (run.restated || run.importedBy !== syncStamp(jobId) || !periodIsWindow(run.periodFrom, run.periodTo, windows, run.reportType)) return fail('One of the imports does not belong to this sync, so nothing was applied. Run Sync again.');
    toApply.push(id);
  }
  for (const id of toApply) {
    const r = await applyRun(imports, id);
    if (!r.ok) return fail(r.message);
  }
  // Done means no closed day of the job is missing: the same check as when the worker reports done. A day still missing ends the job as failed (Retry loads the rest).
  const now = d.now();
  const still = remainingDays(job, await d.loadLoadedDays(), now);
  if (still.length > 0) {
    const failed = await d.store.transitionJob(jobId, ['review'], {status: 'failed', error: stillMissingMessage(still, job.progress), finishedAt: now.toISOString()});
    return failed ? fail(`Applied, but some days are still missing: ${still.join(', ')}. Press Retry to load them.`) : fail('That sync changed while you were confirming it. Refresh and try again.');
  }
  const ended = await d.store.transitionJob(jobId, ['review'], {status: 'done', error: null});
  return ended ? {ok: true} : fail('That sync changed while you were confirming it. Refresh and try again.');
}
