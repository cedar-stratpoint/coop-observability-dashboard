// The rules of the sync as plain functions over SyncStore: press Sync, cancel, enrol a Mac, revoke a Mac, and the stale-job sweep.
// The server actions (src/shopee-sync-actions.ts) and the worker routes (api.ts) are thin shells around these; authentication is theirs.
import {periodWithin, syncStamp} from '../shopee-import/api';
import {applyRun, type ImportStore} from '../shopee-import/pipeline';
import type {SyncStore} from './store';
import {missingClosedDays} from './missing-days';
import {canAddWorker, cloudLogin, isCloudWorker, sameEmail} from './routing';
import {normaliseRemoteUrl} from './remote';
import {startBlock, staleSweep} from './rules';
import {ENROL_TTL_MS, hashSecret, newEnrolmentCode} from './tokens';
import {isActive, type Job, type Worker} from './types';

export interface SyncDeps {
  store: SyncStore;
  now: () => Date;
  /** Days that have figures in the archive (the same list the import coverage uses). */
  loadLoadedDays: () => Promise<string[]>;
  /** SHOPEE_SYNC_ADMINS, lower-cased. A worker enrolled by one of them is the shared cloud worker. */
  admins?: readonly string[];
  /** SHOPEE_SYNC_REMOTE_HOSTS, lower-cased. Empty or unset: any https host. */
  remoteHosts?: readonly string[];
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
export const FIRST_CHECK = 'Waiting for the first login check';

export function syncGate(i: {who: string; now: Date; jobs: readonly Job[]; workers: readonly Worker[]; loadedDays: readonly string[]}): {ok: true; days: string[]; more: number} | Fail {
  const {days, more} = missingClosedDays(i.loadedDays, i.now);
  if (days.length === 0) return fail('Shopee is up to date');
  // Sync needs the last known Shopee login to be ready (the cloud worker's checker, which survives the server sleeping), or one of the person's own ready Macs.
  const login = cloudLogin(i.workers);
  const ownReady = i.workers.some((w) => !w.revokedAt && w.sessionState === 'ready' && sameEmail(w.ownerEmail, i.who));
  if (login.state !== 'ready' && !ownReady) {
    if (login.state === 'needs_password' || login.state === 'signed_out') return fail(NEEDS_ADMIN);
    if (login.hasCloud) return fail(FIRST_CHECK);
    return fail('Add a Mac or wake yours: none of your Macs is signed in to Seller Centre.');
  }
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

const NAME_MAX = 60;
export type EnrolVariant = 'mac' | 'cloud';
/** The one command a person runs. `cloud` is for the shared server: no published port (the admin reaches its browser through the protected remote link) and a worker image tag to fill in. */
export const dockerCommand = (code: string, variant: EnrolVariant = 'mac'): string =>
  variant === 'cloud'
    ? `docker run -d --name zoomy-shopee-sync --restart unless-stopped --shm-size=1g -v zoomy-shopee-sync:/data -e COOP_URL=<DASHBOARD_ADDRESS> -e ENROL_CODE=${code} <WORKER_IMAGE_TAG>`
    : `docker run -d --name zoomy-shopee-sync --restart unless-stopped --shm-size=1g -p 127.0.0.1:6080:6080 -v zoomy-shopee-sync:/data -e COOP_URL=<DASHBOARD_ADDRESS> -e ENROL_CODE=${code} <WORKER_IMAGE>`;

/** Makes a one-time enrolment code for one of the person's own Macs. The code is shown once and stored only as a hash. */
export async function beginEnrolment(d: SyncDeps, email: string, name: string, variant: EnrolVariant = 'mac'): Promise<{ok: true; code: string; command: string; expiresAt: string} | Fail> {
  const who = email.trim().toLowerCase();
  const clean = (name ?? '').replace(/\s+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (!clean || clean.length > NAME_MAX || /[\u0000-\u001f]/.test(clean)) return fail(`Give the Mac a name of 1 to ${NAME_MAX} characters.`);
  // The cloud worker is the one enrolled by an admin (SHOPEE_SYNC_ADMINS): that is what makes it serve everyone.
  if (variant === 'cloud' && !(d.admins ?? []).some((a) => sameEmail(a, who))) return fail('Only an admin can add the cloud worker.');
  const capped = canAddWorker(await d.store.listWorkers(), who);
  if (capped) return fail(capped);
  const code = newEnrolmentCode();
  const expiresAt = new Date(d.now().getTime() + ENROL_TTL_MS).toISOString();
  await d.store.createEnrolment({codeHash: hashSecret(code), ownerEmail: who, workerName: clean, expiresAt, usedAt: null, isCloud: variant === 'cloud'});
  return {ok: true, code, command: dockerCommand(code, variant), expiresAt};
}

export async function revokeWorkerFor(d: SyncDeps, who: Actor, workerId: string): Promise<{ok: true} | Fail> {
  const worker = (await d.store.listWorkers()).find((w) => w.id === workerId && !w.revokedAt);
  if (!worker) return fail('That Mac is not enrolled.');
  if (!who.isAdmin && !sameEmail(worker.ownerEmail, who.email)) return fail('You can only remove your own Macs.');
  if (!(await d.store.revokeWorker(workerId, d.now()))) return fail('That Mac is not enrolled.');
  // its token is dead, so nothing would ever finish or time out its job faster than the heartbeat sweep: end it now
  for (const j of await d.store.recentJobs(RECENT_JOBS)) {
    if (j.claimedBy === workerId && isActive(j.status)) await d.store.transitionJob(j.id, [j.status], {status: 'failed', error: 'The Mac was removed during the sync', finishedAt: d.now().toISOString()});
  }
  return {ok: true};
}

/** An admin sets or clears the address of the cloud worker's protected remote browser. Only the cloud worker has one; the address is never shown to anyone else. */
export async function setRemoteUrlFor(d: SyncDeps, who: Actor, workerId: string, raw: string): Promise<{ok: true} | Fail> {
  // The SHOPEE_SYNC_ADMINS list decides, not the Coop Admin role: this link is where a listed admin types the Shopee password.
  if (!(d.admins ?? []).some((a) => sameEmail(a, who.email))) return fail('Only an admin can set the remote browser address.');
  const parsed = normaliseRemoteUrl(String(raw ?? ''), d.remoteHosts ?? []);
  if (!parsed.ok) return fail(parsed.error);
  const worker = (await d.store.listWorkers()).find((w) => w.id === workerId && !w.revokedAt);
  if (!worker || !isCloudWorker(worker)) return fail('That is not the cloud worker.');
  return (await d.store.setRemoteUrl(workerId, parsed.url)) ? {ok: true} : fail('That worker is not enrolled.');
}
