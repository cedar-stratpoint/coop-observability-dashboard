// The rules of the sync as plain functions over SyncStore: press Sync, cancel, enrol a Mac, revoke a Mac, and the stale-job sweep.
// The server actions (src/shopee-sync-actions.ts) and the worker routes (api.ts) are thin shells around these; authentication is theirs.
import type {SyncStore} from './store';
import {missingClosedDays} from './missing-days';
import {canAddWorker, sameEmail} from './routing';
import {startBlock, staleSweep} from './rules';
import {ENROL_TTL_MS, hashSecret, newEnrolmentCode} from './tokens';
import {isActive, type Job, type Worker} from './types';

export interface SyncDeps {
  store: SyncStore;
  now: () => Date;
  /** Days that have figures in the archive (the same list the import coverage uses). */
  loadLoadedDays: () => Promise<string[]>;
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
export function syncGate(i: {who: string; now: Date; jobs: readonly Job[]; workers: readonly Worker[]; loadedDays: readonly string[]}): {ok: true; days: string[]; more: number} | Fail {
  const {days, more} = missingClosedDays(i.loadedDays, i.now);
  if (days.length === 0) return fail('Shopee is up to date');
  if (!i.workers.some((w) => !w.revokedAt && w.sessionState === 'ready' && sameEmail(w.ownerEmail, i.who))) return fail('Add a Mac or wake yours: none of your Macs is signed in to Seller Centre.');
  const blocked = startBlock(i.now, i.jobs);
  return blocked ? fail(blocked) : {ok: true, days, more};
}

export async function requestSync(d: SyncDeps, email: string): Promise<{ok: true; job: Job} | Fail> {
  const who = email.trim().toLowerCase();
  const now = d.now();
  const jobs = await sweepJobs(d.store, now);
  const gate = syncGate({who, now, jobs, workers: await d.store.listWorkers(), loadedDays: await d.loadLoadedDays()});
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

const NAME_MAX = 60;
export const dockerCommand = (code: string): string =>
  `docker run -d --name zoomy-shopee-sync --restart unless-stopped -p 6080:6080 -v zoomy-shopee-sync:/data -e COOP_URL=<DASHBOARD_ADDRESS> -e ENROL_CODE=${code} <WORKER_IMAGE>`;

/** Makes a one-time enrolment code for one of the person's own Macs. The code is shown once and stored only as a hash. */
export async function beginEnrolment(d: SyncDeps, email: string, name: string): Promise<{ok: true; code: string; command: string; expiresAt: string} | Fail> {
  const who = email.trim().toLowerCase();
  const clean = (name ?? '').replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (!clean || clean.length > NAME_MAX || /[\u0000-\u001f]/.test(clean)) return fail(`Give the Mac a name of 1 to ${NAME_MAX} characters.`);
  const capped = canAddWorker(await d.store.listWorkers(), who);
  if (capped) return fail(capped);
  const code = newEnrolmentCode();
  const expiresAt = new Date(d.now().getTime() + ENROL_TTL_MS).toISOString();
  await d.store.createEnrolment({codeHash: hashSecret(code), ownerEmail: who, workerName: clean, expiresAt, usedAt: null});
  return {ok: true, code, command: dockerCommand(code), expiresAt};
}

export async function revokeWorkerFor(d: SyncDeps, who: Actor, workerId: string): Promise<{ok: true} | Fail> {
  const worker = (await d.store.listWorkers()).find((w) => w.id === workerId && !w.revokedAt);
  if (!worker) return fail('That Mac is not enrolled.');
  if (!who.isAdmin && !sameEmail(worker.ownerEmail, who.email)) return fail('You can only remove your own Macs.');
  return (await d.store.revokeWorker(workerId, d.now())) ? {ok: true} : fail('That Mac is not enrolled.');
}
