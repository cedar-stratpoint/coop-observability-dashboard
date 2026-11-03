import {beforeEach, describe, expect, it} from 'vitest';
import {handleClaim, handleProgress, handleWake, secretMatches, type SyncApiDeps} from '../src/shopee-sync/api';
import {requestSync, type SyncDeps} from '../src/shopee-sync/service';
import {workerAuthFor} from '../src/shopee-sync/worker-auth';
import {FakeSyncStore} from './support/shopee-sync-fake-store';
import {exactReports} from './support/shopee-sync-reports';

const at = (phIso: string) => new Date(`${phIso}+08:00`);
const WORKER = 'worker-secret-for-tests';
const WAKE = 'wake-secret-for-tests';
const ready = () => ({login: {state: 'ready', checkedAt: clock.toISOString()}});
let store: FakeSyncStore;
let clock: Date;
const WEEK1 = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
const sd = (): SyncDeps => ({store, now: () => clock, loadLoadedDays: async () => WEEK1, loadReportPeriods: async () => exactReports(WEEK1)});
// Changed deliberately (SYN-12): a worker's `done` is now checked against the loaded days, so the default archive here has every day of the jobs below loaded;
// the tests of the check itself override `loadLoadedDays`.
const EVERYTHING = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26'];
const api = (o: Partial<SyncApiDeps> = {}): SyncApiDeps => ({store, now: () => clock, workerToken: WORKER, wakeToken: WAKE, loadLoadedDays: async () => EVERYTHING, loadReportPeriods: async () => exactReports(EVERYTHING), ...o});
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
    const auth = workerAuthFor(store, WORKER, () => clock);
    expect(await auth('nope')).toBeNull();
    expect(await auth(WAKE)).toBeNull();
    expect(await workerAuthFor(store, undefined)('')).toBeNull();
    expect(await workerAuthFor(store, '')('')).toBeNull();
    // Changed deliberately (SYN-09): the grant carries the issued windows (and the job's only day, for a Refresh), not the days.
    expect(await auth(WORKER)).toEqual({windows: [], jobId: null, singleDay: null});
    const job = await queued();
    await claim();
    expect(await auth(WORKER)).toMatchObject({jobId: job.id, singleDay: null, windows: [{kind: 'week', from: '2026-10-19', to: '2026-10-25'}, {kind: 'day', from: '2026-10-26', to: '2026-10-26', files: ['sales_overview']}]});
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
    expect(b.job).toMatchObject({id: job.id, days: job.days, windows: [{kind: 'week', from: '2026-10-19', to: '2026-10-25'}, {kind: 'day', from: '2026-10-26', to: '2026-10-26', files: ['sales_overview']}]});
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

describe('Monday morning is not special any more (Sync replaces the weekly export)', () => {
  it('hands a queued job to the worker at 09:00 Monday and lets a new one queue', async () => {
    clock = at('2026-10-26T09:00:00');
    const job = await queued();
    expect((await claim()).job).toMatchObject({id: job.id});
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

describe('progress: files and the completeness check (SYN-09, SYN-12)', () => {
  const WEEK_FILE = '2026-10-19..2026-10-25/traffic';
  async function running(days?: string[]) {
    await claim();
    const r = await requestSync(sd(), 'a@x.com');
    if (!r.ok) throw new Error(r.error);
    if (days) store.jobs[0].days = days;
    return (await claim()).job as {id: string; days: string[]};
  }
  const prog = (body: unknown, o: Partial<SyncApiDeps> = {}) => handleProgress(post('progress', body, WORKER), api(o));

  it('stores per-file results next to the per-day ones, validated against the issued windows and their types', async () => {
    const job = await running();
    const ok = await prog({jobId: job.id, status: 'running', days: {[job.days[0]]: {state: 'loaded'}}, files: {[WEEK_FILE]: {state: 'unchanged', importId: 'imp-9'}, '2026-10-26..2026-10-26/sales_overview': {state: 'review'}}});
    expect(ok.status).toBe(200);
    expect(await store.getJob(job.id)).toMatchObject({importIds: ['imp-9'], progress: {[job.days[0]]: {state: 'loaded'}, [WEEK_FILE]: {state: 'unchanged'}, '2026-10-26..2026-10-26/sales_overview': {state: 'review'}}});
  });
  it('refuses a files key for a window not issued, a type the window lacks, a bad key, or a bad state; nothing changes', async () => {
    const job = await running();
    for (const files of [{'2026-10-05..2026-10-11/traffic': {state: 'loaded'}}, {'2026-10-26..2026-10-26/ads': {state: 'loaded'}}, {'nonsense': {state: 'loaded'}}, {[WEEK_FILE]: {state: 'exploded'}}, [WEEK_FILE]]) {
      expect((await prog({jobId: job.id, status: 'running', files})).status).toBe(400);
    }
    expect((await store.getJob(job.id))?.progress).toEqual({});
  });
  it('caps the import ids at windows x 5', async () => {
    const job = await running(['2026-10-26']); // one day window
    const DAY_FILE = '2026-10-26..2026-10-26/sales_overview';
    expect((await prog({jobId: job.id, files: {[DAY_FILE]: {state: 'loaded', importId: 'id-0'}}})).status).toBe(200);
    for (let i = 0; i < 4; i++) await prog({jobId: job.id, days: {[job.days[0]]: {state: 'loaded', importId: `more-${i}`}}});
    const res = await prog({jobId: job.id, files: {[DAY_FILE]: {state: 'loaded', importId: 'one-too-many'}}});
    expect(res.status).toBe(400); // 1 window x 5 = 5 ids; 5 already there, plus this one
  });
  it('done with a day still missing ends the job as failed with "Still missing: ..." (no new status)', async () => {
    const job = await running();
    const res = await prog({jobId: job.id, status: 'done'}, {loadLoadedDays: async () => EVERYTHING.filter((d) => d !== '2026-10-22' && d !== '2026-10-24')});
    expect(res.status).toBe(200);
    expect((await res.json()).job.status).toBe('failed');
    expect(await store.getJob(job.id)).toMatchObject({status: 'failed', error: 'Still missing: 2026-10-22, 2026-10-24.', finishedAt: clock.toISOString()});
  });
  it('a failed non-sales file is named in that error', async () => {
    const job = await running();
    await prog({jobId: job.id, status: 'running', files: {[WEEK_FILE]: {state: 'failed', note: 'no export'}}});
    await prog({jobId: job.id, status: 'done'}, {loadLoadedDays: async () => EVERYTHING.filter((d) => d !== '2026-10-22')});
    expect((await store.getJob(job.id))?.error).toBe(`Still missing: 2026-10-22. Failed files: ${WEEK_FILE}.`);
  });
  it('done with nothing missing is accepted, and the days that exist are marked loaded', async () => {
    const job = await running();
    const res = await prog({jobId: job.id, status: 'done'});
    expect((await res.json()).job.status).toBe('done');
    const j = await store.getJob(job.id);
    expect(j?.error).toBeNull();
    for (const d of job.days) expect(j?.progress[d]?.state).toBe('loaded');
  });
  it('done with a failed non-sales file but no day missing is still done (the Monday import covers the file)', async () => {
    const job = await running();
    await prog({jobId: job.id, status: 'running', files: {[WEEK_FILE]: {state: 'failed'}}});
    expect((await (await prog({jobId: job.id, status: 'done'})).json()).job.status).toBe('done');
  });
  it('a refresh job (one loaded day) is done when that day is loaded', async () => {
    const job = await running(['2026-10-26']);
    expect((await (await prog({jobId: job.id, status: 'done'})).json()).job.status).toBe('done');
  });
  it('a day that aged past the 35-day reach while the job ran is not held against it', async () => {
    const job = await running();
    store.jobs[0].days = ['2026-08-01'];
    expect((await (await prog({jobId: job.id, status: 'done'}, {loadLoadedDays: async () => []})).json()).job.status).toBe('done');
  });
});
