import {describe, expect, it} from 'vitest';
import {buildSyncStatus} from '../src/shopee-sync/status';
import type {Job, Worker} from '../src/shopee-sync/types';

const now = new Date('2026-10-27T06:00:00Z'); // PH Tuesday 14:00
const LOADED = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
const worker = (o: Partial<Worker> = {}): Worker => ({id: 'w1', ownerEmail: 'a@x.com', name: 'Dave Mac', tokenHash: 'h', lastSeen: ago(10), sessionState: 'ready', createdAt: ago(9999), revokedAt: null, loginState: null, loginCheckedAt: null, remoteReady: false, remoteUrl: null, isCloud: false, ...o});
const job = (o: Partial<Job> = {}): Job => ({id: 'j1', requestedBy: 'a@x.com', days: ['2026-10-19'], status: 'done', claimedBy: 'w1', claimedAt: ago(5000), heartbeatAt: null, importIds: [], error: null, createdAt: ago(5000), finishedAt: ago(4000), progress: {}, awaitingSince: null, ...o});
const build = (o: Partial<Parameters<typeof buildSyncStatus>[0]> = {}) => buildSyncStatus({viewer: {email: 'a@x.com', isAdmin: false}, now, workers: [worker()], jobs: [], loadedDays: LOADED, ...o});

describe('buildSyncStatus', () => {
  it('shows only the viewer\'s own Macs (never a token hash), admins see everyone\'s, revoked ones never', () => {
    const ws = [worker(), worker({id: 'w2', ownerEmail: 'b@x.com', name: 'Bea Mac'}), worker({id: 'w3', revokedAt: ago(1)})];
    expect(build({workers: ws}).workers.map((w) => w.id)).toEqual(['w1']);
    const all = build({workers: ws, viewer: {email: 'admin@x.com', isAdmin: true}}).workers;
    expect(all.map((w) => w.id)).toEqual(['w1', 'w2']);
    expect(all[1]).toMatchObject({own: false, ownerEmail: 'b@x.com'});
    expect(JSON.stringify(all)).not.toContain('tokenHash');
  });
  it('online means seen within 2 minutes', () => {
    expect(build({workers: [worker({lastSeen: ago(119)})]}).workers[0].online).toBe(true);
    expect(build({workers: [worker({lastSeen: ago(121)})]}).workers[0].online).toBe(false);
  });
  it('lists the missing days and says whether Sync may be pressed', () => {
    const s = build();
    expect(s.missingDays).toHaveLength(8);
    expect(s.canSync).toEqual({ok: true, days: 8});
    expect(s.canAddMac).toEqual({ok: true});
  });
  it('explains why Sync is off: no ready Mac, a sync in flight, up to date', () => {
    expect(build({workers: [worker({sessionState: 'signed_out'})]}).canSync).toMatchObject({ok: false, reason: expect.stringMatching(/Add a Mac/)});
    expect(build({jobs: [job({status: 'running', createdAt: ago(60)})]}).canSync).toMatchObject({ok: false, reason: expect.stringMatching(/already/)});
    expect(build({loadedDays: [...LOADED, ...['19', '20', '21', '22', '23', '24', '25', '26'].map((d) => `2026-10-${d}`)]}).canSync).toEqual({ok: false, reason: 'Shopee is up to date'});
  });
  it('currentJob is the queued or running one (team-wide), lastJob the newest finished one', () => {
    const running = job({id: 'r', status: 'running', claimedBy: 'w1', createdAt: ago(60)});
    const s = build({jobs: [running, job({id: 'old1', createdAt: ago(9000), finishedAt: ago(8000)}), job({id: 'old2', status: 'failed', createdAt: ago(7000), finishedAt: ago(6000)})]});
    expect(s.currentJob).toMatchObject({id: 'r', status: 'running', workerName: 'Dave Mac', mine: true});
    expect(s.lastJob?.id).toBe('old2');
  });
  it('a stale queued job shows as expired, not as a blocker', () => {
    const s = build({jobs: [job({id: 'q', status: 'queued', claimedBy: null, createdAt: ago(31 * 60)})]});
    expect(s.currentJob).toBeNull();
    expect(s.lastJob).toMatchObject({id: 'q', status: 'expired', error: 'worker offline'});
  });
  it('caps are reported for the Add a Mac button', () => {
    const two = [worker(), worker({id: 'w2'})];
    expect(build({workers: two}).canAddMac).toMatchObject({ok: false});
  });
});
