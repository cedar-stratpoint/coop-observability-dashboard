import {describe, expect, it} from 'vitest';
import {periodIsWindow} from '../src/shopee-import/api';
import {MAX_WINDOWS, windowPlan, windowsFor} from '../src/shopee-sync/windows';

// 2026-10-26 is a Monday. "now" = Tue 27 Oct 12:00 PH, so yesterday Y = Mon 26 Oct and past 7 = 20..26 Oct.
const at = (phIso: string) => new Date(`${phIso}+08:00`);
const NOW = at('2026-10-27T12:00:00');
const range = (from: string, n: number) => Array.from({length: n}, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
const DAILY = ['sales_overview', 'traffic', 'product_overview'];
const FIVE = ['sales_overview', 'traffic', 'product_overview', 'ads', 'sku_detail'];

describe('windowsFor', () => {
  it('all days inside the last 7: one past7 window with the 3 daily files', () => {
    expect(windowsFor(range('2026-10-20', 7), NOW)).toEqual([{kind: 'past7', from: '2026-10-20', to: '2026-10-26', files: DAILY}]);
  });
  it('a refresh job (one latest closed day) is a single past7', () => {
    expect(windowsFor(['2026-10-26'], NOW)).toEqual([{kind: 'past7', from: '2026-10-20', to: '2026-10-26', files: DAILY}]);
  });
  it('the current incomplete week stays inside past7 (never a week window, so no Ads or SKU)', () => {
    const w = windowsFor(['2026-10-26'], at('2026-10-28T12:00:00')); // Y = Tue 27 Oct
    expect(w.map((x) => x.kind)).toEqual(['past7']);
    expect(windowsFor(['2026-10-26', '2026-10-27'], at('2026-10-28T12:00:00'))[0]).toMatchObject({from: '2026-10-21', to: '2026-10-27'});
  });
  it('a gap across two older weeks plus the last 7: two weeks (all five files), then past7 last', () => {
    const days = ['2026-10-07', '2026-10-14', '2026-10-15', '2026-10-21'];
    expect(windowsFor(days, NOW)).toEqual([
      {kind: 'week', from: '2026-10-05', to: '2026-10-11', files: FIVE},
      {kind: 'week', from: '2026-10-12', to: '2026-10-18', files: FIVE},
      {kind: 'past7', from: '2026-10-20', to: '2026-10-26', files: DAILY},
    ]);
  });
  it('a week window is one per week, however many of its days are missing', () => {
    expect(windowsFor(range('2026-10-05', 5), NOW)).toHaveLength(1);
  });
  it('older days: one week per week (the By Week reach itself is missing-days.ts REACHABLE_DAYS)', () => {
    const w = windowsFor(['2026-09-23'], NOW);
    expect(w).toEqual([{kind: 'week', from: '2026-09-21', to: '2026-09-27', files: FIVE}]);
  });
  it('a 31-day input spanning 5 weeks is capped at 4 windows, oldest kept, the newest dropped and reported', () => {
    const days = range('2026-09-25', 31); // 25 Sep .. 25 Oct
    const p = windowPlan(days, NOW);
    expect(MAX_WINDOWS).toBe(4);
    expect(p.windows).toHaveLength(4);
    expect(p.windows.map((w) => w.from)).toEqual(['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12']);
    expect(p.dropped).toEqual(range('2026-10-19', 7)); // 19..25 Oct: the week of 19 Oct and the past7 window are both over the cap
    expect(windowsFor(days, NOW)).toEqual(p.windows);
  });
  it('under the cap nothing is dropped', () => {
    expect(windowPlan(['2026-10-07', '2026-10-21'], NOW).dropped).toEqual([]);
  });
  it('an empty list has no windows', () => {
    expect(windowsFor([], NOW)).toEqual([]);
  });
  it('cross-midnight: the same days give different past7 windows an hour apart, so validation takes the union', () => {
    const before = at('2026-10-27T23:30:00');
    const after = at('2026-10-28T00:30:00');
    expect(windowsFor(['2026-10-26'], before)[0]).toMatchObject({from: '2026-10-20', to: '2026-10-26'});
    expect(windowsFor(['2026-10-26'], after)[0]).toMatchObject({from: '2026-10-21', to: '2026-10-27'});
  });
});

describe('periodIsWindow', () => {
  const windows = windowsFor(['2026-10-07', '2026-10-21'], NOW);
  it('accepts a period equal to an issued window with a type that window allows', () => {
    expect(periodIsWindow('2026-10-05', '2026-10-11', windows)).toBe(true);
    expect(periodIsWindow('2026-10-05', '2026-10-11', windows, 'ads')).toBe(true);
    expect(periodIsWindow('2026-10-20', '2026-10-26', windows, 'traffic')).toBe(true);
  });
  it('refuses ads and sku_detail for a past7 window', () => {
    expect(periodIsWindow('2026-10-20', '2026-10-26', windows, 'ads')).toBe(false);
    expect(periodIsWindow('2026-10-20', '2026-10-26', windows, 'sku_detail')).toBe(false);
  });
  it('refuses a period that is only inside a window, only overlapping, or not issued', () => {
    expect(periodIsWindow('2026-10-06', '2026-10-11', windows)).toBe(false);
    expect(periodIsWindow('2026-10-05', '2026-10-12', windows)).toBe(false);
    expect(periodIsWindow('2026-10-21', '2026-10-21', windows)).toBe(false);
    expect(periodIsWindow('2026-10-12', '2026-10-18', windows)).toBe(false);
  });
  it('refuses a missing period, no windows, and an unknown type', () => {
    expect(periodIsWindow(null, null, windows)).toBe(false);
    expect(periodIsWindow('2026-10-05', undefined, windows)).toBe(false);
    expect(periodIsWindow('2026-10-05', '2026-10-11', [])).toBe(false);
    expect(periodIsWindow('2026-10-05', '2026-10-11', windows, null)).toBe(false);
  });
});
