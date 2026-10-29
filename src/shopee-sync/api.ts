// The HTTP face of the sync for the WORKER: claim (a poll) and progress, plus the wake check. Plain Request -> Response handlers like
// src/shopee-import/api.ts; the files in app/api/shopee/sync/ are thin wrappers. There is ONE worker (the cloud box) and one shared secret:
// SHOPEE_SYNC_WORKER_TOKEN, sent as `Authorization: Bearer`. No field anywhere carries a Shopee password or code: unknown request fields are dropped, never stored.
import {createHash, timingSafeEqual} from 'node:crypto';
import type {SyncStore} from './store';
import {inQuietWindow, isOnline} from './rules';
import {sweepJobs} from './service';
import {isActive, LOGIN_STATES, type DayResult, type DayState, type Job, type JobStatus, type LoginState, type WorkerReport} from './types';

export interface SyncApiDeps {
  store: SyncStore;
  now: () => Date;
  /** SHOPEE_SYNC_WORKER_TOKEN (env only), the worker's shared secret. Null or unset: claim and progress answer 503 (fail closed). */
  workerToken?: string | null;
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

const sha = (v: string): Buffer => createHash('sha256').update(v).digest();
/** Constant-time: both sides are hashed to 32 bytes first, so length leaks nothing. An empty or missing secret never matches. */
export const secretMatches = (given: string | null, expected: string | null | undefined): boolean => Boolean(given && expected) && timingSafeEqual(sha(given as string), sha(expected as string));
const bearerMatches = (req: Request, secret: string | null | undefined): boolean => secretMatches(bearerOf(req), secret);

const denied = (): Response => reply({error: 'Unauthorized.'}, 401);
/** The worker routes' gate: null when the bearer is the shared worker secret; otherwise the 503 (secret not configured) or 401 (wrong) to send. */
const workerGate = (req: Request, d: SyncApiDeps): Response | null => (!d.workerToken ? reply({error: 'The sync worker secret (SHOPEE_SYNC_WORKER_TOKEN) is not configured on this deployment.'}, 503) : bearerMatches(req, d.workerToken) ? null : denied());

const asLogin = (v: unknown): LoginState | null => (typeof v === 'string' && (LOGIN_STATES as readonly string[]).includes(v) ? (v as LoginState) : null);
const FUTURE_SLACK_MS = 5 * 60_000;
/** What a worker said about itself in a poll: only the known fields, each validated; anything else (and any Shopee secret) is dropped, never stored. */
export function readReport(b: Record<string, unknown>, now: Date): WorkerReport {
  const out: WorkerReport = {};
  const login = b.login && typeof b.login === 'object' && !Array.isArray(b.login) ? (b.login as Record<string, unknown>) : null;
  const state = login ? asLogin(login.state) : null;
  if (state) {
    const t = typeof login!.checkedAt === 'string' ? Date.parse(login!.checkedAt) : NaN;
    // an unreadable or future time (a clock that is off) is taken as "just now" rather than trusted
    out.login = {state, checkedAt: (Number.isNaN(t) || t > now.getTime() + FUTURE_SLACK_MS ? now : new Date(t)).toISOString()};
  }
  const remote = b.remote && typeof b.remote === 'object' && !Array.isArray(b.remote) ? (b.remote as Record<string, unknown>) : null;
  if (remote && typeof remote.ready === 'boolean') out.remoteReady = remote.ready;
  return out;
}
const toWire = (j: Job) => ({id: j.id, days: j.days, status: j.status});

export async function handleClaim(req: Request, d: SyncApiDeps): Promise<Response> {
  const gate = workerGate(req, d);
  if (gate) return gate;
  const now = d.now();
  const hb = await d.store.touchHeartbeat(readReport(await readBody(req), now), now);
  const jobs = await sweepJobs(d.store, now);
  const active = jobs.find((j) => isActive(j.status)); // one worker, one sync at a time: an active job is the worker's own
  if (active) {
    await d.store.transitionJob(active.id, [active.status], {heartbeatAt: now.toISOString()}); // a poll is also a heartbeat
    return reply({job: null, activeJobId: active.id});
  }
  if (hb.loginState !== 'ready' || inQuietWindow(now)) return reply({job: null});
  const pick = jobs.filter((j) => j.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  const claimed = pick ? await d.store.claimJob(pick.id, now) : null;
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
  const gate = workerGate(req, d);
  if (gate) return gate;
  const b = await readBody(req);
  const job = typeof b.jobId === 'string' ? await d.store.getJob(b.jobId) : null;
  if (!job) return reply({error: 'No such job.'}, 404);
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
  await d.store.touchHeartbeat(readReport(b, d.now()), d.now()); // every progress call is a heartbeat too
  return reply({ok: true, job: {id: updated.id, status: updated.status}});
}

/**
 * The Lambda's question, "is there a job and nobody awake to take it?". Bearer SHOPEE_SYNC_WAKE_TOKEN, env only, compared as sha256 in constant
 * time; 401 for anything else (including no token configured). The answer carries no email and no person: just a boolean and the job id.
 */
export async function handleWake(req: Request, d: SyncApiDeps): Promise<Response> {
  if (!bearerMatches(req, d.wakeToken)) return denied();
  const now = d.now();
  const [jobs, hb] = await Promise.all([sweepJobs(d.store, now), d.store.getHeartbeat()]);
  const queued = jobs.filter((j) => j.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  const online = isOnline(hb?.lastSeen ?? null, now);
  return queued && !online ? reply({wake: true, jobId: queued.id}) : reply({wake: false});
}
