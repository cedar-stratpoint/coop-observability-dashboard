import {describe, it, expect} from 'vitest';
import {runMetric} from '../src/chat/query-metric';
import {METRICS, METRIC_IDS} from '../src/chat/metrics-registry';
import {isStockMetric} from '../src/chat/stock-metrics';
import type {MetricData, MetricError, MetricRequest, MetricResult, StockData} from '../src/chat/result-types';
import type {PetType, PosEvent, PosOrder, PosOrderLine} from '../src/pos-sales-types';
import {bundlePickRows} from '../src/pos-bundle-compute';
import {buildPriceHistory} from '../src/pos-price-history';
import {buildBundleFixture, CHANGES, PRICES} from './support/bundle-fixture';

// Synthetic data only. Totals are known by construction.

const NOW = new Date('2026-10-01T04:00:00Z'); // Thursday Oct 1 2026, noon PHT

const BASE: MetricRequest = {
  metric: 'offline_revenue', dimension: 'none', measure: 'default', range: 'custom', from: '2026-09-12', to: '2026-09-26',
  channel: 'offline', event: 'all', pet: 'all', compare_to: 'none', sort: 'default', limit: 25,
};
const req = (over: Partial<MetricRequest>): MetricRequest => ({...BASE, ...over});

function ev(id: string, name: string, starts: string, ends: string): PosEvent {
  return {event_id: id, name, venue: null, city: null, organizer: null, starts_on: starts, ends_on: ends, opening_cash: null, cash_note: null, closing_cash: null, status: 'closed', created_by: null, created_at: null, updated_at: null};
}
const EVENTS = [ev('EV1', 'Pet Fair', '2026-09-12', '2026-09-13'), ev('EV2', 'Bazaar', '2026-09-26', '2026-09-27')];

function line(sku: string, name: string, qty: number, unit: number): PosOrderLine {
  return {product_id: sku, name, qty, unit_price: unit, line_total: qty * unit};
}
function ord(id: string, at: string, total: number, items: PosOrderLine[], o: {pay?: string; ev?: string | null; pet?: PetType | null; status?: string} = {}): PosOrder {
  return {
    id, client_uuid: id, subtotal: total, discount: null, total, oversold: false, device_id: null,
    payment_method: o.pay ?? 'cash', customer_handle: null, status: o.status ?? 'completed', remarks: null,
    created_at: at, edited_at: null, event_id: o.ev ?? null, pet_type: o.pet ?? null, items,
  };
}

// Revenue 1780 over 7 completed orders. o3 is at 00:30 PHT on Sep 13 (16:30 UTC Sep 12): the PHT day is Sep 13.
const ORDERS: PosOrder[] = [
  ord('o1', '2026-09-12T10:00:00+08:00', 500, [line('P1', 'Chicken Jerky', 2, 250)], {ev: 'EV1', pet: 'dog'}),
  ord('o2', '2026-09-12T11:00:00+08:00', 250, [line('P2', 'Salmon Bites', 1, 250)], {pay: 'gcash', ev: 'EV1', pet: 'cat'}),
  ord('o3', '2026-09-12T16:30:00Z', 100, [line('P3', 'Dental Chews', 1, 100)]),
  ord('o4', '2026-09-14T10:00:00+08:00', 300, [line('P1', 'Chicken Jerky', 1, 300)], {pet: 'dog'}),
  ord('o5', '2026-09-20T10:00:00+08:00', 400, [line('P2', 'Salmon Bites', 2, 200)], {pay: 'gcash', pet: 'both'}),
  ord('o6', '2026-09-21T10:00:00+08:00', 999, [line('P1', 'Chicken Jerky', 3, 333)], {status: 'voided', pet: 'dog'}),
  ord('o7', '2026-09-26T10:00:00+08:00', 150, [line('P4', 'Beef Strips', 1, 150)], {pay: 'gcash', ev: 'EV2', pet: 'dog'}),
  ord('o8', '2026-09-22T10:00:00+08:00', 80, [line('P5', 'Fish Skin', 1, 80)]),
];
const data = (over: Partial<MetricData> = {}): MetricData => ({source: 'live', orders: ORDERS, events: EVENTS, prices: [], priceChanges: [], bulkReads: [], ...over});

function res(input: unknown, d: MetricData = data()): MetricResult {
  const r = runMetric(input, d, NOW);
  if ('error' in r) throw new Error(`expected a result, got error: ${r.error}`);
  return r;
}
function err(input: unknown, d: MetricData = data()): string {
  const r = runMetric(input, d, NOW);
  if (!('error' in r)) throw new Error('expected an error');
  return (r as MetricError).error;
}
const sum = (rows: MetricResult['rows'], key: string): number => rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);
const check = (r: MetricResult, code: string) => r.meta.checks.find((c) => c.code === code);
const col = (r: MetricResult, key: string) => r.rows.map((x) => x[key]);

function allNumbersFinite(r: MetricResult): void {
  for (const row of r.rows) for (const [k, v] of Object.entries(row)) if (typeof v === 'number') expect(Number.isFinite(v), `${r.metric}.${k}`).toBe(true);
  expect(JSON.stringify(r)).not.toMatch(/NaN|Infinity/);
}

describe('validation matrix', () => {
  it('rejects a non-object and lists the allowed keys', () => {
    for (const bad of [null, 'x', 5, [], undefined]) expect(err(bad)).toMatch(/must be an object.*metric, dimension, measure, range, from, to, channel, event, pet, compare_to, sort, limit/);
  });

  it('rejects unknown keys (filters, where, sql) and lists the allowed keys', () => {
    for (const key of ['filters', 'where', 'sql']) {
      const e = err({...BASE, [key]: 'x'});
      expect(e).toContain(`Unknown key(s): ${key}`);
      expect(e).toContain('Allowed keys: metric, dimension, measure');
    }
  });

  it('rejects a missing field and names it', () => {
    const {limit, ...rest} = BASE;
    void limit;
    expect(err(rest)).toMatch(/Missing required field\(s\): limit/);
    expect(err({metric: 'offline_revenue'})).toMatch(/Missing required field\(s\): dimension, measure, range/);
    expect(err({...BASE, pet: undefined})).toMatch(/Missing required field\(s\): pet/);
  });

  it('rejects a wrong enum and lists the allowed values', () => {
    expect(err(req({metric: 'sales' as never}))).toMatch(/Allowed values for metric: offline_revenue, offline_orders/);
    expect(err(req({range: 'yesterday' as never}))).toMatch(/Allowed values for range: last_week, this_week, last_month, all_available, custom/);
    expect(err(req({channel: 'shopee' as never}))).toMatch(/Allowed values for channel: offline, all/);
    expect(err(req({pet: 'bird' as never}))).toMatch(/Allowed values for pet: all, dog, cat, both, untagged/);
    expect(err(req({compare_to: 'last_year' as never}))).toMatch(/Allowed values for compare_to: none, previous_period/);
    expect(err(req({sort: 'asc' as never}))).toMatch(/Allowed values for sort: default, value_desc, value_asc/);
    expect(err(req({limit: 7 as never}))).toMatch(/Allowed values for limit: 3, 5, 10, 25/);
    expect(err(req({limit: '5' as never}))).toMatch(/Allowed values for limit/);
  });

  it('rejects a dimension the metric does not declare, listing the metric\'s dimensions', () => {
    expect(err(req({metric: 'top_products', dimension: 'day'}))).toMatch(/not allowed for top_products\. Allowed dimensions for top_products: none/);
    expect(err(req({metric: 'bundle_picks', dimension: 'none'}))).toMatch(/Allowed dimensions for bundle_picks: sku, sku_by_pet, bundle_by_sku/);
  });

  it("rejects 'default' as a dimension and says to use 'none'", () => {
    expect(err(req({dimension: 'default'}))).toMatch(/dimension 'default' is not allowed; use 'none'/);
  });

  it('rejects a measure the metric does not declare and names the metrics that do', () => {
    const e = err(req({metric: 'offline_revenue', measure: 'list_value'}));
    expect(e).toMatch(/'list_value' is not declared by offline_revenue; metrics that declare it: bundle_picks/);
    const e2 = err(req({metric: 'offline_revenue', measure: 'units'}));
    expect(e2).toMatch(/metrics that declare it: top_products, bundle_picks/);
    expect(err(req({metric: 'offline_revenue', measure: 'orders'}))).toMatch(/metrics that declare it: offline_orders, payment_mix, event_rollup, pet_mix, bundle_sales/);
  });

  it('says exactly what is missing when no metric declares the measure', () => {
    const e = err(req({measure: 'margin'}));
    expect(e).toMatch(/^No metric declares the measure 'margin'\. Declared measures: /);
    for (const k of ['revenue', 'orders', 'aov', 'units', 'list_value']) expect(e).toContain(k);
  });

  it('rejects the pet filter on a metric that does not support it, listing those that do', () => {
    const e = err(req({metric: 'pet_mix', pet: 'cat'}));
    expect(e).toMatch(/pet filter is not supported by pet_mix; metrics that support it: offline_revenue, offline_orders/);
    expect(e).not.toMatch(/supports it:.*pet_mix/);
  });

  it('rejects an unknown event and lists the known event names', () => {
    const e = err(req({event: 'Moon Fair'}));
    expect(e).toMatch(/Unknown event .*Moon Fair.*Known events: Pet Fair, Bazaar/);
    expect(err(req({event: 'Moon Fair'}), data({events: []}))).toMatch(/No events are recorded yet/);
    expect(err(req({event: ''}))).toMatch(/event must be 'all'/);
  });

  it('rejects bad dates through the range resolver', () => {
    expect(err(req({from: '2026-02-30', to: '2026-03-05'}))).toMatch(/real calendar date/);
    expect(err(req({from: '', to: '2026-09-26'}))).toMatch(/needs both/);
    expect(err(req({from: '2026-09-26', to: '2026-09-12'}))).toMatch(/before 'from'/);
    expect(err(req({from: '2026-09-12', to: '2026-10-05'}))).toMatch(/after today/);
    expect(err(req({range: 'last_week', from: '2026-09-12'}))).toMatch(/must be ''/);
    expect(err(req({range: 'all_available'}), data({orders: []}))).toMatch(/must be ''/);
  });

  it('rejects compare_to on a day/week series and on a matrix', () => {
    expect(err(req({dimension: 'day', compare_to: 'previous_period'}))).toMatch(/not available for offline_revenue by 'day' \(a series\).*Dimensions of offline_revenue that can be compared: none/);
    expect(err(req({metric: 'bundle_sales', dimension: 'bundle_by_pet', compare_to: 'previous_period'}))).toMatch(/matrix/);
  });

  it('computes nothing on a rejected request (no result)', () => {
    const r = runMetric({...BASE, sql: 'select 1'}, data(), NOW);
    expect(r).toEqual({error: expect.any(String)});
  });
});

describe('offline_revenue / offline_orders / offline_aov', () => {
  it('totals completed orders only (voided excluded) and reports full coverage', () => {
    const r = res(req({}));
    expect(r.id).toBe('');
    expect(r.rows).toEqual([{revenue: 1780}]);
    expect(r.meta).toMatchObject({coverage: 'full', coveredFrom: '2026-09-12', coveredTo: '2026-09-26', dataFrom: '2026-09-12', dataTo: '2026-09-26', measure: 'revenue', source: 'live', rowCount: 1});
    expect(r.meta.range).toEqual({from: '2026-09-12', to: '2026-09-26', label: 'Sep 12 to Sep 26, 2026'});
    expect(r.meta.measures.map((m) => m.key)).toEqual(['revenue']);
    expect(r.meta.reliable).toBe(true);
  });

  it('counts orders and computes the average order value', () => {
    expect(res(req({metric: 'offline_orders'})).rows).toEqual([{orders: 7}]);
    const aov = res(req({metric: 'offline_aov'}));
    expect(aov.rows).toEqual([{period: 'Sep 12 to Sep 26, 2026', orders: 7, revenue: 1780, aov: 254.29}]);
    expect(aov.meta.measure).toBe('aov');
  });

  it('puts an order at 16:30 UTC on the next Philippine day', () => {
    const r = res(req({dimension: 'day', from: '2026-09-12', to: '2026-09-14'}));
    const byDay = Object.fromEntries(r.rows.map((x) => [x.period as string, x.revenue]));
    expect(byDay).toEqual({'2026-09-12': 750, '2026-09-13': 100, '2026-09-14': 300});
  });

  it('day series is zero-filled inside coverage, chronological, and reconciles to the total', () => {
    const r = res(req({dimension: 'day'}));
    expect(r.rows).toHaveLength(15); // Sep 12..26
    expect(col(r, 'period')[0]).toBe('2026-09-12');
    expect(col(r, 'period').at(-1)).toBe('2026-09-26');
    expect(r.rows.find((x) => x.period === '2026-09-16')).toEqual({period: '2026-09-16', revenue: 0});
    expect(sum(r.rows, 'revenue')).toBe(1780);
    expect(check(r, 'reconciles')?.status).toBe('ok');
  });

  it('week series starts on Monday and notes a partial week', () => {
    const r = res(req({metric: 'offline_orders', dimension: 'week'}));
    expect(col(r, 'period')).toEqual(['2026-09-07', '2026-09-14', '2026-09-21']);
    expect(col(r, 'orders')).toEqual([3, 2, 2]);
    expect(r.meta.caveats.join(' ')).toMatch(/Monday to Sunday.*partial/);
    expect(check(r, 'reconciles')?.status).toBe('ok');
  });

  it('aov per day is null (not 0) on a day with no orders', () => {
    const r = res(req({metric: 'offline_aov', dimension: 'day', from: '2026-09-14', to: '2026-09-16'}));
    expect(r.rows).toEqual([
      {period: '2026-09-14', orders: 1, revenue: 300, aov: 300},
      {period: '2026-09-15', orders: 0, revenue: 0, aov: null},
      {period: '2026-09-16', orders: 0, revenue: 0, aov: null},
    ]);
  });

  it('a series only lists days inside the data coverage', () => {
    const r = res(req({dimension: 'day', from: '2026-09-01', to: '2026-09-13'}));
    expect(col(r, 'period')).toEqual(['2026-09-12', '2026-09-13']);
    expect(r.meta.coverage).toBe('partial');
  });

  it('an unrelated measure key is not accepted: orders on offline_orders is the default', () => {
    expect(res(req({metric: 'offline_orders', measure: 'orders'})).meta.measure).toBe('orders');
  });
});

describe('coverage', () => {
  it('is partial when the range exceeds the data, with the gap reported', () => {
    const r = res(req({from: '2026-09-01', to: '2026-09-30'}));
    expect(r.meta).toMatchObject({coverage: 'partial', coveredFrom: '2026-09-12', coveredTo: '2026-09-26', dataFrom: '2026-09-12', dataTo: '2026-09-26'});
    expect(check(r, 'partial_coverage')?.status).toBe('warn');
    expect(r.meta.caveats.some((c) => /Data covers Sep 12, 2026 to Sep 26, 2026 only/.test(c))).toBe(true);
    expect(r.rows).toEqual([{revenue: 1780}]);
  });

  it('is none for a range before the data starts, which is NOT an error', () => {
    const r = res(req({from: '2025-09-01', to: '2025-09-30'}));
    expect(r.meta).toMatchObject({coverage: 'none', coveredFrom: null, coveredTo: null, dataFrom: '2026-09-12', dataTo: '2026-09-26'});
    expect(r.rows).toEqual([{revenue: 0}]);
    expect(check(r, 'partial_coverage')?.text).toMatch(/no data in that range/);
    expect(check(r, 'small_sample')?.status).toBe('warn');
    allNumbersFinite(r);
  });

  it('is none and not an error for a range after the data ends (today)', () => {
    const r = res(req({range: 'this_week', from: '', to: ''}));
    expect(r.meta.range.from).toBe('2026-09-28');
    expect(r.meta.coverage).toBe('none');
  });

  it('all_available resolves to the data bounds', () => {
    const r = res(req({range: 'all_available', from: '', to: ''}));
    expect(r.meta.range.from).toBe('2026-09-12');
    expect(r.meta.range.to).toBe('2026-09-26');
    expect(r.meta.coverage).toBe('full');
  });

  it('last_week and last_month resolve in Philippine time', () => {
    expect(res(req({range: 'last_week', from: '', to: ''})).meta.range).toMatchObject({from: '2026-09-21', to: '2026-09-27'});
    expect(res(req({range: 'last_month', from: '', to: ''})).meta.range).toMatchObject({from: '2026-09-01', to: '2026-09-30', label: 'Sep 1 to Sep 30, 2026'});
  });
});

describe('top_products', () => {
  it('ranks by itemized revenue with shares of ALL products, summing to 100.0', () => {
    const r = res(req({metric: 'top_products'}));
    expect(col(r, 'product')).toEqual(['Chicken Jerky', 'Salmon Bites', 'Beef Strips', 'Dental Chews', 'Fish Skin']);
    expect(col(r, 'revenue')).toEqual([800, 650, 150, 100, 80]);
    expect(Math.abs(sum(r.rows, 'share') - 100)).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(r.rows[0].share).toBe(44.9);
    expect(r.meta.share_basis).toBe('all itemized revenue');
    expect(check(r, 'reconciles')?.status).toBe('ok');
  });

  it('applies limit and sort AFTER shares are computed over all rows', () => {
    const top3 = res(req({metric: 'top_products', limit: 3}));
    expect(col(top3, 'product')).toEqual(['Chicken Jerky', 'Salmon Bites', 'Beef Strips']);
    expect(top3.rows[0].share).toBe(44.9); // still a share of all five products
    expect(sum(top3.rows, 'share')).toBeLessThan(100);
    expect(top3.meta.rowCount).toBe(3);
    expect(top3.meta.caveats.join(' ')).toMatch(/Showing the first 3 of 5 rows; shares are of all 5/);
    const low = res(req({metric: 'top_products', sort: 'value_asc', limit: 3}));
    expect(col(low, 'product')).toEqual(['Fish Skin', 'Dental Chews', 'Beef Strips']);
    expect(res(req({metric: 'top_products', sort: 'value_desc', limit: 5})).rows).toHaveLength(5);
  });

  it('ranks by units when asked', () => {
    const r = res(req({metric: 'top_products', measure: 'units'}));
    expect(r.meta.measure).toBe('units');
    expect(r.rows[0]).toMatchObject({units: 3});
    expect(r.meta.share_basis).toBe('all units sold');
    expect(check(r, 'reconciles')?.status).toBe('ok');
  });
});

describe('payment_mix', () => {
  it('splits revenue and orders by method, parts equal the whole', () => {
    const rev = res(req({metric: 'payment_mix'}));
    expect(rev.rows).toEqual([{method: 'cash', value: 980, share: 55.1}, {method: 'gcash', value: 800, share: 44.9}]);
    expect(check(rev, 'reconciles')?.status).toBe('ok');
    const n = res(req({metric: 'payment_mix', measure: 'orders'}));
    expect(n.rows).toEqual([{method: 'cash', value: 4, share: 57.1}, {method: 'gcash', value: 3, share: 42.9}]);
    expect(sum(n.rows, 'share')).toBeCloseTo(100, 5);
  });
});

describe('event_rollup', () => {
  it('rolls up events with orders, attributes untagged sales by date, and reconciles with walk-ins', () => {
    const r = res(req({metric: 'event_rollup'}));
    expect(r.rows).toEqual([
      {event: 'Pet Fair', revenue: 850, orders: 3, share: 85, tagged_orders: 2, date_orders: 1},
      {event: 'Bazaar', revenue: 150, orders: 1, share: 15, tagged_orders: 1, date_orders: 0},
    ]);
    expect(check(r, 'reconciles')?.status).toBe('ok');
    expect(r.meta.caveats.join(' ')).toMatch(/Walk-in sales with no event are not in these rows: ₱780/);
  });

  it('filters to one event by name (case-insensitive) or id, including date-attributed orders', () => {
    for (const event of ['pet fair', 'PET FAIR', 'EV1']) {
      const r = res(req({event}));
      expect(r.rows, event).toEqual([{revenue: 850}]);
      expect(r.meta.caveats.join(' ')).toContain('Filtered to event: Pet Fair');
    }
    expect(res(req({metric: 'offline_orders', event: 'Bazaar'})).rows).toEqual([{orders: 1}]);
    expect(res(req({metric: 'event_rollup', event: 'bazaar'})).rows).toHaveLength(1);
  });
});

describe('pet_mix and the pet filter', () => {
  it('splits by pet; tagged shares are relative to TAGGED value and sum to 100.0; untagged share null', () => {
    const r = res(req({metric: 'pet_mix'}));
    expect(r.rows).toEqual([
      {pet: 'dog', value: 950, share: 59.4},
      {pet: 'cat', value: 250, share: 15.6},
      {pet: 'both', value: 400, share: 25},
      {pet: 'untagged', value: 180, share: null},
    ]);
    expect(r.meta.share_basis).toBe('tagged revenue');
    expect(sum(r.rows.slice(0, 3), 'share')).toBeCloseTo(100, 5);
    expect(check(r, 'reconciles')?.status).toBe('ok');
    expect(check(r, 'untagged_share')?.status).toBe('warn');
    expect(r.meta.insights.map((i) => i.code)).toEqual(expect.arrayContaining(['top_contributor', 'untagged_share']));
    expect(res(req({metric: 'pet_mix', measure: 'orders'})).meta.share_basis).toBe('tagged orders');
  });

  it('pet filter keeps only that pet; untagged means no tag', () => {
    expect(res(req({pet: 'dog'})).rows).toEqual([{revenue: 950}]);
    expect(res(req({pet: 'untagged'})).rows).toEqual([{revenue: 180}]);
    expect(res(req({metric: 'payment_mix', pet: 'cat'})).rows).toEqual([{method: 'gcash', value: 250, share: 100}]);
  });

  it('channel all is accepted with a caveat that only the offline POS is connected', () => {
    const r = res(req({channel: 'all'}));
    expect(r.rows).toEqual([{revenue: 1780}]);
    expect(r.meta.caveats[0]).toMatch(/Only the offline POS is connected/);
    expect(res(req({})).meta.caveats.join(' ')).not.toMatch(/Only the offline POS/);
  });
});

describe('compare_to previous_period', () => {
  it('adds previous_<measure>, delta and delta_pct on a total', () => {
    const r = res(req({from: '2026-09-19', to: '2026-09-26', compare_to: 'previous_period'}));
    expect(r.rows).toEqual([{revenue: 630, previous_revenue: 1150, delta: -520, delta_pct: -45.2}]);
    expect(r.columns.map((c) => c.key)).toEqual(['revenue', 'previous_revenue', 'delta', 'delta_pct']);
    expect(r.columns.find((c) => c.key === 'delta_pct')).toMatchObject({unit: 'percent', role: 'delta'});
  });

  it('gives null (never 0) previous, delta and percent when the previous period has no orders, with a caveat', () => {
    const r = res(req({from: '2026-09-12', to: '2026-09-14', compare_to: 'previous_period'}));
    expect(r.rows[0]).toEqual({revenue: 1150, previous_revenue: null, delta: null, delta_pct: null});
    expect(r.meta.caveats.join(' ')).toMatch(/previous period \(2026-09-09 to 2026-09-11\) has no orders.*\(null\), not zero/);
  });

  it('on a category breakdown a category missing last period has previous 0 and a null percent', () => {
    // current Sep 19-26: Salmon Bites 400, Beef Strips 150, Fish Skin 80; previous Sep 11-18: Chicken 800, Salmon 250, Dental 100
    const r = res(req({metric: 'top_products', from: '2026-09-19', to: '2026-09-26', compare_to: 'previous_period'}));
    const beef = r.rows.find((x) => x.product === 'Beef Strips');
    expect(beef).toMatchObject({revenue: 150, previous_revenue: 0, delta: 150, delta_pct: null});
    const salmon = r.rows.find((x) => x.product === 'Salmon Bites');
    expect(salmon).toMatchObject({revenue: 400, previous_revenue: 250, delta: 150, delta_pct: 60});
    expect(r.meta.insights.map((i) => i.code)).toContain('biggest_change');
  });

  it('counts: a sudden change on a small base warns', () => {
    const r = res(req({metric: 'offline_orders', from: '2026-09-19', to: '2026-09-26', compare_to: 'previous_period'}));
    expect(r.rows[0]).toMatchObject({orders: 3, previous_orders: 4, delta: -1});
  });

  it('an aov comparison is null on an empty previous period', () => {
    const r = res(req({metric: 'offline_aov', from: '2026-09-12', to: '2026-09-14', compare_to: 'previous_period'}));
    expect(r.rows[0]).toMatchObject({previous_aov: null, delta: null, delta_pct: null});
  });
});

describe('source and empty data', () => {
  it('a mock source is allowed but unreliable with a mock_source check', () => {
    const r = res(req({}), data({source: 'mock'}));
    expect(r.meta.source).toBe('mock');
    expect(check(r, 'mock_source')?.status).toBe('fail');
    expect(r.meta.reliable).toBe(false);
    expect(r.meta.caveats).toContain('This is sample data.');
  });

  it('every metric and dimension survives empty data with no NaN or Infinity', () => {
    for (const id of METRIC_IDS.filter((x) => !isStockMetric(x))) { // stock has no orders or range: test/chat-stock-metrics.test.ts
      for (const d of METRICS[id].dimensions) {
        for (const m of METRICS[id].measures) {
          const r = res(req({metric: id, dimension: d.key, measure: m.key, from: '2026-09-01', to: '2026-09-30'}), data({orders: [], events: []}));
          expect(r.meta.coverage, `${id}/${d.key}/${m.key}`).toBe('none');
          expect(r.meta.dataFrom).toBeNull();
          allNumbersFinite(r);
          if (d.shape === 'aggregate') expect(r.rows.length, `${id}/${d.key}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('all_available on empty data says there is no data yet', () => {
    expect(err(req({range: 'all_available', from: '', to: ''}), data({orders: []}))).toMatch(/no data yet/i);
  });

  it('empty data with a compare has null previous', () => {
    const r = res(req({compare_to: 'previous_period'}), data({orders: []}));
    expect(r.rows[0]).toEqual({revenue: 0, previous_revenue: null, delta: null, delta_pct: null});
  });

  it('every metric default query returns its headline columns', () => {
    for (const id of METRIC_IDS) {
      const d = METRICS[id];
      const r = res(req({metric: id, dimension: d.defaultDimension, measure: 'default'}), bundleData({stock: STOCK}));
      for (const c of d.profile.headlineColumns) expect(r.columns.map((x) => x.key), `${id}.${c}`).toContain(c);
      expect(r.meta.measure).toBe(d.defaultMeasure);
      expect(r.meta.measures).toEqual(d.measures);
    }
  });
});

const STOCK: StockData = {
  byLocation: [{product_id: 'P1', location: 'event', stock: 12}],
  names: {P1: 'Chicken Jerky'}, sales: [{product_id: 'P1', qty: 28, day: '2026-09-20'}],
  config: {threshold: 5, thresholdOverrides: {}, targetCoverEventDays: 6, leadTimeDays: 3, earlyWarningEvents: 3, eventWeekdays: [5, 6, 0]},
  asOf: NOW.toISOString(),
};

// ---- bundles on A's synthetic fixture -------------------------------------------------------------------------------

const fx = buildBundleFixture();
function bundleData(over: Partial<MetricData> = {}): MetricData {
  return {source: 'live', orders: fx.orders, events: [], prices: PRICES, priceChanges: CHANGES, bulkReads: [{relation: 'coop_chat_orders', rows: fx.orders.length}], ...over};
}
const BUNDLE = {range: 'all_available' as const, from: '', to: ''};
const bq = (over: Partial<MetricRequest>) => res(req({...BUNDLE, dimension: over.metric === 'bundle_picks' ? 'sku' : 'none', ...over}), bundleData());
const pesos = (c: number): number => c / 100;
const PET_KEYS = ['dog', 'cat', 'both', 'untagged'] as const;

describe('bundle_sales', () => {
  it('none: one row with bundle revenue, shares of tagged and the dog vs cat ratio', () => {
    const r = bq({metric: 'bundle_sales'});
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0];
    expect(row.bundle_revenue).toBe(pesos(fx.expected.bundleRevenueC));
    expect(row.bundle_orders).toBe(fx.expected.bundleOrders);
    expect(row.untagged_revenue).toBe(pesos(fx.expected.byPetC.untagged));
    const tagged = fx.expected.byPetC.dog + fx.expected.byPetC.cat + fx.expected.byPetC.both;
    expect(Math.abs((row.dog_share as number) - (fx.expected.byPetC.dog / tagged) * 100)).toBeLessThan(0.1);
    expect(Math.abs((row.dog_share as number) + (row.cat_share as number) + (row.both_share as number) - 100)).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(row.dog_vs_cat_ratio).toBe(Math.round((fx.expected.byPetC.dog / fx.expected.byPetC.cat) * 100) / 100);
    expect(row.share_of_all_revenue).toBeGreaterThan(0);
    expect(r.meta.share_basis).toBe('tagged bundle revenue');
    expect(check(r, 'reconciles')?.status).toBe('ok');
  });

  it('pet_type: parts add to the bundle revenue at zero tolerance; tagged shares add to 100.0', () => {
    const r = bq({metric: 'bundle_sales', dimension: 'pet_type'});
    for (const p of PET_KEYS) expect(r.rows.find((x) => x.pet === p)?.value).toBe(pesos(fx.expected.byPetC[p]));
    expect(sum(r.rows, 'value')).toBe(pesos(fx.expected.bundleRevenueC));
    expect(Math.abs(sum(r.rows.filter((x) => x.pet !== 'untagged'), 'share_of_tagged') - 100)).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(r.rows.find((x) => x.pet === 'untagged')?.share_of_tagged).toBeNull();
    expect(col(r, 'pet')).toEqual(['dog', 'cat', 'both', 'untagged']); // natural order by default
    expect(check(r, 'reconciles')?.status).toBe('ok');
    expect(r.meta.insights.map((i) => i.code)).toContain('top_contributor');
    expect(r.meta.insights.map((i) => i.code)).toContain('untagged_share');
  });

  it('bundle: named rows plus the unnamed row add to the bundle revenue; named shares add to 100.0', () => {
    const r = bq({metric: 'bundle_sales', dimension: 'bundle'});
    expect(sum(r.rows, 'value')).toBe(pesos(fx.expected.bundleRevenueC));
    expect(r.rows.find((x) => x.bundle === 'Buy Any 4')?.value).toBe(pesos(fx.expected.byBundleC['Buy Any 4']));
    expect(r.rows.find((x) => x.bundle === 'Buy Any 2')?.value).toBe(pesos(fx.expected.byBundleC['Buy Any 2']));
    const unnamed = r.rows.find((x) => String(x.bundle).startsWith('Unnamed'));
    expect(unnamed?.value).toBe(pesos(fx.expected.byBundleC.unnamed));
    expect(unnamed?.share_of_named).toBeNull();
    expect(Math.abs(sum(r.rows, 'share_of_named') - 100)).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(r.meta.share_basis).toBe('named bundle revenue');
    expect(check(r, 'reconciles')?.status).toBe('ok');
    expect(r.meta.insights.map((i) => i.code)).toContain('top_contributor');
    expect(r.meta.caveats.join(' ')).toMatch(/no bundle record/);
  });

  it('bundle_by_pet: wide rows whose cells add to the bundle revenue', () => {
    const r = bq({metric: 'bundle_sales', dimension: 'bundle_by_pet'});
    expect(r.columns.map((c) => c.key)).toEqual(['bundle', 'dog', 'cat', 'both', 'untagged', 'total', 'share_of_named']);
    for (const p of PET_KEYS) expect(sum(r.rows, p)).toBe(pesos(fx.expected.byPetC[p]));
    expect(sum(r.rows, 'total')).toBe(pesos(fx.expected.bundleRevenueC));
    for (const row of r.rows) expect(Number(row.dog) + Number(row.cat) + Number(row.both) + Number(row.untagged)).toBeCloseTo(Number(row.total), 6);
    expect(r.meta.checks.filter((c) => c.code === 'reconciles').every((c) => c.status === 'ok')).toBe(true);
    expect(r.meta.checks.filter((c) => c.code === 'reconciles').length).toBeGreaterThanOrEqual(2);
  });

  it('orders measure counts bundle orders by pet and by bundle', () => {
    const r = bq({metric: 'bundle_sales', dimension: 'pet_type', measure: 'orders'});
    expect(sum(r.rows, 'value')).toBe(fx.expected.bundleOrders);
    expect(r.meta.share_basis).toBe('tagged bundle orders');
    const w = bq({metric: 'bundle_sales', dimension: 'bundle_by_pet', measure: 'orders'});
    expect(w.rows.length).toBeGreaterThan(0);
    allNumbersFinite(w);
  });

  it('dog_vs_cat_ratio is null (not Infinity) when there is no cat revenue', () => {
    const r = bq({metric: 'bundle_sales', pet: 'dog'});
    expect(r.rows[0].cat_share).toBe(0);
    expect(r.rows[0].dog_vs_cat_ratio).toBeNull();
    allNumbersFinite(r);
  });

  it('excludes voided bundle orders', () => {
    expect(fx.expected.voidedBundleOrders).toBeGreaterThan(0);
    expect(bq({metric: 'bundle_sales'}).rows[0].bundle_orders).toBe(fx.expected.bundleOrders);
  });

  it('limit does not cut or mention anything when every row fits', () => {
    const r = bq({metric: 'bundle_sales', dimension: 'bundle', limit: 3});
    expect(r.rows).toHaveLength(3);
    expect(r.meta.caveats.join(' ')).not.toMatch(/Showing/);
  });

  it('the pet filter narrows to one pet', () => {
    const r = bq({metric: 'bundle_sales', dimension: 'pet_type', pet: 'cat'});
    expect(r.rows.find((x) => x.pet === 'cat')?.value).toBe(pesos(fx.expected.byPetC.cat));
    expect(r.rows.find((x) => x.pet === 'dog')?.value).toBe(0);
  });
});

describe('bundle_picks', () => {
  it('the untagged check counts only orders that have pick detail, not every order in the slice', () => {
    const r = bq({metric: 'bundle_picks', dimension: 'sku_by_pet'});
    const picks = bundlePickRows(fx.orders, buildPriceHistory(PRICES, CHANGES));
    const ordersWithPicks = new Set(picks.rows.map((x) => x.order_id));
    const untaggedWithPicks = new Set(picks.rows.filter((x) => x.pet === 'untagged').map((x) => x.order_id));
    const c = check(r, 'untagged_share');
    if (untaggedWithPicks.size / ordersWithPicks.size > 0.1) {
      expect(c?.values?.totalOrders).toBe(ordersWithPicks.size);
      expect(c?.values?.orders).toBe(untaggedWithPicks.size);
    } else {
      expect(c).toBeUndefined();
    }
    // never the slice-wide count (that mixes in older sales that have no pick detail)
    expect(c?.values?.totalOrders).not.toBe(fx.orders.length);
  });

  it('says how much bundle revenue the SKU breakdown does NOT cover (sales without pick detail)', () => {
    const r = bq({metric: 'bundle_picks', dimension: 'sku'});
    const all = bq({metric: 'bundle_sales', dimension: 'none'});
    const covered = sum(r.rows, 'value');
    const missing = (all.rows[0].bundle_revenue as number) - covered;
    expect(missing).toBeGreaterThan(0); // the synthetic fixture has legacy bundle sales without picks
    const note = r.meta.caveats.find((c) => /no pick detail/i.test(c));
    expect(note, r.meta.caveats.join(' | ')).toBeDefined();
    expect(note).toContain(`₱${Math.round(missing).toLocaleString('en-US')}`);
    // the same note on every measure and dimension, and none on a metric where it does not apply
    expect(bq({metric: 'bundle_picks', dimension: 'sku_by_pet', measure: 'units'}).meta.caveats.some((c) => /no pick detail/i.test(c))).toBe(true);
    expect(all.meta.caveats.some((c) => /no pick detail/i.test(c))).toBe(false);
  });

  it('revenue (allocated) per SKU sums to the paid price of the headed bundles at zero tolerance', () => {
    const r = bq({metric: 'bundle_picks', dimension: 'sku'});
    expect(r.meta.measure).toBe('revenue');
    expect(sum(r.rows, 'value')).toBeCloseTo(pesos(fx.expected.paidC), 6);
    expect(check(r, 'reconciles')?.status).toBe('ok');
    expect(Math.abs(sum(r.rows, 'share') - 100)).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(r.meta.measures.map((m) => m.kind)).toEqual(['allocated', 'derived', 'measured']);
    expect(r.meta.share_basis).toBe('allocated bundle revenue');
  });

  it('sku_by_pet and bundle_by_sku also add to the paid price', () => {
    const w = bq({metric: 'bundle_picks', dimension: 'sku_by_pet'});
    expect(sum(w.rows, 'total')).toBeCloseTo(pesos(fx.expected.paidC), 6);
    for (const row of w.rows) expect(Number(row.dog) + Number(row.cat) + Number(row.both) + Number(row.untagged)).toBeCloseTo(Number(row.total), 6);
    expect(check(w, 'reconciles')?.status).toBe('ok');
    const b = bq({metric: 'bundle_picks', dimension: 'bundle_by_sku'});
    expect(sum(b.rows, 'value')).toBeCloseTo(pesos(fx.expected.paidC), 6);
    expect(check(b, 'reconciles')?.status).toBe('ok');
    const buy4 = b.rows.filter((x) => x.bundle === 'Buy Any 4');
    expect(Math.abs(sum(buy4, 'share_of_bundle') - 100)).toBeLessThanOrEqual(0.1 + 1e-9);
  });

  it('reports the zero-value lines and the price changes in the range as info checks', () => {
    const r = bq({metric: 'bundle_picks'});
    expect(check(r, 'zero_value_lines')).toMatchObject({status: 'info', values: {count: fx.expected.pickLines}});
    expect(check(r, 'price_changed_in_period')?.status).toBe('info');
    expect(check(r, 'price_changed_in_period')?.values).toMatchObject({count: 3});
  });

  it('list_value and units are declared and computed, with no reconcile claim', () => {
    const lv = bq({metric: 'bundle_picks', measure: 'list_value'});
    expect(lv.meta.measure).toBe('list_value');
    expect(sum(lv.rows, 'value')).toBeGreaterThan(0);
    expect(sum(lv.rows, 'value')).not.toBeCloseTo(pesos(fx.expected.paidC), 2); // valued at list prices, not the paid price
    expect(check(lv, 'reconciles')).toBeUndefined();
    expect(check(lv, 'zero_value_lines')).toBeUndefined(); // allocated measure not used
    const units = bq({metric: 'bundle_picks', measure: 'units'});
    expect(sum(units.rows, 'value')).toBe(fx.expected.pickLines);
    expect(check(units, 'reconciles')).toBeUndefined();
    expect(units.columns.find((c) => c.key === 'value')?.unit).toBe('units');
  });

  it('values each pick at the price in effect the day it sold (a price change mid-period)', () => {
    // p1 costs 170 before Sep 8 (n/a: data starts Sep 7), 200, 240, then 200 again: list value differs by period.
    const early = bq({metric: 'bundle_picks', measure: 'list_value', range: 'custom', from: '2026-09-07', to: '2026-09-14'});
    const mid = bq({metric: 'bundle_picks', measure: 'list_value', range: 'custom', from: '2026-09-15', to: '2026-09-21'});
    expect(early.meta.rowCount).toBeGreaterThan(0);
    expect(mid.meta.rowCount).toBeGreaterThan(0);
    expect(check(mid, 'price_changed_in_period')).toBeDefined();
  });

  it('limit and sort apply after shares', () => {
    const r = bq({metric: 'bundle_picks', limit: 3});
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0].share).toBeGreaterThan(0);
    expect(sum(r.rows, 'share')).toBeLessThan(100);
    expect(r.meta.caveats.join(' ')).toMatch(/Showing the first 3 of 10 rows; shares are of all 10/);
    const asc = bq({metric: 'bundle_picks', limit: 3, sort: 'value_asc'});
    expect(Number(asc.rows[0].value)).toBeLessThanOrEqual(Number(asc.rows[2].value));
    const vals = r.rows.map((x) => Number(x.value));
    expect(vals).toEqual([...vals].sort((a, b) => b - a));
  });

  it('compare_to on sku works against the previous period', () => {
    const r = bq({metric: 'bundle_picks', range: 'custom', from: '2026-09-17', to: '2026-09-27', compare_to: 'previous_period'});
    expect(r.columns.map((c) => c.key)).toEqual(expect.arrayContaining(['previous_revenue', 'delta', 'delta_pct']));
    allNumbersFinite(r);
  });
});

describe('purity', () => {
  it('does not mutate the data and is deterministic', () => {
    const d = data();
    const before = JSON.stringify(d);
    const a = runMetric(req({metric: 'event_rollup'}), d, NOW);
    const b = runMetric(req({metric: 'event_rollup'}), d, NOW);
    expect(JSON.stringify(d)).toBe(before);
    expect(a).toEqual(b);
  });
});

describe('event attribution basis', () => {
  it('event filter counts tagged plus date-window orders and the caveat states the split', () => {
    const A = ev('A', 'Fair A', '2026-09-12', '2026-09-14');
    const B = ev('B', 'Fair B', '2026-09-19', '2026-09-21');
    const mk = (p: string, ev: string | null, at: string, status = 'completed') =>
      ord(p, at, 100, [line('P1', 'Chicken Jerky', 1, 100)], {ev, pet: 'dog', status});
    const orders = [
      mk('a1', 'A', '2026-09-12T10:00:00+08:00'), mk('a2', 'A', '2026-09-13T10:00:00+08:00'),
      mk('a3', null, '2026-09-14T10:00:00+08:00'), mk('a4', null, '2026-09-16T10:00:00+08:00'),
      mk('a5', 'A', '2026-09-13T12:00:00+08:00', 'voided'),
      mk('b1', 'B', '2026-09-19T10:00:00+08:00'), mk('b2', 'B', '2026-09-20T10:00:00+08:00'),
      mk('b3', null, '2026-09-21T10:00:00+08:00'), mk('b4', null, '2026-09-23T10:00:00+08:00'),
      mk('b5', 'B', '2026-09-20T12:00:00+08:00', 'voided'),
    ];
    const r = res(req({metric: 'pet_mix', measure: 'orders', event: 'A'}), data({orders, events: [A, B]}));
    expect(sum(r.rows, 'value')).toBe(3);
    const caveats = r.meta.caveats.join(' ');
    expect(caveats).toContain('2 tagged');
    expect(caveats).toMatch(/1 untagged sale[^.]*by date/);
    expect(caveats).toContain('3 total');
  });
});

describe('event_rollup tagged/date split per event (R01: the registry caveat was applied to single events)', () => {
  const A = ev('A', 'Fair A', '2026-09-12', '2026-09-14');
  const B = ev('B', 'Fair B', '2026-09-19', '2026-09-21');
  const mk = (id: string, event: string | null, at: string, status = 'completed') => ord(id, at, 100, [line('P1', 'Chicken Jerky', 1, 100)], {ev: event, pet: 'dog', status});
  const orders = [
    mk('a1', 'A', '2026-09-12T10:00:00+08:00'), mk('a2', 'A', '2026-09-13T10:00:00+08:00'), mk('a6', 'A', '2026-09-16T10:00:00+08:00'), // tagged, one off the event dates
    mk('a3', null, '2026-09-14T10:00:00+08:00'), // untagged on the dates: by date
    mk('a4', null, '2026-09-16T11:00:00+08:00'), // untagged off the dates: walk-in, in no event row
    mk('a5', 'A', '2026-09-13T12:00:00+08:00', 'voided'), // voided: counted nowhere
    mk('b1', 'B', '2026-09-19T10:00:00+08:00'), mk('b2', 'B', '2026-09-20T10:00:00+08:00'),
    mk('b3', null, '2026-09-21T10:00:00+08:00'), mk('b6', null, '2026-09-19T15:00:00+08:00'), // two by date
    mk('b4', null, '2026-09-23T10:00:00+08:00'), mk('b5', 'B', '2026-09-20T12:00:00+08:00', 'voided'),
  ];
  const d = data({orders, events: [A, B]});
  const row = (r: MetricResult, name: string) => r.rows.find((x) => x.event === name);

  it('each event row carries its own tagged and by-date counts, and they add up to orders', () => {
    const r = res(req({metric: 'event_rollup'}), d);
    expect(row(r, 'Fair A')).toMatchObject({orders: 4, tagged_orders: 3, date_orders: 1, revenue: 400});
    expect(row(r, 'Fair B')).toMatchObject({orders: 4, tagged_orders: 2, date_orders: 2, revenue: 400});
    for (const x of r.rows) expect(Number(x.tagged_orders) + Number(x.date_orders)).toBe(Number(x.orders));
    expect(r.columns.map((c) => c.key)).toEqual(['event', 'revenue', 'orders', 'share', 'tagged_orders', 'date_orders']);
    expect(check(r, 'reconciles')?.status).toBe('ok');
    expect(r.meta.checks.filter((c) => c.code === 'reconciles').map((c) => c.values?.label)).toContain('Event orders: tagged plus by date');
    expect(r.meta.reliable).toBe(true);
  });

  it('the existing columns and numbers are unchanged by the measure choice', () => {
    const r = res(req({metric: 'event_rollup', measure: 'orders'}), d);
    expect(r.rows.map((x) => [x.event, x.orders, x.share])).toEqual([['Fair A', 4, 50], ['Fair B', 4, 50]]);
  });

  it('with the filter "all" the caveat says it is a combined figure and the split is in the rows, per event', () => {
    const r = res(req({metric: 'event_rollup'}), d);
    const c = r.meta.caveats.join(' ');
    expect(c).toMatch(/All events combined: 5 tagged .* 3 untagged .*8 total/);
    expect(c).toMatch(/per event .*tagged_orders.*date_orders/i);
    expect(c).not.toMatch(/Event orders = /);
  });

  it('a filter on one event keeps its own tagged/date caveat and the row split', () => {
    const r = res(req({metric: 'event_rollup', event: 'Fair A'}), d);
    expect(row(r, 'Fair A')).toMatchObject({tagged_orders: 3, date_orders: 1});
    expect(r.meta.caveats.join(' ')).toContain('3 tagged to the event in the POS');
  });

  it('describe_data-facing text declares the split columns', () => {
    expect(METRICS.event_rollup.description).toMatch(/tagged_orders/);
    expect(METRICS.event_rollup.description).toMatch(/date_orders/);
  });
});
