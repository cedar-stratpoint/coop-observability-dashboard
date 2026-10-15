import {describe, expect, it} from 'vitest';
import {runMetric} from '../src/chat/query-metric';
import type {MetricData, MetricResult, StockData} from '../src/chat/result-types';

const NOW = new Date('2026-09-28T04:00:00Z');
const stock: StockData = {
  byLocation: [
    {product_id: 'P1', location: 'event', stock: 12}, {product_id: 'P1', location: 'office', stock: 60},
    {product_id: 'P2', location: 'event', stock: 0}, {product_id: 'P2', location: 'office', stock: 25},
  ],
  names: {P1: 'Chicken Jerky', P2: 'Beef Bites'},
  sales: [{product_id: 'P1', qty: 28, day: '2026-09-20'}, {product_id: 'P2', qty: 10, day: '2026-09-21'}],
  config: {threshold: 5, thresholdOverrides: {}, targetCoverEventDays: 6, leadTimeDays: 3, earlyWarningEvents: 3, eventWeekdays: [5, 6, 0]},
  asOf: NOW.toISOString(),
};
const data = (s: StockData | null): MetricData => ({source: 'live', orders: [], events: [], prices: [], priceChanges: [], bulkReads: [], stock: s});
const req = (over: Record<string, unknown>) => ({metric: 'stock_on_hand', dimension: 'sellable', measure: 'default', range: 'all_available', from: '', to: '', channel: 'offline', event: 'all', pet: 'all', compare_to: 'none', sort: 'default', limit: 25, ...over});
const rows = (r: ReturnType<typeof runMetric>) => (r as MetricResult).rows;

describe('F.3 registry stock metrics (moved to Train 3)', () => {
  it('stock_on_hand defaults to Event (sellable) stock per product and says the basis', () => {
    const r = runMetric(req({}), data(stock), NOW) as MetricResult;
    expect(r.rows).toEqual([{product: 'Chicken Jerky (P1)', stock_units: 12}, {product: 'Beef Bites (P2)', stock_units: 0}]);
    expect(r.meta.caveats.join(' ')).toMatch(/Event \(sellable\) stock/);
    expect(r.meta.caveats.join(' ')).toMatch(/as of now/i);
  });
  it('office, all locations and per location', () => {
    expect(rows(runMetric(req({dimension: 'office'}), data(stock), NOW))).toEqual([{product: 'Chicken Jerky (P1)', stock_units: 60}, {product: 'Beef Bites (P2)', stock_units: 25}]);
    expect(rows(runMetric(req({dimension: 'all_locations'}), data(stock), NOW))).toEqual([{product: 'Chicken Jerky (P1)', stock_units: 72}, {product: 'Beef Bites (P2)', stock_units: 25}]);
    expect(rows(runMetric(req({dimension: 'by_location'}), data(stock), NOW))).toHaveLength(4);
  });
  it('stock_cover uses the Inventory forecast engine on Event stock', () => {
    const r = runMetric(req({metric: 'stock_cover', dimension: 'sku'}), data(stock), NOW) as MetricResult;
    expect(r.rows).toEqual([
      {product: 'Beef Bites (P2)', status: 'out', stock_units: 0, sold_per_day_units: 10, cover_days: 0},
      {product: 'Chicken Jerky (P1)', status: 'low', stock_units: 12, sold_per_day_units: 28, cover_days: 0.43},
    ]);
  });
  it('no stock data: a plain refusal, never invented numbers', () => {
    expect(runMetric(req({}), data(null), NOW)).toEqual({error: expect.stringMatching(/Stock data is not available/)});
  });
});
