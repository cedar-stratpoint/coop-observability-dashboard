import {beforeEach, describe, expect, it} from 'vitest';
import {handleClaim, handleEnrol, handleProgress, type SyncApiDeps} from '../src/shopee-sync/api';
import {beginEnrolment, requestSync, type SyncDeps} from '../src/shopee-sync/service';
import {FakeSyncStore} from './support/shopee-sync-fake-store';

const at = (phIso: string) => new Date(`${phIso}+08:00`);
let store: FakeSyncStore;
let clock: Date;
const sd = (): SyncDeps => ({store, now: () => clock, loadLoadedDays: async () => ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']});
const api = (): SyncApiDeps => ({store, now: () => clock});
const post = (path: string, body: unknown, token?: string) =>
  new Request(`https://coop.example/api/shopee/sync/${path}`, {method: 'POST', body: JSON.stringify(body), headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})}});

/** Enrol a Mac the way the worker does: a person makes a code, the worker swaps it for a token. */
async function enrol(owner: string, name = 'mac'): Promise<{token: string; workerId: string}> {
  const e = await beginEnrolment(sd(), owner, name);
  if (!e.ok) throw new Error(e.error);
  const res = await handleEnrol(post('enrol', {code: e.code}), api());
  const b = await res.json();
  return {token: b.token, workerId: b.workerId};
}

beforeEach(() => {
  store = new FakeSyncStore();
  clock = at('2026-10-27T14:00:00');
});

describe('enrol', () => {
  it('swaps a one-time code for a worker token, shown once and stored only as a hash', async () => {
    const e = await beginEnrolment(sd(), 'a@x.com', 'Dave Mac');
    if (!e.ok) throw new Error();
    const res = await handleEnrol(post('enrol', {code: e.code}), api());
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.token).toMatch(/^zsw_/);
    const w = (await store.listWorkers())[0];
    expect(w).toMatchObject({ownerEmail: 'a@x.com', name: 'Dave Mac', sessionState: 'signed_out'});
    expect(JSON.stringify(w)).not.toContain(b.token);
  });
  it('refuses a used, expired or unknown code, and writes no worker', async () => {
    const e = await beginEnrolment(sd(), 'a@x.com', 'm');
    if (!e.ok) throw new Error();
    expect((await handleEnrol(post('enrol', {code: e.code}), api())).status).toBe(200);
    expect((await handleEnrol(post('enrol', {code: e.code}), api())).status).toBe(401);
    expect((await handleEnrol(post('enrol', {code: 'zse_nope'}), api())).status).toBe(401);
    const e2 = await beginEnrolment(sd(), 'b@x.com', 'm2');
    if (!e2.ok) throw new Error();
    clock = new Date(clock.getTime() + 16 * 60_000);
    expect((await handleEnrol(post('enrol', {code: e2.code}), api())).status).toBe(401);
    expect(store.workers).toHaveLength(1);
  });
  it('does not spend a code the cap refused: it works once a Mac is removed', async () => {
    const owners = ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'];
    const codes: string[] = [];
    for (const o of owners) {
      const e = await beginEnrolment(sd(), o, 'm');
      if (e.ok) codes.push(e.code);
    }
    for (const c of codes.slice(0, 3)) expect((await handleEnrol(post('enrol', {code: c}), api())).status).toBe(200);
    expect((await handleEnrol(post('enrol', {code: codes[3]}), api())).status).toBe(409);
    expect(store.enrolments.find((e) => e.ownerEmail === 'd@x.com')?.usedAt).toBeNull();
    await store.revokeWorker(store.workers[0].id, clock);
    expect((await handleEnrol(post('enrol', {code: codes[3]}), api())).status).toBe(200);
  });
  it('re-checks the team cap at redemption', async () => {
    const codes: string[] = [];
    for (const o of ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']) {
      const e = await beginEnrolment(sd(), o, 'm');
      if (e.ok) codes.push(e.code);
    }
    const statuses: number[] = [];
    for (const c of codes) statuses.push((await handleEnrol(post('enrol', {code: c}), api())).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 409)).toHaveLength(1);
  });
});

describe('claim', () => {
  it('401 without a valid token, and for a revoked worker, changing nothing', async () => {
    const {token, workerId} = await enrol('a@x.com');
    expect((await handleClaim(post('claim', {sessionState: 'ready'}), api())).status).toBe(401);
    expect((await handleClaim(post('claim', {sessionState: 'ready'}, 'zsw_bad'), api())).status).toBe(401);
    await store.revokeWorker(workerId, clock);
    expect((await handleClaim(post('claim', {sessionState: 'ready'}, token), api())).status).toBe(401);
    expect(store.workers[0].lastSeen).toBeNull();
  });
  it('records last_seen and session_state on every poll, and returns no job when none is queued', async () => {
    const {token} = await enrol('a@x.com');
    const res = await handleClaim(post('claim', {sessionState: 'ready'}, token), api());
    expect(await res.json()).toEqual({job: null});
    expect(store.workers[0]).toMatchObject({sessionState: 'ready', lastSeen: clock.toISOString()});
  });
  it('hands a queued job to its own ready worker, and sets it running', async () => {
    const {token, workerId} = await enrol('a@x.com');
    await handleClaim(post('claim', {sessionState: 'ready'}, token), api());
    const r = await requestSync(sd(), 'a@x.com');
    if (!r.ok) throw new Error(r.error);
    const b = await (await handleClaim(post('claim', {sessionState: 'ready'}, token), api())).json();
    expect(b.job).toMatchObject({id: r.job.id, days: r.job.days});
    expect(await store.getJob(r.job.id)).toMatchObject({status: 'running', claimedBy: workerId});
  });
  it('never hands a job to a workmate\'s Mac, or to a Mac that reports it is signed out', async () => {
    const a = await enrol('a@x.com');
    const b = await enrol('b@x.com');
    await handleClaim(post('claim', {sessionState: 'ready'}, a.token), api());
    const r = await requestSync(sd(), 'a@x.com');
    if (!r.ok) throw new Error(r.error);
    expect((await (await handleClaim(post('claim', {sessionState: 'ready'}, b.token), api())).json()).job).toBeNull();
    expect((await (await handleClaim(post('claim', {sessionState: 'signed_out'}, a.token), api())).json()).job).toBeNull();
    expect((await store.getJob(r.job.id))?.status).toBe('queued');
  });
  it('two workers of the same person claiming at once: exactly one gets the job', async () => {
    const a1 = await enrol('a@x.com', 'one');
    const a2 = await enrol('a@x.com', 'two');
    await handleClaim(post('claim', {sessionState: 'ready'}, a1.token), api());
    await handleClaim(post('claim', {sessionState: 'ready'}, a2.token), api());
    const r = await requestSync(sd(), 'a@x.com');
    if (!r.ok) throw new Error(r.error);
    const both = await Promise.all([a1, a2].map(async (w) => (await (await handleClaim(post('claim', {sessionState: 'ready'}, w.token), api())).json()).job));
    expect(both.filter(Boolean)).toHaveLength(1);
  });
  it('a poll sweeps a stale job: worker lost', async () => {
    const {token} = await enrol('a@x.com');
    await handleClaim(post('claim', {sessionState: 'ready'}, token), api());
    const r = await requestSync(sd(), 'a@x.com');
    if (!r.ok) throw new Error();
    await handleClaim(post('claim', {sessionState: 'ready'}, token), api()); // claimed
    store.jobs[0].heartbeatAt = new Date(clock.getTime() - 11 * 60_000).toISOString();
    const other = await enrol('b@x.com');
    await handleClaim(post('claim', {sessionState: 'ready'}, other.token), api());
    expect(await store.getJob(r.job.id)).toMatchObject({status: 'failed', error: 'worker lost'});
  });
});

describe('the Monday quiet window blocks starting, never finishing', () => {
  // Intended (plan, "Collision with the weekly RPA"): the server refuses to START or CLAIM a sync in 08:30 to 11:00 Monday; one already running is allowed to finish.
  it('lets a job claimed before 08:30 keep polling and reporting through the window, while a new claim waits', async () => {
    clock = at('2026-10-26T08:25:00');
    const a = await enrol('a@x.com');
    await handleClaim(post('claim', {sessionState: 'ready'}, a.token), api());
    const r = await requestSync(sd(), 'a@x.com');
    if (!r.ok) throw new Error(r.error);
    expect((await (await handleClaim(post('claim', {sessionState: 'ready'}, a.token), api())).json()).job).toMatchObject({id: r.job.id});
    clock = at('2026-10-26T08:34:00'); // inside the window, still within the heartbeat limit
    expect(await (await handleClaim(post('claim', {sessionState: 'ready'}, a.token), api())).json()).toEqual({job: null, activeJobId: r.job.id});
    const prog = await handleProgress(post('progress', {jobId: r.job.id, status: 'running', days: {[r.job.days[0]]: {state: 'loaded'}}}, a.token), api());
    expect(prog.status).toBe(200);
    expect((await store.getJob(r.job.id))?.status).toBe('running');
    expect((await handleProgress(post('progress', {jobId: r.job.id, status: 'done'}, a.token), api())).status).toBe(200);
    expect((await store.getJob(r.job.id))?.status).toBe('done');
  });
  it('does not hand a queued job to a worker inside the window, and does not queue a new one', async () => {
    clock = at('2026-10-26T08:25:00');
    const a = await enrol('a@x.com');
    await handleClaim(post('claim', {sessionState: 'ready'}, a.token), api());
    const r = await requestSync(sd(), 'a@x.com');
    if (!r.ok) throw new Error(r.error);
    clock = at('2026-10-26T08:40:00'); // inside the window, before the 30 minute queue expiry
    expect((await (await handleClaim(post('claim', {sessionState: 'ready'}, a.token), api())).json()).job).toBeNull();
    expect((await store.getJob(r.job.id))?.status).toBe('queued');
    await store.transitionJob(r.job.id, ['queued'], {status: 'expired', finishedAt: clock.toISOString()});
    const again = await requestSync(sd(), 'a@x.com');
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.error).toMatch(/Monday/);
  });
});

describe('progress', () => {
  async function running() {
    const w = await enrol('a@x.com');
    await handleClaim(post('claim', {sessionState: 'ready'}, w.token), api());
    const r = await requestSync(sd(), 'a@x.com');
    if (!r.ok) throw new Error(r.error);
    const job = (await (await handleClaim(post('claim', {sessionState: 'ready'}, w.token), api())).json()).job;
    return {w, job};
  }
  it('401 without a worker token; 403 for a job that is not this worker\'s', async () => {
    const {w, job} = await running();
    expect((await handleProgress(post('progress', {jobId: job.id}), api())).status).toBe(401);
    const other = await enrol('b@x.com');
    expect((await handleProgress(post('progress', {jobId: job.id, status: 'running'}, other.token), api())).status).toBe(403);
    expect((await handleProgress(post('progress', {jobId: job.id, status: 'running'}, w.token), api())).status).toBe(200);
  });
  it('records heartbeat, per-day results and import ids, and can ask for verification', async () => {
    const {w, job} = await running();
    clock = new Date(clock.getTime() + 60_000);
    const day = job.days[0];
    const ok = await handleProgress(post('progress', {jobId: job.id, status: 'awaiting_verification', days: {[day]: {state: 'loaded', importId: 'imp-1', note: 'ok'}}}, w.token), api());
    expect(ok.status).toBe(200);
    expect(await store.getJob(job.id)).toMatchObject({status: 'awaiting_verification', heartbeatAt: clock.toISOString(), importIds: ['imp-1'], progress: {[day]: {state: 'loaded', importId: 'imp-1'}}});
  });
  it('finishes a job: done sets finished_at', async () => {
    const {w, job} = await running();
    const res = await handleProgress(post('progress', {jobId: job.id, status: 'done'}, w.token), api());
    expect((await res.json()).job.status).toBe('done');
    expect((await store.getJob(job.id))?.finishedAt).toBe(clock.toISOString());
  });
  it('rejects bad input without changing anything: unknown status, a day outside the job, no password-like fields', async () => {
    const {w, job} = await running();
    expect((await handleProgress(post('progress', {jobId: job.id, status: 'queued'}, w.token), api())).status).toBe(400);
    expect((await handleProgress(post('progress', {jobId: job.id, days: {'2020-01-01': {state: 'loaded'}}}, w.token), api())).status).toBe(400);
    expect((await handleProgress(post('progress', {jobId: job.id, days: {[job.days[0]]: {state: 'nope'}}}, w.token), api())).status).toBe(400);
    expect((await store.getJob(job.id))?.status).toBe('running');
    // unknown fields (a password, an OTP) are never stored
    await handleProgress(post('progress', {jobId: job.id, status: 'running', password: 'hunter2', otp: '123456', days: {[job.days[0]]: {state: 'failed', note: 'x', password: 'hunter2'}}}, w.token), api());
    expect(JSON.stringify(store.jobs)).not.toMatch(/hunter2|123456/);
  });
  it('tells the worker to stop (409) once the job was cancelled or has finished', async () => {
    const {w, job} = await running();
    await store.transitionJob(job.id, ['running'], {status: 'failed', error: 'Cancelled by a@x.com'});
    const res = await handleProgress(post('progress', {jobId: job.id, status: 'running'}, w.token), api());
    expect(res.status).toBe(409);
    expect((await res.json()).stop).toBe(true);
  });
});
