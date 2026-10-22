import {describe, expect, it} from 'vitest';
import {adsWeeksToDigests, skuCoverageNotes, skuWeeksToDigests, type AdsWeekRow, type SkuWeekRow} from '../src/shopee-weekly-digests';
import type {DailySalesRow} from '../src/daily-sales-digests';

// FICTIONAL figures. Two campaigns in one week so the ROAS must be a ratio of sums, not an average of ratios.
const ads = (period_from: string, period_to: string, gmv: number, expense: number): AdsWeekRow => ({period_from, period_to, captured_at: '2026-10-21T02:00:00.000Z', gmv, expense});
const sku = (period_from: string, period_to: string, product: string, variation_id: string | null, sales_confirmed: number, units_confirmed = 1): SkuWeekRow =>
  ({period_from, period_to, captured_at: '2026-10-21T02:00:00.000Z', product, variation_id, sales_confirmed, units_confirmed});
const dayRow = (day: string, revenue: number): DailySalesRow => ({day, channel: 'shopee', revenue, orders: 1, units: 1, window_from: `${day}T00:00:00+08:00`, window_to: `${day}T23:59:59+08:00`, captured_at: '2026-10-21T02:00:00.000Z'});
const week = (from: string, perDay: number): DailySalesRow[] => Array.from({length: 7}, (_, i) => dayRow(new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), perDay));

describe('adsWeeksToDigests', () => {
  it('sums spend and divides total ad revenue by total spend (not an average of ratios)', () => {
    // campaign ratios are 9 and 0.33; their average is about 4.67, the ratio of sums is 1000 / 400 = 2.5
    const [d] = adsWeeksToDigests([ads('2026-09-21', '2026-09-27', 900, 100), ads('2026-09-21', '2026-09-27', 100, 300)]);
    expect(d.digest.comparison?.shopee).toMatchObject({adSpend: 400, roas: 2.5});
  });
  it('gives a null ROAS when nothing was spent', () => {
    const [d] = adsWeeksToDigests([ads('2026-09-21', '2026-09-27', 0, 0)]);
    expect(d.digest.comparison?.shopee).toMatchObject({adSpend: 0, roas: null});
  });
  it('makes one digest per week, placed by its own dates (PH midnight, end exclusive)', () => {
    const out = adsWeeksToDigests([ads('2026-09-21', '2026-09-27', 10, 5), ads('2026-09-28', '2026-10-04', 10, 5)]);
    expect(out).toHaveLength(2);
    expect(out[0].window_from).toBe('2026-09-20T16:00:00.000Z');
    expect(out[0].window_to).toBe('2026-09-27T16:00:00.000Z');
    expect(out[0].digest.shopee?.ads?.window).toMatchObject({from: '2026-09-21', to: '2026-09-27'});
  });
});

describe('skuWeeksToDigests', () => {
  it('lists the product-level rows only, never the variation rows under them', () => {
    const [d] = skuWeeksToDigests([sku('2026-09-21', '2026-09-27', 'Product A', null, 500, 5), sku('2026-09-21', '2026-09-27', 'Product A', 'v1', 300, 3), sku('2026-09-21', '2026-09-27', 'Product A', 'v2', 200, 2), sku('2026-09-21', '2026-09-27', 'Product B', null, 100, 1)]);
    expect(d.digest.shopee?.sales?.topProducts).toEqual([{title: 'Product A', revenue: 500, units: 5}, {title: 'Product B', revenue: 100, units: 1}]);
  });
});

describe('skuCoverageNotes', () => {
  const rows = (listed: number): SkuWeekRow[] => [sku('2026-09-21', '2026-09-27', 'Product A', null, listed), sku('2026-09-21', '2026-09-27', 'Product A', 'v1', listed)];
  it('says how much of the week the list covers when it is below 100%', () => {
    const notes = skuCoverageNotes(rows(560), week('2026-09-21', 100), '2026-09-21', '2026-09-27'); // 560 of 700
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('80%');
    expect(notes[0]).toContain('top performing');
  });
  it('is silent at 100%', () => {
    expect(skuCoverageNotes(rows(700), week('2026-09-21', 100), '2026-09-21', '2026-09-27')).toEqual([]);
  });
  it('is silent when a day of the week has no sales figure (coverage cannot be known)', () => {
    expect(skuCoverageNotes(rows(560), week('2026-09-21', 100).slice(1), '2026-09-21', '2026-09-27')).toEqual([]);
  });
  it('ignores weeks that are not wholly inside the dates', () => {
    expect(skuCoverageNotes(rows(560), week('2026-09-21', 100), '2026-09-23', '2026-10-04')).toEqual([]);
  });
});
