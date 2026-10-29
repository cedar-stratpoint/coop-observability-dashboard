import {beforeEach, describe, expect, it} from 'vitest';
import {cancelSync, requestSync, type SyncDeps} from '../src/shopee-sync/service';
import {FakeSyncStore} from './support/shopee-sync-fake-store';

const at = (phIso: string) => new Date(`${phIso}+08:00`);
const LOADED = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
let store: FakeSyncStore;
let clock: Date;
let loaded: string[];
const deps = (): SyncDeps => ({store, now: () => clock, loadLoadedDays: async () => loaded});
/** The worker's last heartbeat: what it reported about the Shopee login. */
const heartbeat = async (login: 'ready' | 'needs_password' | 'signed_out' | null = 'ready') => store.touchHeartbeat(login ? {login: {state: login, checkedAt: clock.toISOString()}} : {}, clock);

beforeEach(() => {
  store = new FakeSyncStore();
  clock = at('2026-10-27T14:00:00'); // Tuesday
  loaded = [...LOADED];
});

describe('requestSync', () => {
  it('creates a job with every missing closed day, computed by the server', async () => {
    await heartbeat();
    const r = await requestSync(deps(), 'A@x.com');
    expect(r).toMatchObject({ok: true});
    if (!r.ok) throw new Error();
    expect(r.job.days).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26']);
    expect(r.job).toMatchObject({status: 'queued', requestedBy: 'a@x.com'});
  });
  it('says Shopee is up to date and creates nothing when no day is missing', async () => {
    await heartbeat();
    loaded = [...LOADED, ...['19', '20', '21', '22', '23', '24', '25', '26'].map((d) => `2026-10-${d}`)];
    expect(await requestSync(deps(), 'a@x.com')).toEqual({ok: false, error: 'Shopee is up to date'});
    expect(store.jobs).toHaveLength(0);
  });
  it('says the cloud worker has not connected yet when it never sent a heartbeat', async () => {
    const r = await requestSync(deps(), 'a@x.com');
    expect(r).toEqual({ok: false, error: 'The cloud worker has not connected yet.'});
    expect(store.jobs).toHaveLength(0);
  });
  it('waits for a first check, and refuses while the login needs an admin', async () => {
    await heartbeat(null);
    expect(await requestSync(deps(), 'a@x.com')).toEqual({ok: false, error: 'Waiting for the first login check'});
    await heartbeat('needs_password');
    expect(await requestSync(deps(), 'a@x.com')).toMatchObject({ok: false, error: expect.stringMatching(/admin/)});
    await heartbeat('signed_out');
    expect(await requestSync(deps(), 'a@x.com')).toMatchObject({ok: false, error: expect.stringMatching(/admin/)});
    expect(store.jobs).toHaveLength(0);
  });
  it('treats a Ready check older than 24 hours as unknown', async () => {
    await heartbeat();
    clock = new Date(clock.getTime() + 25 * 3_600_000);
    expect(await requestSync(deps(), 'a@x.com')).toEqual({ok: false, error: 'Waiting for a fresh login check'});
  });
  it('refuses a second sync while one is queued or running, and during cooldown', async () => {
    await heartbeat();
    await requestSync(deps(), 'a@x.com');
    const again = await requestSync(deps(), 'a@x.com');
    expect(!again.ok && again.error).toMatch(/already/i);
  });
  it('refuses in the cooldown after a finished sync, then allows once it passes', async () => {
    await heartbeat();
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
    await heartbeat();
    clock = at('2026-10-26T09:00:00');
    const r = await requestSync(deps(), 'a@x.com');
    expect(!r.ok && r.error).toMatch(/monday/i);
  });
  it('sweeps a stale queued job first, so an unclaimed one does not block everyone forever', async () => {
    await heartbeat();
    const first = await requestSync(deps(), 'a@x.com');
    if (!first.ok) throw new Error();
    clock = new Date(clock.getTime() + 31 * 60_000);
    expect((await requestSync(deps(), 'a@x.com')).ok).toBe(true);
    expect((await store.getJob(first.job.id))?.status).toBe('expired');
  });
});

describe('cancelSync', () => {
  it('lets the requester cancel a queued or running job, and records why', async () => {
    await heartbeat();
    const r = await requestSync(deps(), 'a@x.com');
    if (!r.ok) throw new Error();
    expect(await cancelSync(deps(), {email: 'a@x.com', isAdmin: false}, r.job.id)).toEqual({ok: true});
    expect(await store.getJob(r.job.id)).toMatchObject({status: 'failed', error: 'Cancelled by a@x.com'});
  });
  it('refuses someone else, allows an admin, and refuses a finished job', async () => {
    await heartbeat();
    const r = await requestSync(deps(), 'a@x.com');
    if (!r.ok) throw new Error();
    expect((await cancelSync(deps(), {email: 'b@x.com', isAdmin: false}, r.job.id)).ok).toBe(false);
    expect((await cancelSync(deps(), {email: 'b@x.com', isAdmin: true}, r.job.id)).ok).toBe(true);
    expect((await cancelSync(deps(), {email: 'a@x.com', isAdmin: false}, r.job.id)).ok).toBe(false);
  });
});
