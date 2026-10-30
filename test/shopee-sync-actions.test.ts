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
  shopeeSyncDeps: () => ({store: state.store, now: () => new Date('2026-10-27T06:00:00Z'), loadLoadedDays: async () => state.loaded, remoteUrl: 'https://browser.example.com'}),
  revalidateDigestArchive: vi.fn(),
}));

import * as actions from '../src/shopee-sync-actions';
import {cancelSyncJob, createSyncJob} from '../src/shopee-sync-actions';
import {getShopeeSyncStatus} from '../src/shopee-sync-data';

let store: FakeSyncStore;
const when = new Date('2026-10-27T05:59:50Z');
const readyWorker = () => store.touchHeartbeat({login: {state: 'ready', checkedAt: when.toISOString()}}, when);

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
    await readyWorker();
    session.email = null;
    expect((await createSyncJob()).ok).toBe(false);
    session.email = 'a@x.com';
    process.env.ALLOWED_EMAILS = 'b@x.com';
    expect((await createSyncJob()).ok).toBe(false);
    expect(store.jobs).toHaveLength(0);
  });
  it('createSyncJob takes no days: the server computes them', async () => {
    await readyWorker();
    expect(createSyncJob.length).toBe(0);
    const r = await createSyncJob();
    expect(r).toMatchObject({ok: true, days: 8});
    expect(store.jobs[0].days[0]).toBe('2026-10-19');
  });
  it('cancelSyncJob works for the requester', async () => {
    await readyWorker();
    const job = await createSyncJob();
    if (!job.ok) throw new Error(job.error);
    expect((await cancelSyncJob(job.jobId)).ok).toBe(true);
  });
  it('there is no enrol, revoke or remote-address action any more', () => {
    expect(Object.keys(actions).sort()).toEqual(['cancelSyncJob', 'confirmSyncReview', 'createSyncJob']);
  });
  it('mock mode refuses every action', async () => {
    state.mock = true;
    expect(await createSyncJob()).toMatchObject({ok: false});
  });
});

describe('getShopeeSyncStatus', () => {
  it('is null when signed out', async () => {
    await readyWorker();
    expect(await getShopeeSyncStatus()).toMatchObject({signedInAs: 'a@x.com', worker: {state: 'online'}});
    session.email = null;
    expect(await getShopeeSyncStatus()).toBeNull();
  });
  it('gives the remote browser address to a Coop Admin only', async () => {
    await readyWorker();
    expect((await getShopeeSyncStatus())?.remoteUrl).toBeNull();
    memberships.rows = [{companyId: null, role: 'coop_admin'}];
    expect((await getShopeeSyncStatus())?.remoteUrl).toBe('https://browser.example.com');
  });
  it('before the worker has ever connected there is no worker', async () => {
    expect(await getShopeeSyncStatus()).toMatchObject({worker: null, canSync: {ok: false, reason: 'The cloud worker has not connected yet.'}});
  });
  it('mock mode returns an empty refusing status', async () => {
    state.mock = true;
    expect(await getShopeeSyncStatus()).toMatchObject({mock: true, worker: null, canSync: {ok: false}});
  });
});
