import {describe, expect, it} from 'vitest';
import {cardVisible, loginLine, noWorkerText, serverLine, statusMeta, stepsFor, syncButton} from '../src/shopee-sync/card-model';
import {buildSyncStatus, type ShopeeSyncStatus, type SyncJobView} from '../src/shopee-sync/status';
import {FIRST_CHECK, FRESH_CHECK, NEEDS_ADMIN} from '../src/shopee-sync/service';
import type {Heartbeat, Job} from '../src/shopee-sync/types';

// The card on the one cloud worker: login state first, then the server (asleep, waking, online), and an admin-only way in.
const now = new Date('2026-10-27T06:00:00Z'); // PH Tuesday 14:00
const LOADED = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
const ADMIN = 'owner@x.com';
const REMOTE = 'https://browser.example.com';
const cloud = (o: Partial<Heartbeat> = {}): Heartbeat => ({lastSeen: ago(7200), loginState: 'ready', loginCheckedAt: ago(7200), remoteReady: true, ...o});
const job = (o: Partial<Job> = {}): Job => ({id: 'j1', requestedBy: 'u@x.com', days: ['2026-10-19'], status: 'queued', claimedAt: null, heartbeatAt: null, importIds: [], error: null, createdAt: ago(60), finishedAt: null, progress: {}, awaitingSince: null, ...o});
const build = (o: Partial<Parameters<typeof buildSyncStatus>[0]> = {}) => buildSyncStatus({viewer: {email: 'u@x.com', isAdmin: false}, now, heartbeat: cloud(), remoteUrl: REMOTE, jobs: [], loadedDays: LOADED, ...o});

describe('login on the status', () => {
  it('carries the last known login with its check time and age, and keeps it while the server sleeps', () => {
    const s = build();
    expect(s.login).toEqual({state: 'ready', checkedAt: ago(7200), ageSeconds: 7200, stale: false});
    expect(s.workerOnline).toBe(false);
    expect(s.canSync).toMatchObject({ok: true});
  });
  it('is unknown before the first check, and Sync waits for it', () => {
    const s = build({heartbeat: cloud({loginState: null, loginCheckedAt: null, lastSeen: null})});
    expect(s.login).toEqual({state: 'unknown', checkedAt: null, ageSeconds: null, stale: false});
    expect(s.canSync).toEqual({ok: false, reason: FIRST_CHECK});
  });
  it('disables Sync and says an admin must sign in for needs_password and signed_out', () => {
    for (const loginState of ['needs_password', 'signed_out'] as const) {
      const s = build({heartbeat: cloud({loginState})});
      expect(s.canSync).toEqual({ok: false, reason: NEEDS_ADMIN});
      expect(syncButton(s)).toMatchObject({disabled: true, reason: 'Shopee needs an admin to sign in. Please ask an admin.'});
    }
  });
  it('is online when the worker was seen within 2 minutes', () => {
    expect(build({heartbeat: cloud({lastSeen: ago(100)})}).workerOnline).toBe(true);
    expect(build({heartbeat: cloud({lastSeen: ago(130)})}).workerOnline).toBe(false);
  });
});

describe('the remote browser address is for admins only', () => {
  it('is null for a regular user, in every field', () => {
    const s = build();
    expect(s.remoteUrl).toBeNull();
    expect(JSON.stringify(s)).not.toContain('browser.example.com');
    expect(s.remoteReady).toBe(true);
  });
  it('is given to a Coop Admin', () => {
    const s = build({viewer: {email: 'coop-admin@x.com', isAdmin: true}});
    expect(s.remoteUrl).toBe(REMOTE);
  });
  it('never exposes a secret', () => {
    expect(JSON.stringify(build({viewer: {email: ADMIN, isAdmin: true}}))).not.toMatch(/token|secret/i);
  });
});

describe('the worker on the status', () => {
  it('is asleep, online or offline for everyone', () => {
    expect(build().worker?.state).toBe('asleep');
    expect(build({heartbeat: cloud({lastSeen: ago(10)})}).worker?.state).toBe('online');
    expect(build({jobs: [job({createdAt: ago(11 * 60)})]}).worker?.state).toBe('offline');
    expect(build({jobs: [job({status: 'expired', error: 'worker offline', createdAt: ago(40 * 60), finishedAt: ago(600)})]}).worker?.state).toBe('offline');
  });
});

describe('loginLine', () => {
  const st = (login: Omit<ShopeeSyncStatus['login'], 'stale'> & {stale?: boolean}) => ({...build(), login: {stale: false, ...login}});
  it('says Signed in with the age of the check', () => {
    expect(loginLine(st({state: 'ready', checkedAt: ago(7200), ageSeconds: 7200}), now)).toMatchObject({label: 'Ready', tone: 'good', text: 'Signed in, checked 2 hours ago'});
  });
  it('names the other states, never colour alone', () => {
    expect(loginLine(st({state: 'needs_password', checkedAt: ago(10800), ageSeconds: 10800}), now)).toMatchObject({label: 'Needs password', tone: 'warn'});
    expect(loginLine(st({state: 'signed_out', checkedAt: ago(60), ageSeconds: 60}), now)).toMatchObject({label: 'Signed out', tone: 'crit'});
    expect(loginLine(st({state: 'unknown', checkedAt: null, ageSeconds: null}), now)).toMatchObject({label: 'Not checked', text: 'No check has run yet'});
  });
});

describe('serverLine', () => {
  it('has nothing until the worker has sent a heartbeat', () => {
    expect(serverLine(build({heartbeat: null}), now)).toBeNull();
  });
  it('asleep: Sync will wake it', () => {
    expect(serverLine(build(), now)).toMatchObject({kind: 'asleep', text: expect.stringContaining('Server asleep. Sync will wake it, about 1 to 4 minutes')});
  });
  it('asleep with a login that is not Ready does not promise that Sync will wake it', () => {
    expect(serverLine(build({heartbeat: cloud({loginState: 'needs_password'})}), now)?.text).toBe('Server asleep, last seen 2 hours ago.');
  });
  it('waking: a queued job and nobody online', () => {
    expect(serverLine(build({jobs: [job()]}), now)).toEqual({kind: 'waking', text: 'Waking the server, about 1 to 4 minutes.'});
  });
  it('online and offline', () => {
    expect(serverLine(build({heartbeat: cloud({lastSeen: ago(12)})}), now)).toMatchObject({kind: 'online', text: 'Server online, last seen 12 seconds ago.'});
    expect(serverLine(build({jobs: [job({createdAt: ago(11 * 60)})]}), now)).toMatchObject({kind: 'offline'});
  });
});

describe('awaiting verification on the cloud worker', () => {
  const view = (o: Partial<SyncJobView> = {}): SyncJobView => ({id: 'j', requestedBy: 'u@x.com', mine: true, days: ['2026-10-19'], status: 'awaiting_verification', error: null, progress: {}, createdAt: ago(60), finishedAt: null, awaitingSince: ago(30), ...o});
  it('says Waiting for an admin to a regular user, who gets no password instruction', () => {
    const m = statusMeta(view(), {isAdmin: false});
    expect(m).toMatchObject({label: 'Waiting for an admin', title: 'Waiting for an admin'});
    expect(m.body).toMatch(/60 minutes/);
    expect(m.body).not.toMatch(/type/i);
  });
  it('tells an admin to open the remote browser and type it there, not in Coop', () => {
    const m = statusMeta(view({mine: false}), {isAdmin: true});
    expect(m).toMatchObject({label: 'Needs your sign-in', title: 'Shopee needs your sign-in'});
    expect(m.body).toMatch(/remote browser/);
    expect(m.body).toMatch(/not in Coop/);
  });
  it('labels the step Admin signs in', () => {
    expect(stepsFor(view()).map((s) => s.label)).toContain('Admin signs in');
  });
});

describe('a queued job on the cloud worker', () => {
  const view = (o: Partial<SyncJobView> = {}): SyncJobView => ({id: 'j', requestedBy: 'u@x.com', mine: true, days: ['2026-10-19'], status: 'queued', error: null, progress: {}, createdAt: ago(60), finishedAt: null, awaitingSince: null, ...o});
  it('says Waking the server when nobody is online, and plain queued once a worker is', () => {
    expect(statusMeta(view(), {isAdmin: false, workerOnline: false})).toMatchObject({label: 'Waking the server', body: expect.stringContaining('1 to 4 minutes')});
    expect(statusMeta(view(), {isAdmin: false, workerOnline: true}).label).toBe('Queued');
  });
  it('an expired job nobody picked up says the server did not wake, and offers Retry', () => {
    expect(statusMeta(view({status: 'expired', error: 'worker offline'}), {isAdmin: false})).toMatchObject({label: 'Server did not wake', actions: ['retry']});
  });
});

describe('cardVisible for an admin', () => {
  it('shows the card to everyone, even with nothing behind (Sync is always reachable)', () => {
    const w = cloud({loginState: 'needs_password'});
    const done = {loadedDays: [...LOADED, ...['19', '20', '21', '22', '23', '24', '25', '26'].map((d) => `2026-10-${d}`)]};
    expect(cardVisible(build({heartbeat: w, viewer: {email: ADMIN, isAdmin: true}, ...done}), now)).toBe(true);
    expect(cardVisible(build({heartbeat: w, viewer: {email: 'coop-admin@x.com', isAdmin: true}, ...done}), now)).toBe(true);
    expect(cardVisible(build({heartbeat: w, ...done}), now)).toBe(true);
  });
});

describe('a stored Ready login does not last forever', () => {
  const H = 3600;
  it('older than 24 hours it is unknown: Sync waits for a fresh check, and the card keeps the age', () => {
    const stale = build({heartbeat: cloud({loginCheckedAt: ago(24 * H + 60)})});
    expect(stale.login).toEqual({state: 'unknown', checkedAt: ago(24 * H + 60), ageSeconds: 24 * H + 60, stale: true});
    expect(stale.canSync).toEqual({ok: false, reason: FRESH_CHECK});
    const fresh = build({heartbeat: cloud({loginCheckedAt: ago(24 * H - 60)})});
    expect(fresh.login).toMatchObject({state: 'ready', stale: false});
    expect(fresh.canSync).toMatchObject({ok: true});
  });
  it('says so on the card without pretending it was never checked', () => {
    const s = build({heartbeat: cloud({loginCheckedAt: ago(30 * H)})});
    expect(loginLine(s, now)).toMatchObject({label: 'Check is old', tone: 'neutral', text: 'Last check was 1 day ago'});
  });
  it('a bad login is not made stale: needs_password stays needs_password', () => {
    expect(build({heartbeat: cloud({loginState: 'needs_password', loginCheckedAt: ago(30 * H)})}).login.state).toBe('needs_password');
  });
});

describe('the card before the worker has ever connected', () => {
  it('says plainly that it has not connected: admins get the env and runbook pointer, others "Sync is not set up yet"', () => {
    const none = build({heartbeat: null});
    expect(noWorkerText({...none, isAdmin: true})).toMatch(/cloud worker has not connected yet/);
    expect(noWorkerText({...none, isAdmin: true})).toMatch(/SHOPEE_SYNC_WORKER_TOKEN/);
    expect(noWorkerText({...none, isAdmin: true})).toMatch(/shopee-sync-runbook/);
    expect(noWorkerText(none)).toBe('Sync is not set up yet.');
    expect(noWorkerText(none)).not.toMatch(/SHOPEE_SYNC/);
  });
  it('turns Sync off with the same plain reason, and still shows the card when days are behind', () => {
    const none = build({heartbeat: null});
    expect(syncButton(none)).toMatchObject({disabled: true, reason: 'The cloud worker has not connected yet.'});
    expect(cardVisible(none, now)).toBe(true);
  });
});
