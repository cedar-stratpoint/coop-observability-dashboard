// The HTTP face of the sync for the WORKER: enrol (code for token), claim (a poll) and progress. Plain Request -> Response handlers like
// src/shopee-import/api.ts; the files in app/api/shopee/sync/ are thin wrappers. Auth is the worker's own bearer token (hash lookup,
// revocable per Mac). No field anywhere carries a Shopee password or code: unknown request fields are dropped, never stored.
import type {SyncStore} from './store';
import {canAddWorker, chooseJob, isCloudWorker, MAX_PER_PERSON, MAX_PER_TEAM} from './routing';
import {inQuietWindow, isOnline} from './rules';
import {sweepJobs} from './service';
import {hashSecret, newWorkerToken, verifySecret} from './tokens';
import {isActive, LOGIN_STATES, SESSION_STATES, type DayResult, type DayState, type Job, type JobStatus, type LoginState, type SessionState, type Worker, type WorkerReport} from './types';

export interface SyncApiDeps {
  store: SyncStore;
  now: () => Date;
  /** SHOPEE_SYNC_ADMINS, lower-cased: a worker enrolled by one of them is the shared cloud worker. */
  admins?: readonly string[];
  /** SHOPEE_SYNC_WAKE_TOKEN (env only), for the wake route. Null or unset: the route answers 401 to everyone. */
  wakeToken?: string | null;
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
  const token = newWorkerToken();
  const r = await d.store.redeemEnrolment(hashSecret(code), hashSecret(token), d.now(), {perPerson: MAX_PER_PERSON, perTeam: MAX_PER_TEAM});
  if (r.status === 'invalid') return denied(); // unknown, used or expired: one answer for all three
  if (r.status === 'capped') return reply({error: canAddWorker(await d.store.listWorkers(), r.ownerEmail) ?? 'No room for another Mac. Remove one first.'}, 409); // the code is not spent
  const w = r.worker;
  return reply({workerId: w.id, name: w.name, token}); // the token is shown this once
}

const asSession = (v: unknown): SessionState | null => (typeof v === 'string' && (SESSION_STATES as readonly string[]).includes(v) ? (v as SessionState) : null);
const asLogin = (v: unknown): LoginState | null => (typeof v === 'string' && (LOGIN_STATES as readonly string[]).includes(v) ? (v as LoginState) : null);
const FUTURE_SLACK_MS = 5 * 60_000;
/** What a worker said about itself in a poll: only the known fields, each validated; anything else (and any Shopee secret) is dropped, never stored. */
export function readReport(b: Record<string, unknown>, now: Date): WorkerReport {
  const out: WorkerReport = {};
  const session = asSession(b.sessionState);
  const login = b.login && typeof b.login === 'object' && !Array.isArray(b.login) ? (b.login as Record<string, unknown>) : null;
  const state = login ? asLogin(login.state) : null;
  if (state) {
    const t = typeof login!.checkedAt === 'string' ? Date.parse(login!.checkedAt) : NaN;
    // an unreadable or future time (a clock that is off) is taken as "just now" rather than trusted
    out.login = {state, checkedAt: (Number.isNaN(t) || t > now.getTime() + FUTURE_SLACK_MS ? now : new Date(t)).toISOString()};
    out.sessionState = state === 'ready' ? 'ready' : session === 'expired' ? 'expired' : 'signed_out';
  } else if (session) out.sessionState = session;
  const remote = b.remote && typeof b.remote === 'object' && !Array.isArray(b.remote) ? (b.remote as Record<string, unknown>) : null;
  if (remote && typeof remote.ready === 'boolean') out.remoteReady = remote.ready;
  return out;
}
const toWire = (j: Job) => ({id: j.id, days: j.days, status: j.status});

export async function handleClaim(req: Request, d: SyncApiDeps): Promise<Response> {
  const worker = await authenticate(req, d);
  if (!worker) return denied();
  const now = d.now();
  const report = readReport(await readBody(req), now);
  const state = report.sessionState ?? worker.sessionState;
  await d.store.touchWorker(worker.id, {...report, sessionState: state}, now);
  const jobs = await sweepJobs(d.store, now);
  const mine = jobs.find((j) => isActive(j.status) && j.claimedBy === worker.id);
  if (mine) {
    await d.store.transitionJob(mine.id, [mine.status], {heartbeatAt: now.toISOString()}); // a poll is also a heartbeat
    return reply({job: null, activeJobId: mine.id});
  }
  if (jobs.some((j) => isActive(j.status)) || inQuietWindow(now)) return reply({job: null});
  const anyOwner = isCloudWorker(worker, d.admins ?? []);
  const pick = chooseJob({...worker, sessionState: state}, jobs.filter((j) => j.status === 'queued'), anyOwner);
  const claimed = pick ? await d.store.claimJob(pick.id, worker.id, now, {anyOwner}) : null;
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
    ...(status === 'awaiting_verification' && job.status !== 'awaiting_verification' && {awaitingSince: now}),
  });
  if (!updated) return reply({error: 'The job changed while reporting. Poll again.', stop: true}, 409);
  const report = readReport(b, d.now());
  if (report.sessionState || report.login || report.remoteReady !== undefined) await d.store.touchWorker(worker.id, report, d.now());
  return reply({ok: true, job: {id: updated.id, status: updated.status}});
}

/**
 * The Lambda's question, "is there a job and nobody awake to take it?". Bearer SHOPEE_SYNC_WAKE_TOKEN, env only, compared as sha256 in constant
 * time; 401 for anything else (including no token configured). The answer carries no email and no person: just a boolean and the job id.
 */
export async function handleWake(req: Request, d: SyncApiDeps): Promise<Response> {
  const t = bearerOf(req);
  if (!d.wakeToken || !t || !verifySecret(t, hashSecret(d.wakeToken))) return denied();
  const now = d.now();
  const [jobs, workers] = await Promise.all([sweepJobs(d.store, now), d.store.listWorkers()]);
  const queued = jobs.filter((j) => j.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  const online = workers.some((w) => !w.revokedAt && isOnline(w.lastSeen, now));
  return queued && !online ? reply({wake: true, jobId: queued.id}) : reply({wake: false});
}
