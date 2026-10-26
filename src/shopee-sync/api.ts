// The HTTP face of the sync for the WORKER: enrol (code for token), claim (a poll) and progress. Plain Request -> Response handlers like
// src/shopee-import/api.ts; the files in app/api/shopee/sync/ are thin wrappers. Auth is the worker's own bearer token (hash lookup,
// revocable per Mac). No field anywhere carries a Shopee password or code: unknown request fields are dropped, never stored.
import type {SyncStore} from './store';
import {canAddWorker, chooseJob} from './routing';
import {inQuietWindow} from './rules';
import {sweepJobs} from './service';
import {hashSecret, newWorkerToken, verifySecret} from './tokens';
import {isActive, SESSION_STATES, type DayResult, type DayState, type Job, type JobStatus, type SessionState, type Worker} from './types';

export interface SyncApiDeps {
  store: SyncStore;
  now: () => Date;
}

const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});
const readBody = async (req: Request): Promise<Record<string, unknown>> => {
  try {
    const v = await req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
export const bearerOf = (req: Request): string | null => /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1].trim() || null;

/** The enrolled, non-revoked worker behind a bearer token, or null. */
export async function workerForToken(store: SyncStore, token: string): Promise<Worker | null> {
  const w = await store.findWorkerByTokenHash(hashSecret(token));
  return w && !w.revokedAt && verifySecret(token, w.tokenHash) ? w : null;
}
async function authenticate(req: Request, d: SyncApiDeps): Promise<Worker | null> {
  const t = bearerOf(req);
  return t ? workerForToken(d.store, t) : null;
}
const denied = (): Response => reply({error: 'Unauthorized.'}, 401);

export async function handleEnrol(req: Request, d: SyncApiDeps): Promise<Response> {
  const b = await readBody(req);
  const code = typeof b.code === 'string' ? b.code.trim() : '';
  if (!code) return denied();
  const e = await d.store.consumeEnrolment(hashSecret(code), d.now());
  if (!e) return denied(); // unknown, used or expired: one answer for all three
  const capped = canAddWorker(await d.store.listWorkers(), e.ownerEmail);
  if (capped) return reply({error: capped}, 409);
  const token = newWorkerToken();
  const w = await d.store.createWorker({ownerEmail: e.ownerEmail, name: e.workerName, tokenHash: hashSecret(token)}, d.now());
  return reply({workerId: w.id, name: w.name, token}); // the token is shown this once
}

const asSession = (v: unknown): SessionState | null => (typeof v === 'string' && (SESSION_STATES as readonly string[]).includes(v) ? (v as SessionState) : null);
const toWire = (j: Job) => ({id: j.id, days: j.days, status: j.status});

export async function handleClaim(req: Request, d: SyncApiDeps): Promise<Response> {
  const worker = await authenticate(req, d);
  if (!worker) return denied();
  const now = d.now();
  const state = asSession((await readBody(req)).sessionState) ?? worker.sessionState;
  await d.store.touchWorker(worker.id, state, now);
  const jobs = await sweepJobs(d.store, now);
  const mine = jobs.find((j) => isActive(j.status) && j.claimedBy === worker.id);
  if (mine) {
    await d.store.transitionJob(mine.id, [mine.status], {heartbeatAt: now.toISOString()}); // a poll is also a heartbeat
    return reply({job: null, activeJobId: mine.id});
  }
  if (jobs.some((j) => isActive(j.status)) || inQuietWindow(now)) return reply({job: null});
  const pick = chooseJob({...worker, sessionState: state}, jobs.filter((j) => j.status === 'queued'));
  const claimed = pick ? await d.store.claimJob(pick.id, worker.id, now) : null;
  return reply({job: claimed ? toWire(claimed) : null});
}

// Where each status may be reached from. done, failed and review end the job.
const FROM: Record<string, readonly JobStatus[]> = {
  running: ['running', 'awaiting_verification', 'importing'],
  awaiting_verification: ['running', 'awaiting_verification'],
  importing: ['running', 'importing'],
  done: ['running', 'importing'],
  review: ['running', 'importing'],
  failed: ['running', 'awaiting_verification', 'importing'],
};
const ENDS = new Set<string>(['done', 'review', 'failed']);
const DAY_STATES: readonly DayState[] = ['loaded', 'review', 'failed', 'skipped'];
const clip = (v: unknown, n: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);
const ID = /^[A-Za-z0-9-]{1,64}$/;

export async function handleProgress(req: Request, d: SyncApiDeps): Promise<Response> {
  const worker = await authenticate(req, d);
  if (!worker) return denied();
  const b = await readBody(req);
  const job = typeof b.jobId === 'string' ? await d.store.getJob(b.jobId) : null;
  if (!job || job.claimedBy !== worker.id) return reply({error: 'That job is not yours.'}, 403);
  if (!isActive(job.status)) return reply({error: `The job is ${job.status}.`, stop: true, status: job.status, reason: job.error}, 409);

  const status = b.status === undefined ? undefined : typeof b.status === 'string' && FROM[b.status] ? (b.status as JobStatus) : null;
  if (status === null) return reply({error: 'Unknown status.'}, 400);
  const progress: Record<string, DayResult> = {...job.progress};
  const importIds = new Set(job.importIds);
  if (b.days !== undefined) {
    if (!b.days || typeof b.days !== 'object' || Array.isArray(b.days)) return reply({error: 'days must be an object keyed by day.'}, 400);
    for (const [day, raw] of Object.entries(b.days as Record<string, unknown>)) {
      const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      if (!job.days.includes(day)) return reply({error: `${day} is not part of this job.`}, 400);
      if (typeof r.state !== 'string' || !DAY_STATES.includes(r.state as DayState)) return reply({error: `Unknown state for ${day}.`}, 400);
      const importId = typeof r.importId === 'string' && ID.test(r.importId) ? r.importId : undefined;
      progress[day] = {state: r.state as DayState, ...(importId && {importId}), ...(clip(r.note, 200) && {note: clip(r.note, 200)})};
      if (importId) importIds.add(importId);
    }
  }
  const now = d.now().toISOString();
  const ending = status !== undefined && ENDS.has(status);
  const updated = await d.store.transitionJob(job.id, status ? FROM[status] : [job.status], {
    ...(status && {status}),
    heartbeatAt: now,
    progress,
    importIds: [...importIds],
    ...(status === 'failed' && {error: clip(b.error, 300) ?? 'worker reported a failure'}),
    ...(ending && {finishedAt: now}),
  });
  if (!updated) return reply({error: 'The job changed while reporting. Poll again.', stop: true}, 409);
  const session = asSession(b.sessionState);
  if (session) await d.store.touchWorker(worker.id, session, d.now());
  return reply({ok: true, job: {id: updated.id, status: updated.status}});
}
