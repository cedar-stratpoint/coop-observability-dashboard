import {describe, expect, it} from 'vitest';
import {lookupProduct, PRODUCT_SHOWS} from '../src/chat/digest-lookup';
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
  return out;
};
const err = (input: unknown, d?: MetricData): string => {
  const out = call(input, d);
  if (!('error' in out)) throw new Error('expected an error');
  return out.error;
};

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

describe('lookup_product: steering errors (Slice 5 criterion 1)', () => {
  it('a missing SKU lists close matches and the exact-SKU next step', () => {
    const e = err({query: 'P7', show: 'details'});
    expect(e).toMatch(/No product has the SKU or name "P7"/);
    expect(e).toMatch(/Close matches: .*P\d \(/); // one-character slip: the nearest SKUs are suggested
    expect(e).toMatch(/exact SKU|one of these SKUs/);
    expect(e).toMatch(/top_products/);
  });

  it('a near-miss name suggests the product', () => {
    expect(err({query: 'chiken jerky', show: 'details'})).toMatch(/Close matches: P1 \(Chicken Jerky\)/);
    expect(err({query: 'salmon treat', show: 'details'})).toMatch(/Close matches: P2 \(Salmon Bites\)/);
  });

  it('a name that matches nothing at all points to top_products', () => {
    const e = err({query: 'zebra saddle', show: 'details'});
    expect(e).toMatch(/No product has the SKU or name "zebra saddle"/);
    expect(e).toMatch(/top_products/);
    expect(e).not.toMatch(/Close matches/);
  });

  it('an ambiguous name lists the matches and asks for the exact SKU', () => {
    const e = err({query: 'chicken', show: 'details'});
    expect(e).toMatch(/More than one product matches "chicken": P1 \(Chicken Jerky\), P5 \(Chicken Breast Strips\)/);
    expect(e).toMatch(/exact SKU/);
  });

  it('names the allowed values for a bad show, and refuses an empty or oversized query', () => {
    expect(err({query: 'P1', show: 'stock'})).toMatch(/Allowed values for show: details, price_history/);
    expect(PRODUCT_SHOWS).toEqual(['details', 'price_history']);
    expect(err({query: '   ', show: 'details'})).toMatch(/top_products/);
    expect(err({query: 'x'.repeat(81), show: 'details'})).toMatch(/too long/);
    expect(err(null)).toMatch(/show/);
  });

  it('says so when no product is known yet', () => {
    expect(err({query: 'P1', show: 'details'}, data({orders: []}))).toMatch(/No products are known yet/);
  });
});

describe('lookup_product through the executor and dispatch', () => {
  const ctx = (d: MetricData = data()) => ({data: async () => d, now: NOW, user: null});

  it('a missing SKU comes back is_error with the steering text (criterion 1), a hit does not', async () => {
    const ex = createExecutors(ctx());
    const miss = await dispatchToolCall({name: 'lookup_product', input: {query: 'NOPE-1', show: 'details'}}, ex);
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
