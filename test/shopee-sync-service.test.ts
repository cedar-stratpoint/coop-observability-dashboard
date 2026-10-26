import {beforeEach, describe, expect, it} from 'vitest';
import {beginEnrolment, cancelSync, requestSync, revokeWorkerFor, type SyncDeps} from '../src/shopee-sync/service';
import {hashSecret, newWorkerToken} from '../src/shopee-sync/tokens';
import {FakeSyncStore} from './support/shopee-sync-fake-store';

const at = (phIso: string) => new Date(`${phIso}+08:00`);
const LOADED = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
let store: FakeSyncStore;
let clock: Date;
let loaded: string[];
const deps = (): SyncDeps => ({store, now: () => clock, loadLoadedDays: async () => loaded});
const addWorker = async (owner: string, state: 'ready' | 'signed_out' = 'ready') => {
  const w = await store.createWorker({ownerEmail: owner, name: `${owner}-mac`, tokenHash: hashSecret(newWorkerToken())}, clock);
  await store.touchWorker(w.id, state, clock);
  return w;
};

beforeEach(() => {
  store = new FakeSyncStore();
  clock = at('2026-10-27T14:00:00'); // Tuesday
  loaded = [...LOADED];
});

describe('requestSync', () => {
  it('creates a job with every missing closed day, computed by the server', async () => {
    await addWorker('a@x.com');
    const r = await requestSync(deps(), 'A@x.com');
    expect(r).toMatchObject({ok: true});
    if (!r.ok) throw new Error();
    expect(r.job.days).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26']);
    expect(r.job).toMatchObject({status: 'queued', requestedBy: 'a@x.com'});
  });
  it('says Shopee is up to date and creates nothing when no day is missing', async () => {
    await addWorker('a@x.com');
    loaded = [...LOADED, ...['19', '20', '21', '22', '23', '24', '25', '26'].map((d) => `2026-10-${d}`)];
    expect(await requestSync(deps(), 'a@x.com')).toEqual({ok: false, error: 'Shopee is up to date'});
    expect(store.jobs).toHaveLength(0);
  });
  it('refuses with a reason when the presser has no ready Mac (a workmate\'s or a signed-out one does not count)', async () => {
    await addWorker('b@x.com');
    await addWorker('a@x.com', 'signed_out');
    const r = await requestSync(deps(), 'a@x.com');
    expect(r).toMatchObject({ok: false});
    expect(!r.ok && r.error).toMatch(/Add a Mac|wake/i);
    expect(store.jobs).toHaveLength(0);
  });
  it('refuses a second sync while one is queued or running, and during cooldown', async () => {
    await addWorker('a@x.com');
    await requestSync(deps(), 'a@x.com');
    const again = await requestSync(deps(), 'a@x.com');
    expect(!again.ok && again.error).toMatch(/already/i);
  });
  it('refuses in the cooldown after a finished sync, then allows once it passes', async () => {
    await addWorker('a@x.com');
    const first = await requestSync(deps(), 'a@x.com');
    if (!first.ok) throw new Error();
    await store.transitionJob(first.job.id, ['queued'], {status: 'done', finishedAt: clock.toISOString()});
    clock = new Date(clock.getTime() + 5 * 60_000);
    const early = await requestSync(deps(), 'a@x.com');
    expect(!early.ok && early.error).toMatch(/wait/i);
    clock = new Date(clock.getTime() + 6 * 60_000);
    expect((await requestSync(deps(), 'a@x.com')).ok).toBe(true);
  });
  it('refuses in the Monday quiet window', async () => {
    await addWorker('a@x.com');
    clock = at('2026-10-26T09:00:00');
    const r = await requestSync(deps(), 'a@x.com');
    expect(!r.ok && r.error).toMatch(/monday/i);
  });
  it('sweeps a stale queued job first, so an unclaimed one does not block everyone forever', async () => {
    await addWorker('a@x.com');
    const first = await requestSync(deps(), 'a@x.com');
    if (!first.ok) throw new Error();
    clock = new Date(clock.getTime() + 31 * 60_000);
    expect((await requestSync(deps(), 'a@x.com')).ok).toBe(true);
    expect((await store.getJob(first.job.id))?.status).toBe('expired');
  });
});

describe('cancelSync', () => {
  it('lets the requester cancel a queued or running job, and records why', async () => {
    await addWorker('a@x.com');
    const r = await requestSync(deps(), 'a@x.com');
    if (!r.ok) throw new Error();
    expect(await cancelSync(deps(), {email: 'a@x.com', isAdmin: false}, r.job.id)).toEqual({ok: true});
    expect(await store.getJob(r.job.id)).toMatchObject({status: 'failed', error: 'Cancelled by a@x.com'});
  });
  it('refuses someone else, allows an admin, and refuses a finished job', async () => {
    await addWorker('a@x.com');
    const r = await requestSync(deps(), 'a@x.com');
    if (!r.ok) throw new Error();
    expect((await cancelSync(deps(), {email: 'b@x.com', isAdmin: false}, r.job.id)).ok).toBe(false);
    expect((await cancelSync(deps(), {email: 'b@x.com', isAdmin: true}, r.job.id)).ok).toBe(true);
    expect((await cancelSync(deps(), {email: 'a@x.com', isAdmin: false}, r.job.id)).ok).toBe(false);
  });
});

describe('beginEnrolment', () => {
  it('returns a one-time code (stored hashed, 15 minutes) and the docker command with placeholders', async () => {
    const r = await beginEnrolment(deps(), 'a@x.com', '  Dave MacBook ');
    if (!r.ok) throw new Error(r.error);
    expect(r.command).toContain(r.code);
    expect(r.command).toMatch(/docker run/);
    expect(r.command).toContain('<DASHBOARD_ADDRESS>');
    expect(r.command).toContain('<WORKER_IMAGE>');
    expect(store.enrolments[0]).toMatchObject({codeHash: hashSecret(r.code), ownerEmail: 'a@x.com', workerName: 'Dave MacBook'});
    expect(JSON.stringify(store.enrolments)).not.toContain(r.code);
    expect(Date.parse(r.expiresAt) - clock.getTime()).toBe(15 * 60_000);
  });
  it('enforces the 2-per-person and 3-per-team caps and a sane name', async () => {
    await addWorker('a@x.com');
    await addWorker('a@x.com');
    const own = await beginEnrolment(deps(), 'a@x.com', 'third');
    expect(!own.ok && own.error).toMatch(/2/);
    await addWorker('b@x.com');
    const team = await beginEnrolment(deps(), 'c@x.com', 'fourth');
    expect(!team.ok && team.error).toMatch(/3/);
    expect((await beginEnrolment(deps(), 'z@x.com', '   ')).ok).toBe(false);
    expect((await beginEnrolment(deps(), 'z@x.com', 'x'.repeat(61))).ok).toBe(false);
  });
});

describe('revokeWorkerFor', () => {
  it('lets the owner or an admin revoke, nobody else', async () => {
    const w = await addWorker('a@x.com');
    expect((await revokeWorkerFor(deps(), {email: 'b@x.com', isAdmin: false}, w.id)).ok).toBe(false);
    expect((await revokeWorkerFor(deps(), {email: 'a@x.com', isAdmin: false}, w.id)).ok).toBe(true);
    expect((await store.listWorkers())[0].revokedAt).not.toBeNull();
    const w2 = await addWorker('a@x.com');
    expect((await revokeWorkerFor(deps(), {email: 'admin@x.com', isAdmin: true}, w2.id)).ok).toBe(true);
    expect((await revokeWorkerFor(deps(), {email: 'a@x.com', isAdmin: false}, 'nope')).ok).toBe(false);
  });
});
