import {describe, expect, it} from 'vitest';
import {cloudLogin, sameEmail} from '../src/shopee-sync/routing';
import type {Heartbeat} from '../src/shopee-sync/types';

const now = new Date('2026-10-27T06:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const hb = (o: Partial<Heartbeat> = {}): Heartbeat => ({lastSeen: ago(1000), loginState: 'ready', loginCheckedAt: ago(1000), remoteReady: false, ...o});

describe('sameEmail', () => {
  it('matches case-insensitively and ignores padding', () => {
    expect(sameEmail(' A@X.com', 'a@x.COM')).toBe(true);
    expect(sameEmail('a@x.com', 'b@x.com')).toBe(false);
  });
});

describe('cloudLogin', () => {
  it('has no worker, and an unknown login, before the first heartbeat', () => {
    expect(cloudLogin(null, now)).toEqual({hasWorker: false, state: 'unknown', checkedAt: null, stale: false});
  });
  it('a worker that has not reported a login yet is unknown', () => {
    expect(cloudLogin(hb({loginState: null, loginCheckedAt: null}), now)).toMatchObject({hasWorker: true, state: 'unknown', stale: false});
  });
  it('reports the stored state, which survives the server sleeping', () => {
    expect(cloudLogin(hb({loginState: 'needs_password'}), now).state).toBe('needs_password');
    expect(cloudLogin(hb({loginState: 'signed_out', lastSeen: ago(3 * 86_400_000)}), now).state).toBe('signed_out');
  });
  it('a Ready check older than 24 hours is unknown and stale, with its time kept', () => {
    const old = ago(25 * 3_600_000);
    expect(cloudLogin(hb({loginCheckedAt: old}), now)).toEqual({hasWorker: true, state: 'unknown', checkedAt: old, stale: true});
    expect(cloudLogin(hb({loginCheckedAt: ago(23 * 3_600_000)}), now).state).toBe('ready');
  });
});
