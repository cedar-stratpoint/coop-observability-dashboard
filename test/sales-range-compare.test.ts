import {describe, expect, it} from 'vitest';
import {addDaysKey} from '../src/chat/range';
import {buildSalesRange, previousSpan} from '../src/sales-range';
import {compareSpans, pctLabel} from '../src/sales-range-compare';
import {buildSeries} from '../src/sales-range-series';
import {cmp, digestRow, phMidnight, series} from './support/channel-report-fixture';

const MONDAYS = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12'];
const bounds = {firstDay: '2026-09-07', todayDay: '2026-10-20'};

// One weekly digest per Monday. Per-day sales grow 10% a week; Shopee's ad export carries its own (same Monday to Sunday) dates.
function week(i: number, over: {skipLazada?: boolean; noAds?: boolean} = {}) {
  const m = MONDAYS[i];
  const sun = addDaysKey(m, 6);
  const perDay = 100 * (1 + 0.1 * i);
  const row = digestRow(phMidnight(m), phMidnight(addDaysKey(m, 7)), `${addDaysKey(m, 7)}T01:00:00.000Z`, {
    daily: {shopee: series(m, sun, perDay, 1, 2), ...(over.skipLazada ? {} : {lazada: series(m, sun, perDay, 1, 2)})},
    comparison: {
      shopee: {...cmp(perDay * 7, 7, 14), adSpend: over.noAds ? null : 200 + i * 10, roas: over.noAds ? null : 2 + i * 0.1},
      lazada: {...cmp(perDay * 7, 7, 14), adSpend: over.noAds ? null : 300, roas: over.noAds ? null : 3},
    },
  });
  if (over.skipLazada) delete row.digest.comparison!.lazada; // no per-day sales and no whole-window total either
  (row.digest as unknown as Record<string, unknown>).shopee = {ads: {headline: '', figures: [], recommendations: [], window: {from: m, to: sun, label: ''}}};
  return row;
}
const all = (over?: Parameters<typeof week>[1]) => MONDAYS.map((_, i) => week(i, over));
const build = (span: {from?: string; to?: string; span?: string}, digests = all()) =>
  buildSalesRange({span, digests: digests as never, website: null, offline: null, ...bounds});
const CH = ['shopee', 'lazada', 'website', 'offline'] as const;

describe('previousSpan', () => {
  it('is the span of the same length directly before', () => {
    expect(previousSpan('2026-10-05', '2026-10-18', '2026-09-07')).toEqual({fromDay: '2026-09-21', toDay: '2026-10-04'});
    expect(previousSpan('2026-10-18', '2026-10-18', '2026-09-07')).toEqual({fromDay: '2026-10-17', toDay: '2026-10-17'});
  });
  it('is null when it would start before the first day with data', () => {
    expect(previousSpan('2026-09-14', '2026-10-04', '2026-09-07')).toBeNull();
    expect(previousSpan('2026-09-07', '2026-10-20', '2026-09-07')).toBeNull(); // all time
  });
});

describe('compareSpans: only when the two spans can be compared fairly', () => {
  const view = build({from: '2026-10-05', to: '2026-10-18'});

  it('the view carries the span before, with the dates named', () => {
    expect(view.previous).toMatchObject({fromDay: '2026-09-21', toDay: '2026-10-04', label: 'Sep 21 to Oct 4, 2026'});
  });

  it('percent change on revenue and orders, up is good', () => {
    const c = compareSpans(view, view.previous!, CH);
    expect(c.sales).toEqual({ok: true, reason: null});
    // current weeks 4,5 (140, 150 a day) vs previous weeks 2,3 (120, 130 a day), two channels
    expect(c.deltas.revenue).toMatchObject({cur: 4060, prev: 3500, pct: 16, direction: 'up', tone: 'good'});
    expect(c.deltas.orders).toMatchObject({cur: 28, prev: 28, direction: 'flat', tone: 'neutral'});
  });

  it('ad spend change is shown but never coloured good or bad', () => {
    const c = compareSpans(view, view.previous!, CH);
    expect(c.ads).toEqual({ok: true, reason: null});
    expect(c.deltas.adSpend).toMatchObject({direction: 'up', tone: 'neutral'});
    expect(c.deltas.roas.tone).toBe('good');
  });

  it('follows the channel chips', () => {
    const c = compareSpans(view, view.previous!, ['shopee']);
    expect(c.deltas.revenue).toMatchObject({cur: 2030, prev: 1750});
  });

  it('says why, and shows no change, when a channel has figures in only one of the spans', () => {
    const v = build({from: '2026-10-05', to: '2026-10-18'}, MONDAYS.map((_, i) => week(i, {skipLazada: i < 4})));
    const c = compareSpans(v, v.previous!, CH);
    expect(c.sales.ok).toBe(false);
    expect(c.sales.reason).toContain('Lazada');
    expect(c.deltas.revenue).toMatchObject({pct: null, direction: null});
  });

  it('shows no ad change when ad figures only partly cover one of the spans', () => {
    const v = build({from: '2026-10-05', to: '2026-10-18'}, MONDAYS.map((_, i) => week(i, {noAds: i < 4})));
    const c = compareSpans(v, v.previous!, CH);
    expect(c.sales.ok).toBe(true); // sales are still fine
    expect(c.ads.ok).toBe(false);
    expect(c.deltas.adSpend.pct).toBeNull();
  });

  it('a previous value of zero gives no percent, not infinity', () => {
    const zero = {...view.previous!, channels: view.previous!.channels.map((c) => (c.revenue === null ? c : {...c, revenue: 0}))};
    expect(compareSpans(view, zero, CH).deltas.revenue.pct).toBeNull();
  });
});

describe('compareSpans: more ways a change could be unfair', () => {
  const view = build({from: '2026-10-05', to: '2026-10-18'});

  it('no change when the span reaches today, because today is not finished', () => {
    const v = {...view, toDay: view.bounds.max};
    const c = compareSpans(v, view.previous!, CH);
    expect(c.sales.ok).toBe(false);
    expect(c.sales.reason).toContain('Today is not finished');
    expect(c.deltas.revenue.pct).toBeNull();
  });

  it('no ROAS change when the two spans have ROAS for different channels', () => {
    const noLazadaRoas = {...view.previous!, ads: {...view.previous!.ads, lazada: {...view.previous!.ads.lazada, roas: null}}};
    const c = compareSpans(view, noLazadaRoas, CH);
    expect(c.ads.ok).toBe(true);
    expect(c.roas.ok).toBe(false);
    expect(c.deltas.roas.pct).toBeNull();
    expect(c.deltas.adSpend.pct).not.toBeNull(); // spend is still comparable
  });

  it('explains itself when the earlier span had no sales', () => {
    const zero = {...view.previous!, channels: view.previous!.channels.map((c) => (c.revenue === null ? c : {...c, revenue: 0, orders: 0}))};
    const c = compareSpans(view, zero, CH);
    expect(c.note).toContain('no sales');
    expect(c.deltas.revenue.pct).toBeNull();
  });
});

describe('pctLabel: the number shown is the number behind the arrow', () => {
  const d = (pct: number | null, direction: 'up' | 'down' | 'flat' | null) => ({pct, direction});
  it('keeps one decimal and drops a trailing zero', () => {
    expect(pctLabel(d(16, 'up'))).toBe('16%');
    expect(pctLabel(d(15.34, 'up'))).toBe('15.3%');
    expect(pctLabel(d(-1.5, 'down'))).toBe('1.5%');
    expect(pctLabel(d(9.96, 'up'))).toBe('10%');
  });
  it('flat is 0%, and nothing is shown without a number', () => {
    expect(pctLabel(d(0.2, 'flat'))).toBe('0%');
    expect(pctLabel(d(null, null))).toBe('');
  });
});

describe('buildSeries: weekly and monthly buckets, partial ones flagged', () => {
  const input = (fromDay: string, toDay: string) => ({fromDay, toDay, digests: all() as never, website: null, offline: null});

  it('whole weeks are not clipped', () => {
    const s = buildSeries(input('2026-10-05', '2026-10-18'));
    expect(s.week.map((b) => [b.short, b.clipped])).toEqual([['Oct 5', false], ['Oct 12', false]]);
  });
  it('a span that cuts weeks flags the first and last bucket as clipped', () => {
    const s = buildSeries(input('2026-10-07', '2026-10-20'));
    expect(s.week.map((b) => b.clipped)).toEqual([true, false, true]);
  });
  it('a month is clipped unless the span covers all of it', () => {
    const s = buildSeries(input('2026-09-07', '2026-10-18'));
    expect(s.month.map((b) => [b.short, b.clipped])).toEqual([['Sep', true], ['Oct', true]]);
  });
  it('carries each channel with its status so the page can flag partial buckets', () => {
    const s = buildSeries(input('2026-10-05', '2026-10-11'));
    expect(s.week[0].channels.map((c) => c.channel)).toEqual(['shopee', 'lazada', 'website', 'offline']);
    expect(s.week[0].channels[0]).toMatchObject({status: 'ok', revenue: 980}); // week of Oct 5: 140 a day for 7 days
  });
  it('gives no weekly series for a very long span (months only)', () => {
    const s = buildSeries(input('2024-01-01', '2026-10-18'));
    expect(s.week).toEqual([]);
    expect(s.month.length).toBeGreaterThan(20);
  });
});
