import {beforeEach, describe, expect, it} from 'vitest';
import {handleClaim, handleProgress, handleWake, secretMatches, type SyncApiDeps} from '../src/shopee-sync/api';
import {requestSync, type SyncDeps} from '../src/shopee-sync/service';
import {workerAuthFor} from '../src/shopee-sync/worker-auth';
import {FakeSyncStore} from './support/shopee-sync-fake-store';

const at = (phIso: string) => new Date(`${phIso}+08:00`);
const WORKER = 'worker-secret-for-tests';
const WAKE = 'wake-secret-for-tests';
const ready = () => ({login: {state: 'ready', checkedAt: clock.toISOString()}});
let store: FakeSyncStore;
let clock: Date;
const sd = (): SyncDeps => ({store, now: () => clock, loadLoadedDays: async () => ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']});
const api = (o: Partial<SyncApiDeps> = {}): SyncApiDeps => ({store, now: () => clock, workerToken: WORKER, wakeToken: WAKE, ...o});
const post = (path: string, body: unknown, token?: string) =>
  new Request(`https://coop.example/api/shopee/sync/${path}`, {method: 'POST', body: JSON.stringify(body), headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})}});
const claim = async (body: unknown = ready(), token: string | undefined = WORKER) => (await handleClaim(post('claim', body, token), api())).json();
/** A queued sync, with the worker already reporting a Ready login. */
async function queued() {
  await claim();
  const r = await requestSync(sd(), 'a@x.com');
  if (!r.ok) throw new Error(r.error);
  return r.job;
}

beforeEach(() => {
  store = new FakeSyncStore();
  clock = at('2026-10-27T14:00:00');
});

describe('the one shared secret (SHOPEE_SYNC_WORKER_TOKEN)', () => {
  it('compares in constant time and never accepts an empty or missing secret', () => {
    expect(secretMatches('abc', 'abc')).toBe(true);
    expect(secretMatches('abc', 'abd')).toBe(false);
    expect(secretMatches('abc', 'abcd')).toBe(false);
    expect(secretMatches('', '')).toBe(false);
    expect(secretMatches(null, 'abc')).toBe(false);
    expect(secretMatches('abc', null)).toBe(false);
    expect(secretMatches('abc', undefined)).toBe(false);
  });
  it('claim and progress: 200 with the right secret, 401 JSON with a wrong or missing one, and a wrong one records nothing', async () => {
    const job = await queued();
    for (const route of ['claim', 'progress'] as const) {
      const h = route === 'claim' ? handleClaim : handleProgress;
      expect((await h(post(route, {jobId: job.id}), api())).status).toBe(401);
      const bad = await h(post(route, {jobId: job.id}, 'nope'), api());
      expect(bad.status).toBe(401);
      expect(bad.headers.get('content-type')).toMatch(/json/);
      expect(await bad.json()).toEqual({error: 'Unauthorized.'});
    }
    const seen = store.heartbeat?.lastSeen;
    clock = new Date(clock.getTime() + 60_000);
    await handleClaim(post('claim', ready(), 'nope'), api());
    expect(store.heartbeat?.lastSeen).toBe(seen);
    expect((await handleClaim(post('claim', ready(), WORKER), api())).status).toBe(200);
  });
  it('fails closed with 503 JSON when the secret is not configured, even for an empty bearer', async () => {
    for (const workerToken of [undefined, null, '']) {
      for (const token of [undefined, '', WORKER]) {
        const res = await handleClaim(post('claim', ready(), token), api({workerToken}));
        expect(res.status).toBe(503);
        expect(res.headers.get('content-type')).toMatch(/json/);
      }
      expect((await handleProgress(post('progress', {jobId: 'x'}, WORKER), api({workerToken}))).status).toBe(503);
    }
    expect(store.heartbeat).toBeNull();
  });
  it('the wake secret is not a worker secret and the worker secret is not a wake secret', async () => {
    expect((await handleClaim(post('claim', ready(), WAKE), api())).status).toBe(401);
    expect((await handleProgress(post('progress', {jobId: 'x'}, WAKE), api())).status).toBe(401);
    expect((await handleWake(post('wake', {}, WORKER), api())).status).toBe(401);
    expect((await handleWake(post('wake', {}, WAKE), api())).status).toBe(200);
    expect(store.heartbeat).toBeNull();
  });
  it('the shipped import routes take the same secret only, and only for the job running now', async () => {
    const auth = workerAuthFor(store, WORKER);
    expect(await auth('nope')).toBeNull();
    expect(await auth(WAKE)).toBeNull();
    expect(await workerAuthFor(store, undefined)('')).toBeNull();
    expect(await workerAuthFor(store, '')('')).toBeNull();
    expect(await auth(WORKER)).toEqual({days: [], jobId: null});
    const job = await queued();
    await claim();
    expect(await auth(WORKER)).toMatchObject({jobId: job.id, days: job.days});
  });
});

describe('claim', () => {
  it('records the heartbeat on every poll, and returns no job when none is queued', async () => {
    expect(await claim()).toEqual({job: null});
    expect(store.heartbeat).toMatchObject({lastSeen: clock.toISOString(), loginState: 'ready'});
  });
  it('hands the oldest queued job to the worker once its login is Ready, and sets it running', async () => {
    const job = await queued();
    const b = await claim();
    expect(b.job).toMatchObject({id: job.id, days: job.days});
    expect(await store.getJob(job.id)).toMatchObject({status: 'running', claimedAt: clock.toISOString()});
  });
  it('hands out nothing while the login is not Ready', async () => {
    await claim({login: {state: 'needs_password', checkedAt: clock.toISOString()}});
    store.heartbeat!.loginState = 'ready'; // let a job be requested, then the login goes bad
    const r = await requestSync(sd(), 'a@x.com');
    if (!r.ok) throw new Error(r.error);
    expect((await claim({login: {state: 'signed_out', checkedAt: clock.toISOString()}})).job).toBeNull();
    expect((await store.getJob(r.job.id))?.status).toBe('queued');
  });
  it('two polls at once: exactly one gets the job', async () => {
    await queued();
    const both = await Promise.all([claim(), claim()]);
    expect(both.filter((b) => b.job)).toHaveLength(1);
  });
  it('a poll sweeps a stale job: worker lost', async () => {
    const job = await queued();
    await claim(); // claimed
    store.jobs[0].heartbeatAt = new Date(clock.getTime() - 11 * 60_000).toISOString();
    store.jobs[0].status = 'running';
    await claim();
    expect(await store.getJob(job.id)).toMatchObject({status: 'failed', error: 'worker lost'});
  });
  it('a worker that restarts mid-sync is told which job is still active', async () => {
    const job = await queued();
    await claim();
    expect(await claim()).toEqual({job: null, activeJobId: job.id});
  });
});

describe('the Monday quiet window blocks starting, never finishing', () => {
  // The server refuses to START or CLAIM a sync in 08:30 to 11:00 Monday; one already running is allowed to finish.
  it('lets a job claimed before 08:30 keep polling and reporting through the window, while a new claim waits', async () => {
    clock = at('2026-10-26T08:25:00');
    const job = await queued();
    expect((await claim()).job).toMatchObject({id: job.id});
    clock = at('2026-10-26T08:34:00');
    expect(await claim()).toEqual({job: null, activeJobId: job.id});
    const prog = await handleProgress(post('progress', {jobId: job.id, status: 'running', days: {[job.days[0]]: {state: 'loaded'}}}, WORKER), api());
    expect(prog.status).toBe(200);
    expect((await handleProgress(post('progress', {jobId: job.id, status: 'done'}, WORKER), api())).status).toBe(200);
    expect((await store.getJob(job.id))?.status).toBe('done');
  });
  it('does not hand a queued job to the worker inside the window, and does not queue a new one', async () => {
    clock = at('2026-10-26T08:25:00');
    const job = await queued();
    clock = at('2026-10-26T08:40:00');
    expect((await claim()).job).toBeNull();
    expect((await store.getJob(job.id))?.status).toBe('queued');
    await store.transitionJob(job.id, ['queued'], {status: 'expired', finishedAt: clock.toISOString()});
    const again = await requestSync(sd(), 'a@x.com');
    expect(again.ok === false && again.error).toMatch(/Monday/);
  });
});

describe('progress', () => {
  async function running() {
    await queued();
    return (await claim()).job as {id: string; days: string[]};
  }
  it('404 for a job that does not exist; 200 for the running one, and it counts as a heartbeat', async () => {
    const job = await running();
    expect((await handleProgress(post('progress', {jobId: 'nope'}, WORKER), api())).status).toBe(404);
    clock = new Date(clock.getTime() + 90_000);
    expect((await handleProgress(post('progress', {jobId: job.id, status: 'running'}, WORKER), api())).status).toBe(200);
    expect(store.heartbeat?.lastSeen).toBe(clock.toISOString());
  });
  it('records heartbeat, per-day results and import ids, and can ask for verification', async () => {
    const job = await running();
    clock = new Date(clock.getTime() + 60_000);
    const ok = await handleProgress(post('progress', {jobId: job.id, status: 'awaiting_verification', days: {[job.days[0]]: {state: 'loaded', importId: 'imp-1', note: 'ok'}}}, WORKER), api());
    expect(ok.status).toBe(200);
    expect(await store.getJob(job.id)).toMatchObject({status: 'awaiting_verification', heartbeatAt: clock.toISOString(), importIds: ['imp-1'], progress: {[job.days[0]]: {state: 'loaded', importId: 'imp-1'}}});
  });
  it('finishes a job: done sets finished_at', async () => {
    const job = await running();
    const res = await handleProgress(post('progress', {jobId: job.id, status: 'done'}, WORKER), api());
    expect((await res.json()).job.status).toBe('done');
    expect((await store.getJob(job.id))?.finishedAt).toBe(clock.toISOString());
  });
  it('rejects bad input without changing anything, and never stores password-like fields', async () => {
    const job = await running();
    expect((await handleProgress(post('progress', {jobId: job.id, status: 'queued'}, WORKER), api())).status).toBe(400);
    expect((await handleProgress(post('progress', {jobId: job.id, days: {'2020-01-01': {state: 'loaded'}}}, WORKER), api())).status).toBe(400);
    expect((await handleProgress(post('progress', {jobId: job.id, days: {[job.days[0]]: {state: 'nope'}}}, WORKER), api())).status).toBe(400);
    expect((await store.getJob(job.id))?.status).toBe('running');
    await handleProgress(post('progress', {jobId: job.id, status: 'running', password: 'hunter2', otp: '123456', days: {[job.days[0]]: {state: 'failed', note: 'x', password: 'hunter2'}}}, WORKER), api());
    expect(JSON.stringify([store.jobs, store.heartbeat])).not.toMatch(/hunter2|123456/);
  });
  it('tells the worker to stop (409) once the job was cancelled or has finished', async () => {
    const job = await running();
    await store.transitionJob(job.id, ['running'], {status: 'failed', error: 'Cancelled by a@x.com'});
    const res = await handleProgress(post('progress', {jobId: job.id, status: 'running'}, WORKER), api());
    expect(res.status).toBe(409);
    expect((await res.json()).stop).toBe(true);
  });
});
