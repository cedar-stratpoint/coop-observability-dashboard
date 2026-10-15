import type {PosEvent} from '../../pos-sales-types';
import {fetchAllRows} from '../../pos-fetch-paginate';
import type {ReadClient} from '../../pos-orders-read';
import type {MetricData} from '../result-types';
import {readChatOrders} from './pos-orders';
import {loadStockData, type StockReadClient} from './stock-data';
import {relationsForMode, type ChatReadMode} from './relations';

// Loads everything the pure metric executor needs, through the guarded chat read client:
// orders (with lines), events, the price lookup and the price-change log. Every bulk read is
// paged with fetchAllRows (PostgREST caps a response at 1,000 rows), ordered by a unique key,
// and selects explicit columns (never `*`, never a customer or staff column).
// No server-only, no src/pos-data.ts, no src/data.ts: the client is injected.

const text = (v: unknown): string | null => (v == null ? null : String(v));

export async function loadMetricData(client: ReadClient, mode: ChatReadMode): Promise<MetricData> {
  const {tables, columns} = relationsForMode(mode);
  const [orders, events, prices, changes, stock] = await Promise.all([
    readChatOrders(client, mode),
    fetchAllRows(tables.events, (from, to) =>
      client.from(tables.events).select(columns.events).order('event_id', {ascending: true}).range(from, to)),
    fetchAllRows(tables.prices, (from, to) =>
      client.from(tables.prices).select(columns.prices).order('product_id', {ascending: true}).range(from, to)),
    fetchAllRows(tables.priceChanges, (from, to) =>
      client.from(tables.priceChanges).select(columns.priceChanges).order('id', {ascending: true}).range(from, to)),
    // in parallel with the sales reads, so it does not add to the turn's 50 s budget; never rejects (a failed read is null)
    loadStockData(client as unknown as StockReadClient, mode, new Date()),
  ]);

  return {
    source: 'live',
    orders,
    events: events.map((e): PosEvent => ({
      event_id: String(e.event_id),
      name: text(e.name),
      venue: text(e.venue),
      city: text(e.city),
      organizer: null,
      starts_on: text(e.starts_on),
      ends_on: text(e.ends_on),
      opening_cash: null,
      cash_note: null,
      closing_cash: null,
      status: text(e.status) ?? 'active',
      created_by: null,
      created_at: text(e.created_at),
      updated_at: null,
    })),
    prices: prices.map((p) => ({product_id: String(p.product_id), price: Number(p.price ?? 0)})),
    priceChanges: changes.map((c) => ({
      product_id: String(c.product_id),
      old_price: c.old_price == null ? null : Number(c.old_price),
      new_price: Number(c.new_price ?? 0),
      changed_at: String(c.changed_at),
    })),
    stock,
    // Orders and lines are read together by readChatOrders: their counts are the orders and the attached lines.
    bulkReads: [
      {relation: tables.orders, rows: orders.length},
      {relation: tables.items, rows: orders.reduce((n, o) => n + o.items.length, 0)},
      {relation: tables.events, rows: events.length},
      {relation: tables.prices, rows: prices.length},
      {relation: tables.priceChanges, rows: changes.length},
    ],
  };
}
