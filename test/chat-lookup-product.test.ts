import {describe, expect, it} from 'vitest';
import {lookupProduct, PRODUCT_SHOWS} from '../src/chat/digest-lookup';
import {recommendView} from '../src/chat/recommend-view';
import {createExecutors} from '../src/chat/tool-executors';
import {dispatchToolCall} from '../src/chat/tools';
import type {MetricData} from '../src/chat/result-types';
import type {PosOrder, PosOrderLine} from '../src/pos-sales-types';

// F10 lookup_product (design Slice 5 criterion 1): resolves against the products already in the chat's MetricData
// (order lines carry the SKU and name; prices and price changes come from the same data). No new data source.
const NOW = new Date('2026-10-01T04:00:00Z');

const line = (sku: string | null, name: string, qty: number, unit: number, extra: Partial<PosOrderLine> = {}): PosOrderLine => ({product_id: sku, name, qty, unit_price: unit, line_total: qty * unit, ...extra});
const order = (id: string, day: string, items: PosOrderLine[], status = 'completed'): PosOrder => ({
  id, client_uuid: id, subtotal: 0, discount: null, total: 0, oversold: false, device_id: null, payment_method: 'cash', customer_handle: null,
  status, remarks: null, created_at: `${day}T10:00:00+08:00`, edited_at: null, event_id: null, pet_type: null, items,
});

const data = (over: Partial<MetricData> = {}): MetricData => ({
  source: 'live',
  orders: [
    order('o1', '2026-09-02', [line('P1', 'Chicken Jerky', 2, 250)]),
    order('o2', '2026-09-05', [line('P1', 'Chicken Jerky', 1, 250), line('P2', 'Salmon Bites', 1, 250)]),
    order('o3', '2026-09-09', [line(null, 'Party Pack', 1, 899, {bundle_id: 'B2', bundle_group: 'g1'}), line('P1', 'Chicken Jerky', 3, 0, {bundle_group: 'g1'}), line('P3', 'Dental Chews', 2, 0, {bundle_group: 'g1'})]),
    order('o4', '2026-09-20', [line('P1', 'Chicken Jerky', 5, 250)], 'voided'), // voided: never counted
    order('o5', '2026-09-21', [line('P4', 'Beef Strips', 1, 120), line('P5', 'Chicken Breast Strips', 1, 130)]),
  ],
  events: [],
  prices: [{product_id: 'P1', price: 260}, {product_id: 'P2', price: 250}],
  priceChanges: [
    {product_id: 'P1', old_price: 250, new_price: 260, changed_at: '2026-09-15T02:00:00Z'},
    {product_id: 'P1', old_price: null, new_price: 250, changed_at: '2026-09-01T02:00:00Z'},
    {product_id: 'P2', old_price: 240, new_price: 250, changed_at: '2026-09-03T02:00:00Z'},
  ],
  bulkReads: [],
  ...over,
});

const call = (input: unknown, d: MetricData = data()) => lookupProduct(input, d);
const ok = (input: unknown, d?: MetricData) => {
  const out = call(input, d);
  if ('error' in out) throw new Error(out.error);
  if ('clarify' in out) throw new Error(`asked: ${out.clarify.question}`);
  return out;
};
const asks = (input: unknown, d?: MetricData) => {
  const out = call(input, d);
  if (!('clarify' in out)) throw new Error('expected a clarifying question');
  return out.clarify;
};
const err = (input: unknown, d?: MetricData): string => {
  const out = call(input, d);
  if (!('error' in out)) throw new Error('expected an error');
  return out.error;
};

describe('lookup_product: sales in dates (direct, bundle share, combined)', () => {
  it('gives direct, bundle (equal share per unit and by list price) and the combined total in one row; voided excluded', () => {
    const r = ok({query: 'P1', show: 'sales', from: '2026-09-01', to: '2026-09-30'});
    expect(r.rows).toEqual([{
      name: 'Chicken Jerky', direct_orders: 2, direct_units: 3, direct_revenue: 750,
      bundle_orders: 1, bundle_units: 3, bundle_revenue: 539.4, bundle_revenue_by_list_price: 899,
      total_units: 6, total_revenue: 1289.4,
    }]);
    expect(r.meta.range.label).toMatch(/Sep/);
    expect(r.meta.caveats.join(' ')).toMatch(/equal share per unit/);
  });
  it('limits to the dates, and "" and "" means all available data', () => {
    expect(ok({query: 'P1', show: 'sales', from: '2026-09-06', to: '2026-09-30'}).rows[0]).toMatchObject({direct_units: 0, bundle_units: 3});
    expect(ok({query: 'P1', show: 'sales', from: '', to: ''}).rows[0]).toMatchObject({direct_units: 3, total_units: 6});
  });
  it('refuses a bad or reversed date', () => {
    expect(err({query: 'P1', show: 'sales', from: '2026-13-01', to: '2026-09-30'})).toMatch(/real dates/);
    expect(err({query: 'P1', show: 'sales', from: '2026-09-30', to: '2026-09-01'})).toMatch(/from is after to/);
  });
});

describe('lookup_product: found', () => {
  it('counts a SKU from completed orders: direct and in-bundle units apart, direct revenue only, voided excluded', () => {
    const r = ok({query: 'P1', show: 'details'});
    expect(r.meta.source).toBe('live');
    expect(r.metric).toBe('product_lookup');
    expect(r.rows).toEqual([
      {sku: 'P1', name: 'Chicken Jerky', price: 260, units_direct: 3, units_in_bundles: 3, revenue_direct: 750, orders: 3, first_sold: '2026-09-02', last_sold: '2026-09-09'},
    ]);
    expect(r.meta.measures[0].method).toMatch(/not voided/);
    expect(r.meta.caveats.join(' ')).toMatch(/This lookup has no stock levels/);
  });

  it('matches a SKU or an exact name without regard to case, and a unique partial name', () => {
    expect(ok({query: 'p1', show: 'details'}).rows[0].sku).toBe('P1');
    expect(ok({query: 'salmon bites', show: 'details'}).rows[0].sku).toBe('P2');
    expect(ok({query: 'salmon', show: 'details'}).rows[0].sku).toBe('P2');
    expect(ok({query: '  Beef  ', show: 'details'}).rows[0].sku).toBe('P4');
  });

  it('prefers an exact SKU over a partial name hit (P1 is also a part of nothing else here)', () => {
    expect(ok({query: 'P3', show: 'details'}).rows[0]).toMatchObject({sku: 'P3', units_direct: 0, units_in_bundles: 2, revenue_direct: 0, price: null});
  });

  it('says when a product has no current price, and lists its recorded price changes oldest first', () => {
    expect(ok({query: 'P3', show: 'details'}).meta.caveats.join(' ')).toMatch(/No current price/);
    const h = ok({query: 'P1', show: 'price_history'});
    expect(h.dimension).toBe('price_history');
    expect(h.rows).toEqual([
      {changed_on: '2026-09-01', old_price: null, new_price: 250},
      {changed_on: '2026-09-15', old_price: 250, new_price: 260},
    ]);
    expect(ok({query: 'P3', show: 'price_history'}).rows).toEqual([]);
    expect(ok({query: 'P3', show: 'price_history'}).meta.caveats.join(' ')).toMatch(/No price change is recorded/);
  });

  it('flags sample data', () => {
    const r = ok({query: 'P1', show: 'details'}, data({source: 'mock'}));
    expect(r.meta.source).toBe('mock');
    expect(r.meta.checks.some((c) => c.code === 'mock_source')).toBe(true);
  });
});

describe('lookup_product: confirms instead of guessing (owner rule 2026-10-19)', () => {
  it('a near-miss SKU offers the nearest SKUs as choices', () => {
    const q = asks({query: 'P7', show: 'details'});
    expect(q.question).toMatch(/Which product did you mean by "P7"/);
    expect(q.options).toContain('Chicken Jerky (P1)');
  });

  it('a misspelled name asks "Did you mean" with the product as the one choice', () => {
    expect(asks({query: 'chiken jerky', show: 'details'})).toEqual({question: 'Did you mean **Chicken Jerky**?', options: ['Chicken Jerky (P1)']});
  });

  it('a name with one unknown word offers the products that share a word', () => {
    expect(asks({query: 'salmon treat', show: 'details'}).options).toContain('Salmon Bites (P2)');
  });

  it('a name that matches nothing at all is a steering error pointing to top_products', () => {
    const e = err({query: 'zebra saddle', show: 'details'});
    expect(e).toMatch(/No product has the SKU or name "zebra saddle"/);
    expect(e).toMatch(/top_products/);
  });

  it('an ambiguous name offers every match', () => {
    const q = asks({query: 'chicken', show: 'details'});
    expect(q.question).toMatch(/Which product did you mean by "chicken"/);
    expect(q.options).toEqual(['Chicken Jerky (P1)', 'Chicken Breast Strips (P5)']);
  });

  it('knows products from the POS catalog that never sold', () => {
    const d = data({stock: {byLocation: [], names: {P9: 'Duck Necks'}, sales: [], config: {} as never, asOf: NOW.toISOString()}});
    expect(ok({query: 'duck necks', show: 'details'}, d).rows[0]).toMatchObject({sku: 'P9', name: 'Duck Necks', units_direct: 0, orders: 0});
  });

  it('names the allowed values for a bad show, and refuses an empty or oversized query', () => {
    expect(err({query: 'P1', show: 'inventory'})).toMatch(/Allowed values for show: details, price_history, stock/);
    expect(PRODUCT_SHOWS).toEqual(['details', 'price_history', 'stock', 'sales']);
    expect(err({query: '   ', show: 'details'})).toMatch(/top_products/);
    expect(err({query: 'x'.repeat(81), show: 'details'})).toMatch(/too long/);
    expect(err(null)).toMatch(/show/);
  });

  it('says so when no product is known yet', () => {
    expect(err({query: 'P1', show: 'details'}, data({orders: []}))).toMatch(/No products are known yet/);
  });
});

describe('lookup_product show "stock" (B1): one product, per location and in total, as of now', () => {
  const withStock = (byLocation: {product_id: string; location: string; stock: number}[]) =>
    data({stock: {byLocation, names: {P1: 'Chicken Jerky', P9: 'Duck Necks'}, sales: [], config: {} as never, asOf: '2026-10-19T02:30:00Z'}});

  it('one row: a column per location with a plain label, then the total; no dates; draws as stat tiles', () => {
    const r = ok({query: 'P1', show: 'stock'}, withStock([{product_id: 'P1', location: 'office', stock: 18}, {product_id: 'P1', location: 'event', stock: 42}, {product_id: 'P2', location: 'event', stock: 5}]));
    expect(r.dimension).toBe('stock');
    expect(r.rows).toEqual([{product: 'Chicken Jerky (P1)', event_units: 42, office_units: 18, stock_units: 60}]);
    expect(r.columns.map((c) => c.label)).toEqual(['Product', 'Event (sellable)', 'Office (back)', 'Total']);
    expect(recommendView(r, {kind: 'auto', orientation: 'auto'}).decisions[0].block).toBe('kpi');
    expect(r.meta.range.label).toBe('as of now');
    expect(r.meta.caveats[0]).toBe('Chicken Jerky (P1): offline (POS) stock as of now (2026-10-19 10:30 PHT); stock has no date range.');
  });

  it('a product with no stock row anywhere says the total is 0 on purpose', () => {
    const r = ok({query: 'duck necks', show: 'stock'}, withStock([]));
    expect(r.rows).toEqual([{product: 'Duck Necks (P9)', stock_units: 0}]);
    expect(r.meta.caveats.join(' ')).toMatch(/No stock is recorded for this product at any location/);
  });

  it('a misspelled name still asks first, before any stock is read', () => {
    expect(asks({query: 'chiken jerky', show: 'stock'}, withStock([]))).toMatchObject({question: 'Did you mean **Chicken Jerky**?'});
  });

  it('stock that could not be read is said, never 0', () => {
    expect(err({query: 'P1', show: 'stock'}, data({stock: null}))).toMatch(/Stock data is not available right now/);
  });
});

describe('lookup_product through the executor and dispatch', () => {
  const ctx = (d: MetricData = data()) => ({data: async () => d, now: NOW, user: null});

  it('a missing SKU comes back is_error with the steering text (criterion 1), a hit does not', async () => {
    const ex = createExecutors(ctx());
    const miss = await dispatchToolCall({name: 'lookup_product', input: {query: 'zebra saddle', show: 'details'}}, ex);
    expect(miss.is_error).toBe(true);
    expect((miss.content as {error: string}).error).toMatch(/top_products/);
    const hit = await dispatchToolCall({name: 'lookup_product', input: {query: 'P2', show: 'details'}}, ex);
    expect(hit.is_error).toBe(false);
    expect(hit.content).toMatchObject({id: 'r1', metric: 'product_lookup', rows: [{sku: 'P2', price: 250}]});
  });

  it('stores the result so it can be drawn, and uses the same data the metrics use (no new source)', async () => {
    const d = data();
    let loads = 0;
    const blocks: unknown[] = [];
    const ex = createExecutors({data: async () => ((loads += 1), d), now: NOW, user: null, emitBlock: (b) => blocks.push(b)});
    await ex.lookup_product?.({query: 'P1', show: 'price_history'});
    await ex.render_chart?.({block: 'new', source: 'r1', kind: 'auto', orientation: 'auto', x: 'auto', y: ['auto'], title: 'Chart'});
    const drawn = (await ex.render_table?.({block: 'new', source: 'r1', columns: ['auto'], title: 'P1 prices'})) as {error?: string};
    expect(drawn.error).toBeUndefined();
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(loads).toBe(1); // loaded once and shared
  });
});
