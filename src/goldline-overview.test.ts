import {describe, it, expect} from 'vitest';
import {buildOverview, comparablePeriods, deltaPct, greetingFor, periodDays, UNCATEGORIZED, type OverviewSaleRow} from './goldline-overview';

const row = (sku: string, net: number, start: string, end: string, extra: Partial<OverviewSaleRow> = {}): OverviewSaleRow => ({
  sku_code: sku,
  net,
  gross: net * 1.12,
  units: 1,
  period_start: start,
  period_end: end,
  ...extra,
});

describe('buildOverview', () => {
  it('is empty-safe', () => {
    const o = buildOverview([], new Map());
    expect(o.hasSales).toBe(false);
    expect(o.hasPrior).toBe(false);
    expect(o.net).toEqual({current: 0, prior: null, deltaPct: null});
    expect(o.categories).toEqual([]);
    expect(o.window).toEqual({start: null, end: null});
  });

  it('uses the latest period as the window and the one before it for deltas', () => {
    const rows = [
      row('A', 100, '2026-09-01', '2026-09-15'),
      row('A', 150, '2026-09-16', '2026-09-30'),
      row('B', 50, '2026-09-16', '2026-09-30'),
    ];
    const o = buildOverview(rows, new Map());
    expect(o.window).toEqual({start: '2026-09-16', end: '2026-09-30'});
    expect(o.net.current).toBe(200);
    expect(o.net.prior).toBe(100);
    expect(o.net.deltaPct).toBe(100);
    expect(o.units.current).toBe(2);
    expect(o.hasPrior).toBe(true);
  });

  it('hides deltas when the prior period is not like-for-like', () => {
    // A month-to-date file after a semi-monthly one: not comparable.
    const rows = [row('A', 100, '2026-09-16', '2026-09-30'), row('A', 40, '2026-10-01', '2026-10-05')];
    const o = buildOverview(rows, new Map());
    expect(o.window).toEqual({start: '2026-10-01', end: '2026-10-05'});
    expect(o.hasPrior).toBe(true);
    expect(o.priorComparable).toBe(false);
    expect(o.net).toEqual({current: 40, prior: null, deltaPct: null});
  });

  it('has no delta with a single period', () => {
    const o = buildOverview([row('A', 100, '2026-09-01', '2026-09-15')], new Map());
    expect(o.hasPrior).toBe(false);
    expect(o.net.deltaPct).toBeNull();
  });

  it('rolls SKUs into product lines; unmapped go to Uncategorized, always last', () => {
    const lines = new Map([
      ['A', 'Two Way Cake'],
      ['B', 'BB Cream'],
    ]);
    const rows = [
      row('A', 100, '2026-09-16', '2026-09-30'),
      row('B', 300, '2026-09-16', '2026-09-30'),
      row('X', 900, '2026-09-16', '2026-09-30'),
      row('Y', 10, '2026-09-16', '2026-09-30'),
      row('A', 999, '2026-09-01', '2026-09-15'), // prior period: excluded from categories
    ];
    const o = buildOverview(rows, lines);
    expect(o.categories.map((c) => c.name)).toEqual(['BB Cream', 'Two Way Cake', UNCATEGORIZED]);
    expect(o.categories.find((c) => c.uncategorized)?.net).toBe(910);
    expect(o.unmappedSkus).toBe(2);
  });
});

describe('deltaPct', () => {
  it('rounds to one decimal and is null without a usable prior', () => {
    expect(deltaPct(106.4, 100)).toBe(6.4);
    expect(deltaPct(90, 100)).toBe(-10);
    expect(deltaPct(5, 0)).toBeNull();
    expect(deltaPct(5, null)).toBeNull();
  });
});

describe('greetingFor', () => {
  it('splits the day', () => {
    expect(greetingFor(8)).toBe('Good morning');
    expect(greetingFor(13)).toBe('Good afternoon');
    expect(greetingFor(20)).toBe('Good evening');
  });
});

describe('comparablePeriods', () => {
  it('accepts adjacent semi-monthly halves of slightly different length', () => {
    expect(comparablePeriods({start: '2026-09-16', end: '2026-09-30'}, {start: '2026-09-01', end: '2026-09-15'})).toBe(true);
    expect(comparablePeriods({start: '2026-03-01', end: '2026-03-15'}, {start: '2026-02-16', end: '2026-02-28'})).toBe(true);
  });
  it('rejects overlap, very different lengths, and missing dates', () => {
    expect(comparablePeriods({start: '2026-09-10', end: '2026-09-30'}, {start: '2026-09-01', end: '2026-09-15'})).toBe(false);
    expect(comparablePeriods({start: '2026-10-01', end: '2026-10-05'}, {start: '2026-09-16', end: '2026-09-30'})).toBe(false);
    expect(comparablePeriods({start: null, end: '2026-09-30'}, {start: '2026-09-01', end: '2026-09-15'})).toBe(false);
  });
  it('periodDays is inclusive', () => {
    expect(periodDays('2026-09-01', '2026-09-15')).toBe(15);
    expect(periodDays(null, '2026-09-15')).toBeNull();
  });
});
