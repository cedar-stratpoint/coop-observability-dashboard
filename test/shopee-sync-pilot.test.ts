import {describe, expect, it} from 'vitest';
import {compareDay, summarizePilot, PLACED_TOLERANCE, CONFIRMED_TOLERANCE, PILOT_DAYS} from '../src/shopee-sync/pilot';

const day = (d: string, synced: [number, number], weekly: [number, number]) => compareDay({day: d, synced: {placed: synced[0], confirmed: synced[1]}, weekly: {placed: weekly[0], confirmed: weekly[1]}});

describe('compareDay', () => {
  it('passes when placed is within 1% and confirmed within 5%', () => {
    const r = day('2026-10-19', [10_050, 9_700], [10_000, 10_000]);
    expect(r).toMatchObject({pass: true, placedDeltaPct: 0.5, confirmedDeltaPct: -3});
  });
  it('treats exactly the tolerance as a pass and anything over as a fail', () => {
    expect(PLACED_TOLERANCE).toBe(1);
    expect(CONFIRMED_TOLERANCE).toBe(5);
    expect(day('d', [10_100, 10_000], [10_000, 10_000]).pass).toBe(true);
    const over = day('d', [10_101, 10_000], [10_000, 10_000]);
    expect(over.pass).toBe(false);
    expect(over.reasons).toEqual([expect.stringMatching(/placed/i)]);
    const conf = day('d', [10_000, 9_400], [10_000, 10_000]);
    expect(conf.pass).toBe(false);
    expect(conf.reasons).toEqual([expect.stringMatching(/confirmed/i)]);
  });
  it('fails on either figure moving in either direction and names both when both do', () => {
    expect(day('d', [9_000, 10_000], [10_000, 10_000]).pass).toBe(false);
    expect(day('d', [12_000, 8_000], [10_000, 10_000]).reasons).toHaveLength(2);
  });
  it('a day with no sales on both sides agrees; sales on one side only is a failure, not a divide by zero', () => {
    expect(day('d', [0, 0], [0, 0])).toMatchObject({pass: true, placedDeltaPct: 0, confirmedDeltaPct: 0});
    const r = day('d', [100, 0], [0, 0]);
    expect(r.pass).toBe(false);
    expect(Number.isFinite(r.placedDeltaPct)).toBe(false);
  });
});

describe('summarizePilot', () => {
  const week = (over: Record<string, [number, number]> = {}) =>
    ['19', '20', '21', '22', '23', '24', '25'].map((n) => day(`2026-10-${n}`, over[n]?.[0] !== undefined ? over[n] : [100, 100], [100, 100]));
  it('passes when seven days are compared and every one is within bounds', () => {
    expect(PILOT_DAYS).toBe(7);
    expect(summarizePilot(week())).toMatchObject({pass: true, compared: 7, failedDays: []});
  });
  it('fails and lists the days outside the bounds', () => {
    const s = summarizePilot(week({'22': [130, 100]}));
    expect(s.pass).toBe(false);
    expect(s.failedDays).toEqual(['2026-10-22']);
  });
  it('is not a pass until seven days have been compared', () => {
    const s = summarizePilot(week().slice(0, 5));
    expect(s.pass).toBe(false);
    expect(s.compared).toBe(5);
    expect(s.failedDays).toEqual([]);
  });
});
