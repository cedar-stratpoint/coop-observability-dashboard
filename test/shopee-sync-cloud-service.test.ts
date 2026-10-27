import {beforeEach, describe, expect, it} from 'vitest';
import {beginEnrolment, dockerCommand, revokeWorkerFor, setRemoteUrlFor, type SyncDeps} from '../src/shopee-sync/service';
import {FakeSyncStore} from './support/shopee-sync-fake-store';

const ADMIN = 'owner@x.com';
let store: FakeSyncStore;
const now = new Date('2026-10-27T06:00:00Z');
const sd = (): SyncDeps => ({store, now: () => now, loadLoadedDays: async () => [], admins: [ADMIN]});
const cloudWorker = async () => store.createWorker({ownerEmail: ADMIN, name: 'Cloud worker', tokenHash: 'h1'}, now);

beforeEach(() => {
  store = new FakeSyncStore();
});

describe('the enrol command has a Mac and a cloud variant', () => {
  it('the cloud command has a placeholder image tag, no published port, and no secret but the one-time code', () => {
    const c = dockerCommand('zse_abc', 'cloud');
    expect(c).toContain('<WORKER_IMAGE_TAG>');
    expect(c).toContain('ENROL_CODE=zse_abc');
    expect(c).not.toContain('6080');
    expect(c).not.toMatch(/TOKEN|PASSWORD|SECRET|CLAUDE_CODE_OAUTH/i);
  });
  it('the Mac command is unchanged', () => {
    expect(dockerCommand('zse_abc')).toContain('-p 127.0.0.1:6080:6080');
    expect(dockerCommand('zse_abc', 'mac')).toBe(dockerCommand('zse_abc'));
  });
  it('only an admin can make the cloud variant; anyone makes the Mac one', async () => {
    const asUser = await beginEnrolment(sd(), 'u@x.com', 'cloud', 'cloud');
    expect(asUser).toEqual({ok: false, error: 'Only an admin can add the cloud worker.'});
    const asAdmin = await beginEnrolment(sd(), ADMIN, 'cloud', 'cloud');
    expect(asAdmin).toMatchObject({ok: true, command: expect.stringContaining('<WORKER_IMAGE_TAG>')});
    expect(await beginEnrolment(sd(), 'u@x.com', 'my mac')).toMatchObject({ok: true, command: expect.stringContaining('6080')});
  });
});

describe('setRemoteUrlFor', () => {
  it('lets an admin set and clear the address on a cloud worker, normalised', async () => {
    const w = await cloudWorker();
    expect(await setRemoteUrlFor(sd(), {email: ADMIN, isAdmin: true}, w.id, ' https://browser.example.com/ ')).toEqual({ok: true});
    expect(store.workers[0].remoteUrl).toBe('https://browser.example.com');
    expect(await setRemoteUrlFor(sd(), {email: ADMIN, isAdmin: true}, w.id, '')).toEqual({ok: true});
    expect(store.workers[0].remoteUrl).toBeNull();
  });
  it('refuses a non-admin, a bad address, a Mac that is not the cloud worker and a revoked worker', async () => {
    const w = await cloudWorker();
    const mac = await store.createWorker({ownerEmail: 'u@x.com', name: 'Mac', tokenHash: 'h2'}, now);
    expect(await setRemoteUrlFor(sd(), {email: 'u@x.com', isAdmin: false}, w.id, 'https://browser.example.com')).toMatchObject({ok: false});
    expect(await setRemoteUrlFor(sd(), {email: ADMIN, isAdmin: true}, w.id, 'javascript:alert(1)')).toMatchObject({ok: false});
    expect(await setRemoteUrlFor(sd(), {email: ADMIN, isAdmin: true}, mac.id, 'https://browser.example.com')).toMatchObject({ok: false});
    await store.revokeWorker(w.id, now);
    expect(await setRemoteUrlFor(sd(), {email: ADMIN, isAdmin: true}, w.id, 'https://browser.example.com')).toMatchObject({ok: false});
    expect(store.workers.every((x) => x.remoteUrl === null)).toBe(true);
  });
});

describe('revoking the cloud worker', () => {
  it('is for admins; a regular user cannot', async () => {
    const w = await cloudWorker();
    expect(await revokeWorkerFor(sd(), {email: 'u@x.com', isAdmin: false}, w.id)).toMatchObject({ok: false});
    expect(await revokeWorkerFor(sd(), {email: 'other-admin@x.com', isAdmin: true}, w.id)).toEqual({ok: true});
  });
});
