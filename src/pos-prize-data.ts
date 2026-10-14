import 'server-only';
import {cache} from 'react';
import {posClient, usingPosMock, getPosProducts} from './pos-data';
import {getLocationStock} from './pos-location-data';
import {fetchAllRows} from './pos-fetch-paginate';

// SERVER-ONLY. Data for the Prizes panel: the won free items (joined to their
// order + customer), a list of recent orders to attach a backfilled prize to, and
// the product list with Event on-hand. Read live (the offline-sales page is
// force-dynamic), so no unstable_cache here.

export interface PrizeRow {
  id: string;
  client_uuid: string | null;
  product_id: string;
  product_name: string;
  qty: number;
  oversold: boolean;
  note: string | null;
  won_at: string;
  voided_at: string | null;
  order_client_uuid: string | null;
  customer_handle: string | null;
  order_at: string | null;
  event_id: string | null; // the order's POS event tag (null = untagged; the page resolves by date)
}

export interface RecentOrder {
  client_uuid: string;
  label: string; // customer + date + total, for the picker
}

export interface PrizeProduct {
  product_id: string;
  name: string;
  event: number;
}

export interface PrizeData {
  prizes: PrizeRow[];
  recentOrders: RecentOrder[];
  products: PrizeProduct[];
}

const EMPTY: PrizeData = {prizes: [], recentOrders: [], products: []};

const peso = (n: number) => `₱${Math.round(n).toLocaleString('en-PH')}`;
const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-PH', {month: 'short', day: 'numeric'}) : '—';

/** The non-voided prizes already on ONE order, plus the pickable in-stock products.
 *  Powers the "Free items won" section of the Edit-order modal (backfill path). */
export interface OrderPrizeContext {
  prizes: {client_uuid: string; product_name: string; qty: number}[];
  products: PrizeProduct[]; // catalog entries with Event on-hand > 0, sorted by name
}

export const getOrderPrizeContext = cache(async (orderClientUuid: string): Promise<OrderPrizeContext> => {
  if (usingPosMock() || !orderClientUuid) return {prizes: [], products: []};
  const supabase = posClient();

  const [prizeRes, products, locations] = await Promise.all([
    // Inner-join to pos_orders so we can filter the prizes by the order's client_uuid
    // (prize.order_id → pos_orders.id). Only the live (non-voided) prizes, newest first.
    supabase
      .from('pos_order_prizes')
      .select('client_uuid,product_id,qty,won_at,pos_orders!inner(client_uuid)')
      .eq('pos_orders.client_uuid', orderClientUuid)
      .is('voided_at', null)
      .order('won_at', {ascending: false}), // pagination-ok: bounded to ONE order's non-voided prizes (.eq on a single client_uuid)
    getPosProducts(),
    getLocationStock().catch(() => []),
  ]);
  if (prizeRes.error) throw new Error(`pos_order_prizes read failed: ${prizeRes.error.message}`);

  const nameById = new Map(products.map((p) => [p.product_id, p.name]));
  const eventById = new Map(locations.map((l) => [l.product_id, l.event]));

  const prizes = (prizeRes.data ?? [])
    .filter((r) => r.client_uuid != null)
    .map((r) => ({
      client_uuid: r.client_uuid as string,
      product_name: nameById.get(r.product_id as string) ?? (r.product_id as string),
      qty: Number(r.qty ?? 0),
    }));

  const pickable: PrizeProduct[] = products
    .map((p) => ({product_id: p.product_id, name: p.name, event: eventById.get(p.product_id) ?? 0}))
    .filter((p) => p.event > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {prizes, products: pickable};
});

/** The DISTINCT client_uuids of orders that carry at least one NON-voided prize.
 *  Powers the "Free item" badge on the offline-sales order tiles. Inner-joins to
 *  pos_orders (prize.order_id → pos_orders.id) so we can read the order's
 *  client_uuid, filtered to live prizes only. Mock/empty-safe. */
export const getOrdersWithPrizes = cache(async (): Promise<string[]> => {
  if (usingPosMock()) return [];
  const supabase = posClient();

  // Paged via fetchAllRows (ordered by the pos_order_prizes PK `id`) so this
  // whole-table scan can't be silently capped at db.max_rows (1000).
  const data = await fetchAllRows('pos_order_prizes', (from, to) =>
    supabase
      .from('pos_order_prizes')
      .select('pos_orders!inner(client_uuid)')
      .is('voided_at', null)
      .order('id', {ascending: true})
      .range(from, to));

  const uuids = new Set<string>();
  for (const row of data) {
    const ord = pickOne((row as {pos_orders: unknown}).pos_orders) as {client_uuid: string | null} | null;
    if (ord?.client_uuid) uuids.add(ord.client_uuid);
  }
  return [...uuids];
});

export const getPrizeData = cache(async (): Promise<PrizeData> => {
  if (usingPosMock()) return EMPTY;
  const supabase = posClient();

  const [prizeRes, ordersRes, products, locations] = await Promise.all([
    supabase
      .from('pos_order_prizes')
      .select('id,client_uuid,product_id,qty,oversold,note,won_at,voided_at,pos_orders(client_uuid,customer_handle,created_at,event_id)')
      .order('won_at', {ascending: false})
      .limit(200),
    supabase
      .from('pos_orders')
      .select('client_uuid,customer_handle,created_at,total,status')
      .eq('status', 'completed')
      .not('client_uuid', 'is', null)
      .order('created_at', {ascending: false})
      .limit(100),
    getPosProducts(),
    getLocationStock().catch(() => []),
  ]);
  if (prizeRes.error) throw new Error(`pos_order_prizes read failed: ${prizeRes.error.message}`);
  if (ordersRes.error) throw new Error(`pos_orders read failed: ${ordersRes.error.message}`);

  const nameById = new Map(products.map((p) => [p.product_id, p.name]));
  const eventById = new Map(locations.map((l) => [l.product_id, l.event]));

  const prizes: PrizeRow[] = (prizeRes.data ?? []).map((r) => {
    const ord = pickOne(r.pos_orders) as {client_uuid: string | null; customer_handle: string | null; created_at: string | null; event_id: string | null} | null;
    return {
      id: r.id as string,
      client_uuid: (r.client_uuid as string | null) ?? null,
      product_id: r.product_id as string,
      product_name: nameById.get(r.product_id as string) ?? (r.product_id as string),
      qty: Number(r.qty ?? 0),
      oversold: Boolean(r.oversold),
      note: (r.note as string | null) ?? null,
      won_at: r.won_at as string,
      voided_at: (r.voided_at as string | null) ?? null,
      order_client_uuid: ord?.client_uuid ?? null,
      customer_handle: ord?.customer_handle ?? null,
      order_at: ord?.created_at ?? null,
      event_id: ord?.event_id ?? null,
    };
  });

  const recentOrders: RecentOrder[] = (ordersRes.data ?? []).map((o) => {
    const who = (o.customer_handle as string | null)?.trim() || 'Walk-in';
    return {
      client_uuid: o.client_uuid as string,
      label: `${who} · ${shortDate(o.created_at as string | null)} · ${peso(Number(o.total ?? 0))}`,
    };
  });

  const productList: PrizeProduct[] = products.map((p) => ({
    product_id: p.product_id,
    name: p.name,
    event: eventById.get(p.product_id) ?? 0,
  }));

  return {prizes, recentOrders, products: productList};
});

function pickOne<T>(embedded: T | T[] | null | undefined): T | null {
  if (Array.isArray(embedded)) return embedded[0] ?? null;
  return embedded ?? null;
}
