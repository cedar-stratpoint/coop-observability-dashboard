// The rules of the sync as plain functions over SyncStore: press Sync, cancel, confirm a review, and the stale-job sweep.
// The server actions (src/shopee-sync-actions.ts) and the worker routes (api.ts) are thin shells around these; authentication is theirs.
import {periodWithin, syncStamp} from '../shopee-import/api';
import {applyRun, type ImportStore} from '../shopee-import/pipeline';
import type {SyncStore} from './store';
import {missingClosedDays} from './missing-days';
import {cloudLogin, sameEmail} from './routing';
import {startBlock, staleSweep} from './rules';
import {isActive, type Heartbeat, type Job} from './types';

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
export const FIRST_CHECK = 'Waiting for the first login check';
export const FRESH_CHECK = 'Waiting for a fresh login check';

export function syncGate(i: {now: Date; jobs: readonly Job[]; heartbeat: Heartbeat | null; loadedDays: readonly string[]}): {ok: true; days: string[]; more: number} | Fail {
  const {days, more} = missingClosedDays(i.loadedDays, i.now);
  if (days.length === 0) return fail('Shopee is up to date');
  // Sync needs the last known Shopee login to be ready (the cloud worker's checker, which survives the server sleeping).
  const login = cloudLogin(i.heartbeat, i.now);
  if (login.state !== 'ready') {
    if (login.state === 'needs_password' || login.state === 'signed_out') return fail(NEEDS_ADMIN);
    if (login.hasWorker) return fail(login.stale ? FRESH_CHECK : FIRST_CHECK);
    return fail(NO_WORKER);
  }
  const blocked = startBlock(i.now, i.jobs);
  return blocked ? fail(blocked) : {ok: true, days, more};
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
  // Check every run before applying any: a run only counts if this job planned it, as a plain sales_overview inside the job's days.
  const days = new Set(job.days);
  const toApply: string[] = [];
  for (const id of job.importIds) {
    const run = await imports.getRun(id);
    if (run?.status === 'accepted') continue; // already applied
    if (!run || run.status !== 'staged') return fail('One of the imports was replaced or removed since this sync ran. Run Sync again.');
    if (run.reportType !== 'sales_overview' || run.restated || run.importedBy !== syncStamp(jobId) || !periodWithin(run.periodFrom, run.periodTo, days)) return fail('One of the imports does not belong to this sync, so nothing was applied. Run Sync again.');
    toApply.push(id);
  }
  for (const id of toApply) {
    const r = await applyRun(imports, id);
    if (!r.ok) return fail(r.message);
  }
  const ended = await d.store.transitionJob(jobId, ['review'], {status: 'done', error: null});
  return ended ? {ok: true} : fail('That sync changed while you were confirming it. Refresh and try again.');
}
