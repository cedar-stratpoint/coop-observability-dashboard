import {describe, expect, it} from 'vitest';
import {buildSyncStatus} from '../src/shopee-sync/status';
import type {Heartbeat, Job} from '../src/shopee-sync/types';

const now = new Date('2026-10-27T06:00:00Z'); // PH Tuesday 14:00
const LOADED = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
const beat = (o: Partial<Heartbeat> = {}): Heartbeat => ({lastSeen: ago(10), loginState: 'ready', loginCheckedAt: ago(30), remoteReady: false, ...o});
const job = (o: Partial<Job> = {}): Job => ({id: 'j1', requestedBy: 'a@x.com', days: ['2026-10-19'], status: 'done', claimedAt: ago(5000), heartbeatAt: null, importIds: [], error: null, createdAt: ago(5000), finishedAt: ago(4000), progress: {}, awaitingSince: null, ...o});
const REMOTE = 'https://browser.example.com';
const build = (o: Partial<Parameters<typeof buildSyncStatus>[0]> = {}) => buildSyncStatus({viewer: {email: 'a@x.com', isAdmin: false}, now, heartbeat: beat(), remoteUrl: REMOTE, jobs: [], loadedDays: LOADED, ...o});

describe('buildSyncStatus', () => {
  it('has no worker until it has sent a heartbeat', () => {
    const s = build({heartbeat: null});
    expect(s.worker).toBeNull();
    expect(s.workerOnline).toBe(false);
    expect(s.login).toMatchObject({state: 'unknown', checkedAt: null});
    expect(s.canSync).toEqual({ok: false, reason: 'The cloud worker has not connected yet.'});
  });
  it('online means seen within 2 minutes', () => {
    expect(build({heartbeat: beat({lastSeen: ago(119)})})).toMatchObject({workerOnline: true, worker: {state: 'online'}});
    expect(build({heartbeat: beat({lastSeen: ago(121)})})).toMatchObject({workerOnline: false, worker: {state: 'asleep'}});
  });
  it('the remote browser address is for a Coop Admin only', () => {
    expect(build().remoteUrl).toBeNull();
    expect(build({viewer: {email: 'admin@x.com', isAdmin: true}}).remoteUrl).toBe(REMOTE);
    expect(build({viewer: {email: 'admin@x.com', isAdmin: true}, remoteUrl: null}).remoteUrl).toBeNull();
    expect(JSON.stringify(build())).not.toContain('browser.example.com');
  });
  it('lists the missing days and says whether Sync may be pressed', () => {
    const s = build();
    expect(s.missingDays).toHaveLength(8);
    expect(s.canSync).toEqual({ok: true, days: 8});
  });
  it('explains why Sync is off: login not Ready, a sync in flight, up to date', () => {
    expect(build({heartbeat: beat({loginState: 'needs_password'})}).canSync).toMatchObject({ok: false, reason: expect.stringMatching(/admin/)});
    expect(build({jobs: [job({status: 'running', createdAt: ago(60)})]}).canSync).toMatchObject({ok: false, reason: expect.stringMatching(/already/)});
    expect(build({loadedDays: [...LOADED, ...['19', '20', '21', '22', '23', '24', '25', '26'].map((d) => `2026-10-${d}`)]}).canSync).toEqual({ok: false, reason: 'Shopee is up to date'});
  });
  it('currentJob is the queued or running one (team-wide), lastJob the newest finished one', () => {
    const running = job({id: 'r', status: 'running', createdAt: ago(60)});
    const s = build({jobs: [running, job({id: 'old1', createdAt: ago(9000), finishedAt: ago(8000)}), job({id: 'old2', status: 'failed', createdAt: ago(7000), finishedAt: ago(6000)})]});
    expect(s.currentJob).toMatchObject({id: 'r', status: 'running', mine: true});
    expect(s.lastJob?.id).toBe('old2');
  });
  it('a stale queued job shows as expired, not as a blocker, and the server shows as offline', () => {
    const s = build({heartbeat: beat({lastSeen: ago(3600)}), jobs: [job({id: 'q', status: 'queued', createdAt: ago(31 * 60), finishedAt: null})]});
    expect(s.currentJob).toBeNull();
    expect(s.lastJob).toMatchObject({id: 'q', status: 'expired', error: 'worker offline'});
    expect(s.worker?.state).toBe('offline');
  });
});
