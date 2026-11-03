import {describe, expect, it} from 'vitest';
import {COOLDOWN_MS, DAILY_CAP, isOnline, startBlock, staleSweep, type JobLike} from '../src/shopee-sync/rules';

const at = (phIso: string) => new Date(`${phIso}+08:00`);
const job = (o: Partial<JobLike> = {}): JobLike => ({id: 'j', status: 'done', createdAt: '2026-10-20T00:00:00Z', heartbeatAt: null, ...o});

describe('startBlock', () => {
  const now = at('2026-10-27T14:00:00');
  it('allows a start when nothing stands in the way', () => {
    expect(startBlock(now, [job()])).toBeNull();
  });
  it('blocks while any sync is queued or in flight, team-wide', () => {
    for (const status of ['queued', 'running', 'awaiting_verification', 'importing'] as const) {
      expect(startBlock(now, [job({status, createdAt: '2026-10-27T01:00:00Z'})])).toMatch(/already/i);
    }
  });
  it('blocks inside the 10-minute cooldown after the last sync was created', () => {
    const recent = new Date(now.getTime() - COOLDOWN_MS + 1000).toISOString();
    expect(startBlock(now, [job({createdAt: recent})])).toMatch(/wait/i);
    const old = new Date(now.getTime() - COOLDOWN_MS - 1000).toISOString();
    expect(startBlock(now, [job({createdAt: old})])).toBeNull();
  });
  it('blocks after 6 syncs on the same Philippine day, not on the next', () => {
    const six = Array.from({length: DAILY_CAP}, (_, i) => job({id: `j${i}`, createdAt: `2026-10-27T0${i}:00:00Z`, claimedAt: `2026-10-27T0${i}:01:00Z`})); // PH 08:00..13:00 on the 27th
    expect(startBlock(now, six)).toMatch(/6|daily|today/i);
    expect(startBlock(at('2026-10-28T14:00:00'), six)).toBeNull();
  });
  it('does not count syncs nobody claimed (expired or cancelled while queued) toward the daily limit', () => {
    const six = Array.from({length: DAILY_CAP}, (_, i) => job({id: `j${i}`, status: 'expired', createdAt: `2026-10-27T0${i}:00:00Z`}));
    expect(startBlock(now, six)).toBeNull();
  });
  it('no longer blocks on Monday morning (the weekly export is replaced by Sync)', () => {
    expect(startBlock(at('2026-10-26T09:00:00'), [])).toBeNull();
  });
});

describe('staleSweep', () => {
  const now = at('2026-10-27T14:00:00');
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  it('fails a running job whose heartbeat is older than 10 minutes: worker lost', () => {
    const s = staleSweep(now, [job({id: 'a', status: 'running', heartbeatAt: ago(11)}), job({id: 'b', status: 'running', heartbeatAt: ago(9)})]);
    expect(s).toEqual([{id: 'a', from: 'running', to: 'failed', error: 'worker lost'}]);
  });
  it('covers every in-flight status', () => {
    expect(staleSweep(now, [job({status: 'awaiting_verification', heartbeatAt: ago(30)}), job({id: 'k', status: 'importing', heartbeatAt: ago(30)})])).toHaveLength(2);
  });
  it('expires a queued job unclaimed for more than 30 minutes: worker offline', () => {
    const s = staleSweep(now, [job({id: 'q1', status: 'queued', createdAt: ago(31)}), job({id: 'q2', status: 'queued', createdAt: ago(29)})]);
    expect(s).toEqual([{id: 'q1', from: 'queued', to: 'expired', error: 'worker offline'}]);
  });
  it('leaves finished jobs alone', () => {
    expect(staleSweep(now, [job({status: 'done', heartbeatAt: ago(500)}), job({status: 'failed', heartbeatAt: ago(500)})])).toEqual([]);
  });
});

describe('isOnline', () => {
  const now = at('2026-10-27T14:00:00');
  it('is last seen within 2 minutes', () => {
    expect(isOnline(new Date(now.getTime() - 119_000).toISOString(), now)).toBe(true);
    expect(isOnline(new Date(now.getTime() - 121_000).toISOString(), now)).toBe(false);
    expect(isOnline(null, now)).toBe(false);
  });
});

describe('staleSweep for a job waiting on a sign-in with no awaiting_since', () => {
  it('counts from claimedAt, not the heartbeat that polling keeps fresh, so it still expires after 60 minutes', () => {
    const now = new Date('2026-10-27T06:00:00Z');
    const ago = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
    const waiting = (claimedAt: string) => job({id: 'w', status: 'awaiting_verification', claimedAt, awaitingSince: null, heartbeatAt: ago(1)});
    expect(staleSweep(now, [waiting(ago(61))])).toEqual([expect.objectContaining({id: 'w', to: 'expired'})]);
    expect(staleSweep(now, [waiting(ago(59))])).toEqual([]);
  });
});
