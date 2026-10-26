import {describe, expect, it} from 'vitest';
import {COOLDOWN_MS, DAILY_CAP, isOnline, inQuietWindow, startBlock, staleSweep, type JobLike} from '../src/shopee-sync/rules';

const at = (phIso: string) => new Date(`${phIso}+08:00`);
const job = (o: Partial<JobLike> = {}): JobLike => ({id: 'j', status: 'done', createdAt: '2026-10-20T00:00:00Z', heartbeatAt: null, ...o});

describe('quiet window', () => {
  it('is Monday 08:30 to 11:00 Manila time', () => {
    expect(inQuietWindow(at('2026-10-26T08:29:59'))).toBe(false);
    expect(inQuietWindow(at('2026-10-26T08:30:00'))).toBe(true);
    expect(inQuietWindow(at('2026-10-26T10:59:59'))).toBe(true);
    expect(inQuietWindow(at('2026-10-26T11:00:00'))).toBe(false);
    expect(inQuietWindow(at('2026-10-27T09:00:00'))).toBe(false); // Tuesday
  });
});

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
    const six = Array.from({length: DAILY_CAP}, (_, i) => job({id: `j${i}`, createdAt: `2026-10-27T0${i}:00:00Z`})); // PH 08:00..13:00 on the 27th
    expect(startBlock(now, six)).toMatch(/6|daily|today/i);
    expect(startBlock(at('2026-10-28T14:00:00'), six)).toBeNull();
  });
  it('blocks in the Monday quiet window', () => {
    expect(startBlock(at('2026-10-26T09:00:00'), [])).toMatch(/monday|quiet/i);
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
