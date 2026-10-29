import {beforeEach, describe, expect, it} from 'vitest';
import {handleClaim, handleProgress, handleWake, type SyncApiDeps} from '../src/shopee-sync/api';
import {requestSync, type SyncDeps} from '../src/shopee-sync/service';
import {AWAITING_EXPIRY_MS} from '../src/shopee-sync/rules';
import {FakeSyncStore} from './support/shopee-sync-fake-store';

// The one cloud worker: it reports its Shopee login (ready / needs_password / signed_out) and whether its remote browser is up on every poll,
// it serves whoever pressed Sync, and a Lambda wakes it through a token route. Nothing here carries a Shopee password.
const at = (phIso: string) => new Date(`${phIso}+08:00`);
const LOADED = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
const WORKER = 'worker-secret-for-tests';
const WAKE = 'wake-secret-for-tests';
let store: FakeSyncStore;
let clock: Date;
const sd = (): SyncDeps => ({store, now: () => clock, loadLoadedDays: async () => LOADED});
const api = (o: Partial<SyncApiDeps> = {}): SyncApiDeps => ({store, now: () => clock, workerToken: WORKER, wakeToken: WAKE, ...o});
const post = (path: string, body: unknown, token?: string) =>
  new Request(`https://coop.example/api/shopee/sync/${path}`, {method: 'POST', body: JSON.stringify(body), headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})}});
const claim = (body: unknown) => handleClaim(post('claim', body, WORKER), api());
const ready = {login: {state: 'ready', checkedAt: '2026-10-27T13:59:00+08:00'}, remote: {ready: true}};

beforeEach(() => {
  store = new FakeSyncStore();
  clock = at('2026-10-27T14:00:00');
});

describe('the worker reports its Shopee login and remote browser on a poll', () => {
  it('stores them in the single heartbeat row', async () => {
    expect((await claim(ready)).status).toBe(200);
    expect(store.heartbeat).toEqual({lastSeen: clock.toISOString(), loginState: 'ready', loginCheckedAt: at('2026-10-27T13:59:00').toISOString(), remoteReady: true});
  });
  it('there is only ever one heartbeat row: polls update it, they never add', async () => {
    await claim(ready);
    clock = new Date(clock.getTime() + 60_000);
    await claim({login: {state: 'needs_password', checkedAt: clock.toISOString()}});
    expect(store.heartbeat).toMatchObject({lastSeen: clock.toISOString(), loginState: 'needs_password', remoteReady: true});
  });
  it('needs_password and signed_out keep the worker from claiming', async () => {
    await claim(ready);
    expect((await requestSync(sd(), 'user@x.com')).ok).toBe(true);
    for (const state of ['needs_password', 'signed_out']) {
      expect(await (await claim({login: {state, checkedAt: clock.toISOString()}})).json()).toEqual({job: null});
      expect(store.heartbeat?.loginState).toBe(state);
    }
  });
  it('a poll that sends neither field changes nothing about the login; bad values are ignored, a future time is clamped to now', async () => {
    await claim(ready);
    await claim({});
    expect(store.heartbeat).toMatchObject({loginState: 'ready', remoteReady: true});
    await claim({login: {state: 'bogus', checkedAt: clock.toISOString()}, remote: {ready: 'yes'}});
    expect(store.heartbeat).toMatchObject({loginState: 'ready', remoteReady: true});
    await claim({login: {state: 'ready', checkedAt: '2030-01-01T00:00:00Z'}});
    expect(store.heartbeat?.loginCheckedAt).toBe(clock.toISOString());
    await claim({login: {state: 'ready', checkedAt: 'not a date'}});
    expect(store.heartbeat?.loginCheckedAt).toBe(clock.toISOString());
  });
  it('the progress route takes the same report', async () => {
    await claim(ready);
    expect((await requestSync(sd(), 'user@x.com')).ok).toBe(true);
    const got = await (await claim(ready)).json();
    expect(got.job).toBeTruthy();
    const res = await handleProgress(post('progress', {jobId: got.job.id, status: 'awaiting_verification', login: {state: 'needs_password', checkedAt: clock.toISOString()}, remote: {ready: false}}, WORKER), api());
    expect(res.status).toBe(200);
    expect(store.heartbeat).toMatchObject({loginState: 'needs_password', remoteReady: false});
    expect(store.jobs[0]).toMatchObject({status: 'awaiting_verification', awaitingSince: clock.toISOString()});
  });
  it('the single worker serves whoever pressed Sync', async () => {
    await claim(ready);
    const r = await requestSync(sd(), 'someone-else@x.com');
    expect(r.ok).toBe(true);
    expect((await (await claim(ready)).json()).job).toMatchObject({status: 'running'});
  });
});

describe('POST /api/shopee/sync/wake', () => {
  const wake = (token?: string) => handleWake(post('wake', {}, token), api());
  it('401 without the token, with a wrong one, or when none is configured; the body carries nothing', async () => {
    for (const r of [await wake(), await wake('nope'), await handleWake(post('wake', {}, WAKE), api({wakeToken: null})), await handleWake(post('wake', {}, ''), api())]) {
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({error: 'Unauthorized.'});
    }
  });
  it('wake is false with no queued job', async () => {
    expect(await (await wake(WAKE)).json()).toEqual({wake: false});
  });
  it('wake is true with a queued job and no worker ever seen, or not seen for 2 minutes, and names the job', async () => {
    store.heartbeat = {lastSeen: null, loginState: 'ready', loginCheckedAt: clock.toISOString(), remoteReady: false};
    const job = await requestSync(sd(), 'user@x.com');
    if (!job.ok) throw new Error(job.error);
    const b = await (await wake(WAKE)).json();
    expect(b).toEqual({wake: true, jobId: job.job.id});
    expect(JSON.stringify(b)).not.toMatch(/@/);
  });
  it('the wake decision reads the one heartbeat: false while seen within 2 minutes, true after', async () => {
    await claim(ready);
    expect((await requestSync(sd(), 'user@x.com')).ok).toBe(true);
    await claim({login: {state: 'needs_password', checkedAt: clock.toISOString()}}); // seen, but cannot claim
    clock = new Date(clock.getTime() + 119_000);
    expect(await (await wake(WAKE)).json()).toEqual({wake: false});
    clock = new Date(clock.getTime() + 2_000);
    expect((await (await wake(WAKE)).json()).wake).toBe(true);
    await claim({login: {state: 'needs_password', checkedAt: clock.toISOString()}}); // it came up
    expect((await (await wake(WAKE)).json()).wake).toBe(false);
  });
  it('a queued job nobody can claim for 30 minutes expires, so it no longer wakes anything', async () => {
    await claim(ready);
    expect((await requestSync(sd(), 'user@x.com')).ok).toBe(true);
    clock = new Date(clock.getTime() + 31 * 60_000);
    expect(await (await wake(WAKE)).json()).toEqual({wake: false});
  });
});

describe('a job waiting for an admin to sign in expires after 60 minutes', () => {
  it('is 60 minutes, fails the job cleanly and frees the team to sync again', async () => {
    expect(AWAITING_EXPIRY_MS).toBe(60 * 60_000);
    await claim(ready);
    await requestSync(sd(), 'user@x.com');
    const got = await (await claim(ready)).json();
    await handleProgress(post('progress', {jobId: got.job.id, status: 'awaiting_verification'}, WORKER), api());
    for (let i = 0; i < 11; i++) {
      clock = new Date(clock.getTime() + 5 * 60_000);
      await claim({}); // polling keeps the heartbeat fresh, not the verification
    }
    clock = new Date(clock.getTime() + 4 * 60_000); // 59 minutes in
    await claim({});
    expect(store.jobs[0].status).toBe('awaiting_verification');
    clock = new Date(clock.getTime() + 2 * 60_000);
    await claim({});
    expect(store.jobs[0]).toMatchObject({status: 'expired', error: expect.stringMatching(/signed in/i)});
  });
});
