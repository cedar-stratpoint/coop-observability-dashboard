import {beforeEach, describe, expect, it, vi} from 'vitest';
import {emailAllowed} from '../src/shopee-sync/allowed';
import {FakeSyncStore} from './support/shopee-sync-fake-store';

const session = vi.hoisted(() => ({email: 'a@x.com' as string | null}));
const memberships = vi.hoisted(() => ({rows: [] as Array<{companyId: string | null; role: string}>}));
const state = vi.hoisted(() => ({store: null as unknown, mock: false, loaded: ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']}));

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({revalidateTag: vi.fn()}));
vi.mock('@/auth', () => ({auth: async () => (session.email ? {user: {email: session.email}} : null)}));
vi.mock('../src/company', () => ({fetchMemberships: async () => memberships.rows}));
vi.mock('../src/pos-data', () => ({usingPosMock: () => state.mock, posClient: () => ({})}));
vi.mock('../src/shopee-sync/server', () => ({
  shopeeSyncDeps: () => ({store: state.store, now: () => new Date('2026-10-27T06:00:00Z'), loadLoadedDays: async () => state.loaded}),
  revalidateDigestArchive: vi.fn(),
}));

import {cancelSyncJob, createSyncJob, revokeWorker, startEnrolment} from '../src/shopee-sync-actions';
import {getShopeeSyncStatus} from '../src/shopee-sync-data';

let store: FakeSyncStore;
const readyWorker = async (owner: string) => {
  const w = await store.createWorker({ownerEmail: owner, name: 'm', tokenHash: `h-${owner}-${Math.random()}`}, new Date());
  await store.touchWorker(w.id, 'ready', new Date('2026-10-27T05:59:50Z'));
  return w;
};

beforeEach(() => {
  store = new FakeSyncStore();
  state.store = store;
  state.mock = false;
  session.email = 'a@x.com';
  memberships.rows = [];
  delete process.env.ALLOWED_EMAILS;
});

describe('emailAllowed', () => {
  it('an empty list allows any account; otherwise exact, case-insensitive match', () => {
    expect(emailAllowed('a@x.com', undefined)).toBe(true);
    expect(emailAllowed('a@x.com', ' ')).toBe(true);
    expect(emailAllowed('A@x.com', 'a@x.com, b@x.com')).toBe(true);
    expect(emailAllowed('c@x.com', 'a@x.com,b@x.com')).toBe(false);
  });
});

describe('actions', () => {
  it('refuse when signed out or not on ALLOWED_EMAILS, without touching the store', async () => {
    await readyWorker('a@x.com');
    session.email = null;
    expect((await createSyncJob()).ok).toBe(false);
    session.email = 'a@x.com';
    process.env.ALLOWED_EMAILS = 'b@x.com';
    expect((await createSyncJob()).ok).toBe(false);
    expect((await startEnrolment('mac')).ok).toBe(false);
    expect(store.jobs).toHaveLength(0);
    expect(store.enrolments).toHaveLength(0);
  });
  it('createSyncJob takes no days: the server computes them', async () => {
    await readyWorker('a@x.com');
    expect(createSyncJob.length).toBe(0);
    const r = await createSyncJob();
    expect(r).toMatchObject({ok: true, days: 8});
    expect(store.jobs[0].days[0]).toBe('2026-10-19');
  });
  it('startEnrolment, cancelSyncJob and revokeWorker work for the owner', async () => {
    expect((await startEnrolment('Dave Mac')).ok).toBe(true);
    const w = await readyWorker('a@x.com');
    const job = await createSyncJob();
    if (!job.ok) throw new Error(job.error);
    expect((await cancelSyncJob(job.jobId)).ok).toBe(true);
    expect((await revokeWorker(w.id)).ok).toBe(true);
  });
  it('revokeWorker: a non-owner is refused, a Coop Admin may', async () => {
    const w = await readyWorker('b@x.com');
    expect((await revokeWorker(w.id)).ok).toBe(false);
    memberships.rows = [{companyId: null, role: 'coop_admin'}];
    expect((await revokeWorker(w.id)).ok).toBe(true);
  });
  it('mock mode refuses every action', async () => {
    state.mock = true;
    expect(await createSyncJob()).toMatchObject({ok: false});
    expect(await startEnrolment('m')).toMatchObject({ok: false});
  });
});

describe('getShopeeSyncStatus', () => {
  it('is null when signed out, and shows only own Macs unless admin', async () => {
    await readyWorker('a@x.com');
    await readyWorker('b@x.com');
    expect((await getShopeeSyncStatus())?.workers).toHaveLength(1);
    memberships.rows = [{companyId: null, role: 'coop_admin'}];
    expect((await getShopeeSyncStatus())?.workers).toHaveLength(2);
    session.email = null;
    expect(await getShopeeSyncStatus()).toBeNull();
  });
  it('mock mode returns an empty refusing status', async () => {
    state.mock = true;
    expect(await getShopeeSyncStatus()).toMatchObject({mock: true, workers: [], canSync: {ok: false}});
  });
});
