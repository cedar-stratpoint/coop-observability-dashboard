import {beforeEach, describe, expect, it} from 'vitest';
import {handleClaim, handleEnrol, handleProgress, handleWake, type SyncApiDeps} from '../src/shopee-sync/api';
import {beginEnrolment, requestSync, type SyncDeps} from '../src/shopee-sync/service';
import {AWAITING_EXPIRY_MS} from '../src/shopee-sync/rules';
import {FakeSyncStore} from './support/shopee-sync-fake-store';

// The one cloud worker: it reports its Shopee login (ready / needs_password / signed_out) and whether its remote browser is up on every poll,
// it serves whoever pressed Sync, and a Lambda wakes it through a token route. Nothing here carries a Shopee password.
const at = (phIso: string) => new Date(`${phIso}+08:00`);
const LOADED = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
const ADMIN = 'owner@x.com';
const WAKE = 'wake-token-for-tests';
let store: FakeSyncStore;
let clock: Date;
const sd = (): SyncDeps => ({store, now: () => clock, loadLoadedDays: async () => LOADED, admins: [ADMIN]});
const api = (): SyncApiDeps => ({store, now: () => clock, wakeToken: WAKE});
const enrolCloud = () => enrol(ADMIN, 'cloud', 'cloud');
const post = (path: string, body: unknown, token?: string) =>
  new Request(`https://coop.example/api/shopee/sync/${path}`, {method: 'POST', body: JSON.stringify(body), headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})}});
async function enrol(owner: string, name = 'cloud', variant: 'mac' | 'cloud' = 'mac'): Promise<{token: string; workerId: string}> {
  const e = await beginEnrolment(sd(), owner, name, variant);
  if (!e.ok) throw new Error(e.error);
  const b = await (await handleEnrol(post('enrol', {code: e.code}), api())).json();
  return {token: b.token, workerId: b.workerId};
}
const ready = {login: {state: 'ready', checkedAt: '2026-10-27T13:59:00+08:00'}, remote: {ready: true}};

beforeEach(() => {
  store = new FakeSyncStore();
  clock = at('2026-10-27T14:00:00');
});

describe('a worker reports its Shopee login and remote browser on a poll', () => {
  it('stores them, and a ready login makes the session ready without a separate sessionState', async () => {
    const w = await enrolCloud();
    expect((await handleClaim(post('claim', ready, w.token), api())).status).toBe(200);
    expect(store.workers[0]).toMatchObject({loginState: 'ready', loginCheckedAt: at('2026-10-27T13:59:00').toISOString(), remoteReady: true, sessionState: 'ready'});
  });
  it('needs_password and signed_out keep the worker from claiming', async () => {
    const w = await enrolCloud();
    await handleClaim(post('claim', {login: {state: 'needs_password', checkedAt: clock.toISOString()}}, w.token), api());
    expect(store.workers[0]).toMatchObject({loginState: 'needs_password', sessionState: 'signed_out'});
    await handleClaim(post('claim', {login: {state: 'signed_out', checkedAt: clock.toISOString()}}, w.token), api());
    expect(store.workers[0]).toMatchObject({loginState: 'signed_out', sessionState: 'signed_out'});
  });
  it('an old worker that sends neither field changes nothing about the login; bad values are ignored, a future time is clamped to now', async () => {
    const w = await enrolCloud();
    await handleClaim(post('claim', ready, w.token), api());
    await handleClaim(post('claim', {sessionState: 'ready'}, w.token), api());
    expect(store.workers[0]).toMatchObject({loginState: 'ready', remoteReady: true});
    await handleClaim(post('claim', {login: {state: 'bogus', checkedAt: clock.toISOString()}, remote: {ready: 'yes'}}, w.token), api());
    expect(store.workers[0]).toMatchObject({loginState: 'ready', remoteReady: true});
    await handleClaim(post('claim', {login: {state: 'ready', checkedAt: '2030-01-01T00:00:00Z'}}, w.token), api());
    expect(store.workers[0].loginCheckedAt).toBe(clock.toISOString());
    await handleClaim(post('claim', {login: {state: 'ready', checkedAt: 'not a date'}}, w.token), api());
    expect(store.workers[0].loginCheckedAt).toBe(clock.toISOString());
  });
  it('the progress route takes the same report', async () => {
    const w = await enrolCloud();
    await handleClaim(post('claim', ready, w.token), api());
    expect((await requestSync(sd(), 'user@x.com')).ok).toBe(true);
    const claim = await (await handleClaim(post('claim', ready, w.token), api())).json();
    expect(claim.job).toBeTruthy();
    const res = await handleProgress(post('progress', {jobId: claim.job.id, status: 'awaiting_verification', login: {state: 'needs_password', checkedAt: clock.toISOString()}, remote: {ready: true}}, w.token), api());
    expect(res.status).toBe(200);
    expect(store.workers[0]).toMatchObject({loginState: 'needs_password', remoteReady: true});
    expect(store.jobs[0]).toMatchObject({status: 'awaiting_verification', awaitingSince: clock.toISOString()});
  });
});

describe('the cloud worker serves whoever pressed Sync', () => {
  it('a worker owned by an admin claims another person\'s job; a Mac owned by someone else still does not', async () => {
    const cloud = await enrolCloud();
    const mac = await enrol('bea@x.com', 'Bea Mac');
    await handleClaim(post('claim', ready, cloud.token), api());
    await handleClaim(post('claim', {sessionState: 'ready'}, mac.token), api());
    expect((await requestSync(sd(), 'user@x.com')).ok).toBe(true);
    expect((await (await handleClaim(post('claim', {sessionState: 'ready'}, mac.token), api())).json()).job).toBeNull();
    const got = await (await handleClaim(post('claim', ready, cloud.token), api())).json();
    expect(got.job).toMatchObject({status: 'running'});
    expect(store.jobs[0].claimedBy).toBe(cloud.workerId);
  });
  it('an admin\'s own Mac (enrolled as a Mac) is not shared: it serves only its owner, and its login report never stands in for the box', async () => {
    const mac = await enrol(ADMIN, 'Owner Mac');
    expect(store.workers[0].isCloud).toBe(false);
    await handleClaim(post('claim', ready, mac.token), api());
    expect((await requestSync(sd(), 'user@x.com')).ok).toBe(false); // the Mac's ready login does not unlock Sync for someone else
    expect((await requestSync(sd(), ADMIN)).ok).toBe(true); // it can serve its own owner
    expect((await (await handleClaim(post('claim', ready, mac.token), api())).json()).job).toMatchObject({status: 'running'});
  });
  it('the cloud flag is set at enrolment, only for the cloud variant', async () => {
    await enrol(ADMIN, 'box', 'cloud');
    await enrol('bea@x.com', 'Bea Mac');
    expect(store.workers.map((w) => w.isCloud)).toEqual([true, false]);
  });
});

describe('POST /api/shopee/sync/wake', () => {
  const wake = (token?: string) => handleWake(post('wake', {}, token), api());
  it('401 without the token, with a wrong one, or when none is configured; the body carries nothing', async () => {
    for (const r of [await wake(), await wake('nope'), await handleWake(post('wake', {}, WAKE), {...api(), wakeToken: null}), await handleWake(post('wake', {}, ''), api())]) {
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({error: 'Unauthorized.'});
    }
  });
  it('wake is false with no queued job', async () => {
    expect(await (await wake(WAKE)).json()).toEqual({wake: false});
  });
  it('wake is true with a queued job and no worker online, and names the job', async () => {
    const cloud = await enrolCloud();
    await handleClaim(post('claim', ready, cloud.token), api());
    clock = new Date(clock.getTime() + 5 * 60_000); // the server went quiet
    const job = await requestSync(sd(), 'user@x.com');
    if (!job.ok) throw new Error(job.error);
    const b = await (await wake(WAKE)).json();
    expect(b).toEqual({wake: true, jobId: job.job.id});
    expect(JSON.stringify(b)).not.toMatch(/@/);
  });
  it('wake is false while any worker was seen within 2 minutes, and a revoked worker does not count as online', async () => {
    const cloud = await enrolCloud();
    await handleClaim(post('claim', ready, cloud.token), api());
    expect((await requestSync(sd(), 'user@x.com')).ok).toBe(true);
    await handleClaim(post('claim', {login: {state: 'needs_password', checkedAt: clock.toISOString()}}, cloud.token), api()); // seen, but cannot claim
    clock = new Date(clock.getTime() + 119_000);
    expect(await (await wake(WAKE)).json()).toEqual({wake: false});
    clock = new Date(clock.getTime() + 2_000);
    expect((await (await wake(WAKE)).json()).wake).toBe(true);
    clock = new Date(clock.getTime() - 60_000);
    await handleClaim(post('claim', {login: {state: 'needs_password', checkedAt: clock.toISOString()}}, cloud.token), api());
    expect((await (await wake(WAKE)).json()).wake).toBe(false);
    await store.revokeWorker(cloud.workerId, clock);
    expect((await (await wake(WAKE)).json()).wake).toBe(true);
  });
  it('someone else\'s Mac being online does not suppress the wake: only the cloud worker counts', async () => {
    const cloud = await enrolCloud();
    await handleClaim(post('claim', ready, cloud.token), api());
    const mac = await enrol('bea@x.com', 'Bea Mac');
    expect((await requestSync(sd(), 'user@x.com')).ok).toBe(true);
    clock = new Date(clock.getTime() + 5 * 60_000); // the box has been quiet for 5 minutes
    await handleClaim(post('claim', {sessionState: 'signed_out'}, mac.token), api()); // Bea's Mac polls just now
    expect((await (await wake(WAKE)).json()).wake).toBe(true);
  });
  it('a queued job nobody can claim for 30 minutes expires, so it no longer wakes anything', async () => {
    const cloud = await enrolCloud();
    await handleClaim(post('claim', ready, cloud.token), api());
    expect((await requestSync(sd(), 'user@x.com')).ok).toBe(true);
    clock = new Date(clock.getTime() + 31 * 60_000);
    expect(await (await wake(WAKE)).json()).toEqual({wake: false});
  });
});

describe('a job waiting for an admin to sign in expires after 60 minutes', () => {
  it('is 60 minutes, fails the job cleanly and frees the team to sync again', async () => {
    expect(AWAITING_EXPIRY_MS).toBe(60 * 60_000);
    const cloud = await enrolCloud();
    await handleClaim(post('claim', ready, cloud.token), api());
    await requestSync(sd(), 'user@x.com');
    const claim = await (await handleClaim(post('claim', ready, cloud.token), api())).json();
    await handleProgress(post('progress', {jobId: claim.job.id, status: 'awaiting_verification'}, cloud.token), api());
    for (let i = 0; i < 11; i++) {
      clock = new Date(clock.getTime() + 5 * 60_000);
      await handleClaim(post('claim', {sessionState: 'ready'}, cloud.token), api()); // polling keeps the heartbeat fresh, not the verification
    }
    clock = new Date(clock.getTime() + 4 * 60_000); // 59 minutes in
    await handleClaim(post('claim', {sessionState: 'ready'}, cloud.token), api());
    expect(store.jobs[0].status).toBe('awaiting_verification');
    clock = new Date(clock.getTime() + 2 * 60_000);
    await handleClaim(post('claim', {sessionState: 'ready'}, cloud.token), api());
    expect(store.jobs[0]).toMatchObject({status: 'expired', error: expect.stringMatching(/signed in/i)});
  });
});
