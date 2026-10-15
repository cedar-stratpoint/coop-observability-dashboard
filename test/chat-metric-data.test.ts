import {describe, it, expect} from 'vitest';
import {loadMetricData} from '../src/chat/read/metric-data';
import {relationsForMode, FORBIDDEN_COLUMNS, CHAT_READ_MODES} from '../src/chat/read/relations';
import type {ReadClient} from '../src/pos-orders-read';

type Row = Record<string, unknown>;
interface Call {relation: string; columns: string; orders: string[]; ranges: [number, number][]}

/** Fake paged client: honors .range(), caps each response at 1000 rows like PostgREST. */
function fakeClient(tables: Record<string, Row[]>) {
  const calls: Call[] = [];
  const client: ReadClient = {
    from(relation) {
      return {
        select(columns) {
          const call: Call = {relation, columns, orders: [], ranges: []};
          calls.push(call);
          const rows = tables[relation] ?? [];
          let from = 0;
          let to = 999;
          const builder = {
            order: (c: string) => {
              call.orders.push(c);
              return builder;
            },
            range: (f: number, t: number) => {
              from = f;
              to = t;
              call.ranges.push([f, t]);
              return builder;
            },
            // the stock loader's filters (Task 8): the fake ignores them, the loader test pins their use
            eq: () => builder,
            gte: () => builder,
            limit: () => builder,
            then: <R1, R2>(ok?: (v: {data: Row[]; error: null}) => R1, no?: (e: unknown) => R2) =>
              Promise.resolve({data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null}).then(ok, no),
          };
          return builder as never;
        },
      };
    },
  };
  return {client, calls};
}

function tablesFor(mode: (typeof CHAT_READ_MODES)[number], sizes: {orders: number; items: number; prices: number; changes: number}) {
  const t = relationsForMode(mode).tables;
  const orders = Array.from({length: sizes.orders}, (_, i) => ({
    id: `o${i}`, subtotal: 100, discount: 0, total: '100', oversold: false, payment_method: i % 2 ? 'gcash' : null, status: 'completed',
    created_at: '2026-09-20T10:00:00Z', edited_at: null, event_id: null, pet_type: 'dog',
  }));
  return {
    [t.orders]: orders,
    [t.items]: Array.from({length: sizes.items}, (_, i) => ({order_id: `o${i % sizes.orders}`, product_id: 'P1', bundle_id: null, bundle_group: null, qty: 1, unit_price: 100, line_total: 100})),
    [t.products]: [{product_id: 'P1', name: 'Chicken Jerky'}],
    [t.bundles]: [{bundle_id: 'B1', name: 'Starter Box'}],
    [t.events]: [
      {event_id: 'EV2', name: 'Bazaar', venue: 'Mall', city: 'Makati', starts_on: '2026-09-26', ends_on: '2026-09-27', status: 'closed', created_at: '2026-09-01T00:00:00Z'},
      {event_id: 'EV1', name: 'Fair', venue: null, city: null, starts_on: '2026-09-12', ends_on: null, status: null, created_at: null},
    ],
    [t.prices]: Array.from({length: sizes.prices}, (_, i) => ({product_id: `P${i}`, price: String(100 + i)})),
    [t.priceChanges]: Array.from({length: sizes.changes}, (_, i) => ({id: i + 1, product_id: 'P1', old_price: i === 0 ? null : '100', new_price: '120', changed_at: '2026-09-15T02:00:00Z'})),
    [t.stock]: [{product_id: 'P1', location: 'event', stock: 5}],
    [t.saleMovements]: [],
    [t.stockConfig]: [],
  };
}

describe('relations (extended)', () => {
  it('both modes declare events, prices and priceChanges with explicit columns', () => {
    for (const mode of CHAT_READ_MODES) {
      const r = relationsForMode(mode);
      expect(r.allowed).toHaveLength(10); // seven order relations + the three stock relations (Task 8)
      for (const k of ['events', 'prices', 'priceChanges'] as const) {
        expect(r.tables[k]).toBeTruthy();
        expect(r.columns[k]).not.toContain('*');
      }
    }
    expect(relationsForMode('ro_role').tables).toMatchObject({events: 'coop_chat_events', prices: 'coop_chat_prices', priceChanges: 'coop_chat_price_changes'});
    expect(relationsForMode('guarded_service').tables).toMatchObject({events: 'pos_events', prices: 'pos_prices', priceChanges: 'pos_price_changes'});
  });

  it('forbids the staff and cash columns while keeping every earlier entry', () => {
    for (const c of ['customer_handle', 'remarks', 'phone', 'email', 'instagram', 'customer_name', 'client_uuid', 'device_id']) expect(FORBIDDEN_COLUMNS).toContain(c);
    for (const c of ['created_by', 'updated_by', 'changed_by', 'opening_cash', 'closing_cash', 'cash_note', 'organizer']) expect(FORBIDDEN_COLUMNS).toContain(c);
  });
});

describe('loadMetricData', () => {
  for (const mode of CHAT_READ_MODES) {
    describe(mode, () => {
      it('reads every row across pages, including 1,352 item rows', async () => {
        const {client} = fakeClient(tablesFor(mode, {orders: 1100, items: 1352, prices: 1010, changes: 3}));
        const data = await loadMetricData(client, mode);
        expect(data.source).toBe('live');
        expect(data.orders).toHaveLength(1100);
        expect(data.orders.reduce((n, o) => n + o.items.length, 0)).toBe(1352);
        expect(data.prices).toHaveLength(1010);
        expect(data.priceChanges).toHaveLength(3);
        expect(data.events).toHaveLength(2);
      });

      it('reads the relations of its mode, never selects * or a forbidden column, and orders by a key', async () => {
        const {client, calls} = fakeClient(tablesFor(mode, {orders: 3, items: 4, prices: 2, changes: 1}));
        await loadMetricData(client, mode);
        const rel = relationsForMode(mode);
        // products is read once for the orders and once for the stock names
        expect([...new Set(calls.map((c) => c.relation))].sort()).toEqual(Object.values(rel.tables).sort());
        for (const c of calls) {
          expect(c.columns).not.toContain('*');
          for (const col of FORBIDDEN_COLUMNS) expect(c.columns.split(','), `${c.relation}.${col}`).not.toContain(col);
          if (c.relation === rel.tables.stockConfig) continue; // one row by key (limit 1), not paged
          expect(c.orders.length, c.relation).toBeGreaterThan(0);
          expect(c.ranges.length, c.relation).toBeGreaterThan(0);
        }
        expect(calls.find((c) => c.relation === rel.tables.events)?.orders).toEqual(['event_id']);
        expect(calls.find((c) => c.relation === rel.tables.prices)?.orders).toEqual(['product_id']);
        expect(calls.find((c) => c.relation === rel.tables.priceChanges)?.orders).toEqual(['id']);
      });

      it('pages a table that is exactly one page and one that spans pages (extra request on a full page)', async () => {
        const {client, calls} = fakeClient(tablesFor(mode, {orders: 3, items: 3, prices: 1000, changes: 1}));
        await loadMetricData(client, mode);
        const rel = relationsForMode(mode);
        expect(calls.filter((c) => c.relation === rel.tables.prices)).toHaveLength(2);
      });

      it('maps events with the cash and staff fields null, prices to numbers and changes with a nullable old price', async () => {
        const {client} = fakeClient(tablesFor(mode, {orders: 2, items: 2, prices: 2, changes: 2}));
        const data = await loadMetricData(client, mode);
        expect(data.events[0]).toEqual({
          event_id: 'EV2', name: 'Bazaar', venue: 'Mall', city: 'Makati', organizer: null,
          starts_on: '2026-09-26', ends_on: '2026-09-27', opening_cash: null, cash_note: null, closing_cash: null,
          status: 'closed', created_by: null, created_at: '2026-09-01T00:00:00Z', updated_at: null,
        });
        expect(data.events[1]).toMatchObject({event_id: 'EV1', venue: null, ends_on: null, status: 'active', created_at: null});
        expect(data.prices[1]).toEqual({product_id: 'P1', price: 101});
        expect(data.priceChanges[0]).toEqual({product_id: 'P1', old_price: null, new_price: 120, changed_at: '2026-09-15T02:00:00Z'});
        expect(data.priceChanges[1].old_price).toBe(100);
      });

      it('reports bulkReads row counts for each relation', async () => {
        const {client} = fakeClient(tablesFor(mode, {orders: 5, items: 8, prices: 4, changes: 2}));
        const t = relationsForMode(mode).tables;
        const data = await loadMetricData(client, mode);
        expect(data.bulkReads).toEqual([
          {relation: t.orders, rows: 5},
          {relation: t.items, rows: 8},
          {relation: t.events, rows: 2},
          {relation: t.prices, rows: 4},
          {relation: t.priceChanges, rows: 2},
        ]);
      });
    });
  }

  it('works on empty tables', async () => {
    const {client} = fakeClient({});
    const data = await loadMetricData(client, 'ro_role');
    expect(data.orders).toEqual([]);
    expect(data.bulkReads.every((b) => b.rows === 0)).toBe(true);
  });
});
