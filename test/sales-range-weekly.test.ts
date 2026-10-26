import {describe, expect, it} from 'vitest';
import {buildSalesRange} from '../src/sales-range';
import {adsWeeksToDigests, skuWeeksToDigests} from '../src/shopee-weekly-digests';
import {cmp, digestRow, phMidnight, series} from './support/channel-report-fixture';
import {addDaysKey} from '../src/chat/range';

// Tue 20 Oct 2026 (PH). FICTIONAL figures throughout.
const bounds = {firstDay: '2026-09-01', todayDay: '2026-10-20'};
const CREATED = '2026-10-21T02:00:00.000Z';
const ads = (from: string, to: string, gmv: number, expense: number, captured_at = CREATED) => ({period_from: from, period_to: to, captured_at, gmv, expense});
const sku = (from: string, to: string, product: string, sales: number, units: number, variation: string | null = null) =>
  ({period_from: from, period_to: to, captured_at: CREATED, product, variation_id: variation, sales_confirmed: sales, units_confirmed: units});

// A stored digest for the same Monday to Sunday that already has its own (older) ad window.
const oldWeek = (from: string, to: string, created: string, spend: number, roas: number) => {
  const row = digestRow(phMidnight(from), phMidnight(addDaysKey(to, 1)), created, {
    daily: {shopee: series(from, to, 100, 1, 2)},
    comparison: {shopee: {...cmp(700, 7, 14), adSpend: spend, roas}},
  });
  (row.digest as unknown as Record<string, unknown>).shopee = {ads: {headline: '', figures: [], recommendations: [], window: {from, to, label: ''}}};
  return row;
};

const adWeeks = adsWeeksToDigests([ads('2026-10-05', '2026-10-11', 600, 200), ads('2026-10-12', '2026-10-18', 900, 300)]);
const base = {digests: [oldWeek('2026-10-05', '2026-10-11', '2026-10-12T01:00:00.000Z', 50, 1)], website: null, offline: null, ...bounds};

describe('buildSalesRange with imported weekly Shopee reports', () => {
  it('shows ad spend and ROAS for a span that wholly contains imported ad weeks', () => {
    const v = buildSalesRange({...base, span: {from: '2026-10-05', to: '2026-10-18'}, weeklyDigests: adWeeks});
    expect(v.ads.shopee).toMatchObject({spend: 500, roas: 3}); // (600 + 900) / (200 + 300)
    expect(v.ads.shopee.windows).toHaveLength(2);
  });
  it('says "none" when an imported week is only partly inside the dates', () => {
    const v = buildSalesRange({...base, digests: [], span: {from: '2026-10-07', to: '2026-10-10'}, weeklyDigests: adWeeks});
    expect(v.ads.total).toMatchObject({spend: null, roas: null, tag: {kind: 'none'}});
    expect(v.notes.join(' ')).toContain('only partly inside');
  });
  it('lets the newer imported week win over an older stored digest window for the same dates', () => {
    const v = buildSalesRange({...base, span: {from: '2026-10-05', to: '2026-10-11'}, weeklyDigests: adWeeks});
    expect(v.ads.shopee).toMatchObject({spend: 200, roas: 3}); // the import (captured 21 Oct), not the stored 50 at ROAS 1
    expect(v.ads.shopee.skipped.map((s) => s.reason)).toContain('rerun');
  });
  it('takes Shopee top products from the imported SKU weeks (product rows, not variations)', () => {
    const skuWeeks = skuWeeksToDigests([
      sku('2026-10-05', '2026-10-11', 'Product A', 500, 5), sku('2026-10-05', '2026-10-11', 'Product A', 300, 3, 'v1'),
      sku('2026-10-12', '2026-10-18', 'Product A', 250, 2), sku('2026-10-12', '2026-10-18', 'Product B', 400, 4),
    ]);
    const v = buildSalesRange({...base, digests: [], span: {from: '2026-10-05', to: '2026-10-18'}, weeklyDigests: skuWeeks});
    expect(v.products.shopee.products).toEqual([{title: 'Product A', revenue: 750, units: 7}, {title: 'Product B', revenue: 400, units: 4}]);
  });
  it('leaves revenue totals untouched: the weekly reports carry no revenue', () => {
    const span = {from: '2026-10-05', to: '2026-10-18'};
    const without = buildSalesRange({...base, span});
    const withWeekly = buildSalesRange({...base, span, weeklyDigests: [...adWeeks, ...skuWeeksToDigests([sku('2026-10-05', '2026-10-11', 'Product A', 500, 5)])]});
    expect(withWeekly.totals).toEqual(without.totals);
    expect(withWeekly.channels).toEqual(without.channels);
  });
  it('adds the caller\'s weekly notes to the page notes, once', () => {
    const v = buildSalesRange({...base, span: {from: '2026-10-05', to: '2026-10-18'}, weeklyNotes: ['Shopee products: coverage note.', 'Shopee products: coverage note.']});
    expect(v.notes.filter((n) => n === 'Shopee products: coverage note.')).toHaveLength(1);
  });
  it('is unchanged when no weekly reports are passed', () => {
    const span = {from: '2026-10-05', to: '2026-10-18'};
    expect(buildSalesRange({...base, span, weeklyDigests: []})).toEqual(buildSalesRange({...base, span}));
  });
});
