import {describe, expect, it} from 'vitest';
import {runMetric} from '../src/chat/query-metric';
import {describeData} from '../src/chat/coverage';
import type {BoxmeFeed} from '../src/boxme-feed';
import type {MetricData, MetricResult, StockData} from '../src/chat/result-types';

// B3/B4 (plan knowledge/tasks/2026-10-19-ask-coop-inventory-plan.md): BoxMe (online warehouse) stock through the Inventory page's
// own compute, on a synthetic feed whose totals are known by construction. Never a real figure.
const NOW = new Date('2026-10-19T04:00:00Z'); // 12:00 PHT
const RUN_START = '2026-10-19T01:30:00Z'; // 09:30 PHT, 2.5 hours earlier: fresh
const stock: StockData = {
  byLocation: [{product_id: 'P1', location: 'event', stock: 10}, {product_id: 'P1', location: 'office', stock: 5}, {product_id: 'P2', location: 'event', stock: 3}],
  names: {P1: 'Chicken Jerky', P2: 'Salmon Bites'},
  sales: [],
  config: {threshold: 5, thresholdOverrides: {}, targetCoverEventDays: 6, leadTimeDays: 3, earlyWarningEvents: 3, eventWeekdays: [5, 6, 0]},
  asOf: NOW.toISOString(),
};
const feed = (runStart = RUN_START, status = 'ok'): BoxmeFeed => ({
  products: [
    {seller_sku: 'P1', name: 'Chicken Jerky', active: true, sale_price: 250, min_quantity: 0, expiry_threshold: null, image_url: null},
    {seller_sku: 'P7', name: 'Duck Treats', active: true, sale_price: 199, min_quantity: 0, expiry_threshold: null, image_url: null},
  ],
  warehouses: [{pickup_id: '7', warehouse_code: 'MNL1', pickup_name: 'Manila'}],
  stock: [
    {seller_sku: 'P1', pickup_id: '7', stock: 27, awaiting: 0, reserved: 2, available: 20, incoming: 5, damaged_stock: 1, damaged_available: 0, synced_at: runStart},
    {seller_sku: 'P7', pickup_id: '7', stock: 4, awaiting: 0, reserved: 0, available: 4, incoming: 0, damaged_stock: 0, damaged_available: 0, synced_at: runStart},
    {seller_sku: 'P9', pickup_id: '7', stock: 99, awaiting: 0, reserved: 0, available: 99, incoming: 0, damaged_stock: 0, damaged_available: 0, synced_at: '2026-09-01T00:00:00Z'}, // stale row from an old run
  ],
  daily: [],
  lots: [{seller_sku: 'P1', warehouse_code: 'MNL1', batch_lot: 'B1', expire_date: '2026-11-18', quantity: 6, synced_at: runStart}],
  runs: [{id: 3, started_at: runStart, finished_at: runStart, status: status as 'ok', skus_seen: 2, skus_written: 2, error: null, key_expires_at: null}],
});
const data = (boxme: BoxmeFeed | null | undefined = feed(), s: StockData | null = stock): MetricData => ({source: 'live', orders: [], events: [], prices: [], priceChanges: [], bulkReads: [], stock: s, boxme});
const req = (over: Record<string, unknown>) => ({metric: 'stock_on_hand', dimension: 'online', measure: 'default', range: 'all_available', from: '', to: '', channel: 'offline', event: 'all', pet: 'all', compare_to: 'none', sort: 'default', limit: 25, ...over});
const ok = (over: Record<string, unknown>, d: MetricData = data()) => {
  const r = runMetric(req(over), d, NOW);
  if ('error' in r) throw new Error(r.error);
  return r as MetricResult;
};

describe('stock_on_hand online (BoxMe available)', () => {
  it('per product, biggest first; only rows from the last good sync (the old P9 row is ignored)', () => {
    const r = ok({});
    expect(r.rows).toEqual([
      {product: 'Chicken Jerky (P1)', stock_units: 20, reserved_units: 2, incoming_units: 5},
      {product: 'Duck Treats (P7)', stock_units: 4, reserved_units: 0, incoming_units: 0},
    ]);
    expect(r.meta.caveats.at(-1)).toBe('BoxMe (online) stock as of the last good sync, 2026-10-19 09:30 PHT; BoxMe syncs once a day.');
  });
});

describe('stock_on_hand all_channels (Event + Office + BoxMe)', () => {
  it('every row: total = event + office + online (the invariant), and the one-side-only products are named', () => {
    const r = ok({dimension: 'all_channels'});
    expect(r.rows).toEqual([
      {product: 'Chicken Jerky (P1)', event_units: 10, office_units: 5, online_units: 20, stock_units: 35},
      {product: 'Duck Treats (P7)', event_units: 0, office_units: 0, online_units: 4, stock_units: 4},
      {product: 'Salmon Bites (P2)', event_units: 3, office_units: 0, online_units: 0, stock_units: 3},
    ]);
    for (const row of r.rows) expect(row.stock_units).toBe(Number(row.event_units) + Number(row.office_units) + Number(row.online_units));
    const c = r.meta.caveats.join(' ');
    expect(c).toMatch(/In the POS but not stocked at BoxMe: Salmon Bites\./);
    expect(c).toMatch(/At BoxMe but not in the POS catalog: P7\./);
  });
  it('without POS stock it refuses instead of showing BoxMe as the total', () => {
    expect(runMetric(req({dimension: 'all_channels'}), data(feed(), null), NOW)).toEqual({error: expect.stringMatching(/Offline \(POS\) stock is not available/)});
  });
});

describe('stock_on_hand expiring_online and stock_cover online', () => {
  it('lists the BoxMe lots inside the expiry window, soonest first', () => {
    expect(ok({dimension: 'expiring_online'}).rows).toEqual([{product: 'Chicken Jerky (P1)', warehouse: 'MNL1', batch: 'B1', expires: '2026-11-18', days_left: 30, stock_units: 6}]);
  });
  it('cover online: no 7 days of snapshots yet, so sales speed and days left are empty (null), and the estimate basis is said', () => {
    const r = ok({metric: 'stock_cover', dimension: 'online'});
    expect(r.rows.map((x) => x.status)).toEqual(['low', 'healthy']); // Duck Treats: 4 available, under the threshold of 5
    expect(r.rows[1]).toMatchObject({product: 'Chicken Jerky (P1)', stock_units: 20, sold_per_day_units: null, cover_days: null});
    expect(r.meta.caveats.join(' ')).toMatch(/estimated from day-over-day drops in BoxMe stock .* not an order count/);
  });
});

describe('BoxMe freshness and connection (B4)', () => {
  it('a sync older than a day is said first', () => {
    const r = ok({}, data(feed('2026-10-17T22:00:00Z')));
    expect(r.meta.caveats[0]).toMatch(/^The BoxMe figures are 30 hours old \(older than a day\)/);
  });
  it('a failed latest sync with an earlier good one is said first; with none it is not connected', () => {
    const f = feed();
    f.runs.unshift({id: 4, started_at: '2026-10-19T03:00:00Z', finished_at: '2026-10-19T03:01:00Z', status: 'failed', skus_seen: 0, skus_written: 0, error: null, key_expires_at: null});
    expect(ok({}, data(f)).meta.caveats[0]).toMatch(/latest BoxMe sync failed/);
    expect(runMetric(req({}), data(feed(RUN_START, 'failed')), NOW)).toEqual({error: expect.stringMatching(/BoxMe sync has failed and there is no earlier good sync/)});
  });
  it('not connected (views missing) is said, never 0, and points to the offline dimensions', () => {
    for (const d of [data(null), {...data(), boxme: undefined}]) {
      const r = runMetric(req({}), d, NOW);
      expect(r).toEqual({error: expect.stringMatching(/BoxMe \(online\) stock is not connected here.*use dimension sellable, office or all_locations/)});
    }
  });
  it('describe_data lists the new dimensions with the metric', () => {
    expect(JSON.stringify(describeData({metric: 'stock_on_hand'}, data(), NOW, false, false, false))).toMatch(/expiring_online/);
  });
});

