import {describe, expect, it} from 'vitest';
import {periodIsWindow} from '../src/shopee-import/api';
import {MAX_DAY_WINDOWS, MAX_WEEK_WINDOWS, windowPlan, windowsFor} from '../src/shopee-sync/windows';

// "now" = Tue 27 Oct 12:00 PH, so yesterday Y = Mon 26 Oct (a Monday: the week of 26 Oct is open).
const at = (phIso: string) => new Date(`${phIso}+08:00`);
const NOW = at('2026-10-27T12:00:00');
const range = (from: string, n: number) => Array.from({length: n}, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
const SALES = ['sales_overview'];
const FIVE = ['sales_overview', 'traffic', 'product_overview', 'ads', 'sku_detail'];
const day = (d: string) => ({kind: 'day', from: d, to: d, files: SALES});

describe('windowsFor', () => {
  it('all 7 days of a closed week missing: one week window with the 5 files', () => {
    expect(windowsFor(range('2026-10-19', 7), NOW)).toEqual([{kind: 'week', from: '2026-10-19', to: '2026-10-25', files: FIVE}]);
  });
  it('a refresh job (one latest closed day) is a single day window, sales only', () => {
    expect(windowsFor(['2026-10-26'], NOW)).toEqual([day('2026-10-26')]);
  });
  it('the open current week is one day window per day (never a week, so no Ads or SKU)', () => {
    const w = windowsFor(['2026-10-26', '2026-10-27'], at('2026-10-28T12:00:00')); // Y = Tue 27 Oct
    expect(w).toEqual([day('2026-10-26'), day('2026-10-27')]);
  });
  it('a week with only some days missing is one day window per missing day', () => {
    expect(windowsFor(['2026-10-20', '2026-10-22'], NOW)).toEqual([day('2026-10-20'), day('2026-10-22')]);
  });
  it('a week whose 7 days are missing but whose Sunday is after yesterday is days, not a week', () => {
    expect(windowsFor(range('2026-10-19', 6), at('2026-10-25T12:00:00')).map((w) => w.kind)).toEqual(Array(6).fill('day')); // Y = Sat 24 Oct
  });
  it('a full missing week plus a partial one: the week first (all five files), then the days', () => {
    const days = [...range('2026-10-12', 7), '2026-10-20', '2026-10-21', '2026-10-26'];
    expect(windowsFor(days, NOW)).toEqual([{kind: 'week', from: '2026-10-12', to: '2026-10-18', files: FIVE}, day('2026-10-20'), day('2026-10-21'), day('2026-10-26')]);
  });
  it('a week window is one per week', () => {
    expect(windowsFor(range('2026-10-05', 14), NOW).map((w) => w.from)).toEqual(['2026-10-05', '2026-10-12']);
  });
  it('days are capped at 7, nearest to today kept, the older ones dropped and reported', () => {
    const days = ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-20'];
    const p = windowPlan(days, NOW);
    expect(MAX_DAY_WINDOWS).toBe(7);
    expect(p.windows.map((w) => w.from)).toEqual(days.slice(2));
    expect(p.dropped).toEqual(days.slice(0, 2));
  });
  it('weeks are capped at 4, nearest to today kept, the oldest dropped and reported', () => {
    const days = range('2026-09-21', 35); // 21 Sep .. 25 Oct: five full weeks
    const p = windowPlan(days, NOW);
    expect(MAX_WEEK_WINDOWS).toBe(4);
    expect(p.windows.map((w) => w.from)).toEqual(['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19']);
    expect(p.dropped).toEqual(range('2026-09-21', 7));
    expect(windowsFor(days, NOW)).toEqual(p.windows);
  });
  it('days after yesterday are never in a window', () => {
    expect(windowPlan(['2026-10-27'], NOW)).toEqual({windows: [], dropped: ['2026-10-27']});
  });
  it('under the caps nothing is dropped', () => {
    expect(windowPlan(['2026-10-07', '2026-10-21'], NOW).dropped).toEqual([]);
  });
  it('an empty list has no windows', () => {
    expect(windowsFor([], NOW)).toEqual([]);
  });
  it('the windows of a closed week do not depend on the clock, so validation at creation and at call time agree', () => {
    const days = range('2026-10-12', 7);
    expect(windowsFor(days, at('2026-10-27T23:30:00'))).toEqual(windowsFor(days, at('2026-10-28T00:30:00')));
  });
});

describe('periodIsWindow', () => {
  const windows = windowsFor([...range('2026-10-05', 7), '2026-10-21'], NOW);
  it('accepts a period equal to an issued window with a type that window allows', () => {
    expect(periodIsWindow('2026-10-05', '2026-10-11', windows)).toBe(true);
    expect(periodIsWindow('2026-10-05', '2026-10-11', windows, 'ads')).toBe(true);
    expect(periodIsWindow('2026-10-21', '2026-10-21', windows, 'sales_overview')).toBe(true);
  });
  it('refuses every type but sales_overview for a day window', () => {
    for (const t of ['traffic', 'product_overview', 'ads', 'sku_detail'] as const) expect(periodIsWindow('2026-10-21', '2026-10-21', windows, t)).toBe(false);
  });
  it('refuses a period that is only inside a window, only overlapping, or not issued', () => {
    expect(periodIsWindow('2026-10-06', '2026-10-11', windows)).toBe(false);
    expect(periodIsWindow('2026-10-05', '2026-10-12', windows)).toBe(false);
    expect(periodIsWindow('2026-10-21', '2026-10-22', windows)).toBe(false);
    expect(periodIsWindow('2026-10-12', '2026-10-18', windows)).toBe(false);
  });
  it('refuses a missing period, no windows, and an unknown type', () => {
    expect(periodIsWindow(null, null, windows)).toBe(false);
    expect(periodIsWindow('2026-10-05', undefined, windows)).toBe(false);
    expect(periodIsWindow('2026-10-05', '2026-10-11', [])).toBe(false);
    expect(periodIsWindow('2026-10-05', '2026-10-11', windows, null)).toBe(false);
  });
});
