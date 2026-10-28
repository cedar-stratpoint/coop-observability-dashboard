import 'server-only';
import {cache} from 'react';
import {unstable_noStore as noStore, unstable_cache} from 'next/cache';
import {posClient, usingPosMock} from './pos-data';
import {POS_TAGS, POS_CACHE_REVALIDATE} from './pos-cache';
import type {PetType, PosEvent, PosOrder, PosOrderLine, PosOrdersFilter, PosSyncEntry, PriceBounds} from './pos-sales-types';
import {
  boundsFromMax,
  computeKpis,
  DEFAULT_ORDERS_FILTER,
  filterOrders,
  paginate,
  priceBounds,
  type PageInfo,
} from './pos-sales-compute';
import {MOCK_POS_EVENTS, MOCK_POS_ORDERS, MOCK_POS_SYNC_LOG} from './pos-sales-mock';
import {fetchAllRows} from './pos-fetch-paginate';
import {readPosOrders} from './pos-orders-read';

/** Normalize a raw pet_type cell to the union, unknown/absent -> null. */
function normalizePetType(raw: unknown): PetType | null {
  return raw === 'dog' || raw === 'cat' || raw === 'both' ? raw : null;
}

/**
 * The transactions filter expressed as PostgREST operations, so the exact same
 * predicates apply to both the count (head) query and the row-range query. A
 * 'cash' filter also matches legacy null rows, mirroring how the UI labels them.
 * Returned as data (not a builder wrapper) to avoid the deep generic
 * instantiation that wrapping the Supabase builder type triggers.
 */
type OrderFilterOp =
  | ['or', string]
  | ['eq', string, string]
  | ['gte', string, string | number]
  | ['lte', string, string | number];

function orderFilterOps(filter: PosOrdersFilter): OrderFilterOp[] {
  const ops: OrderFilterOp[] = [];
  if (filter.method !== 'all') {
    ops.push(
      filter.method === 'cash'
        ? ['or', 'payment_method.eq.cash,payment_method.is.null']
        : ['eq', 'payment_method', filter.method],
    );
  }
  if (filter.status !== 'all') ops.push(['eq', 'status', filter.status]);
  if (filter.startDate) ops.push(['gte', 'created_at', filter.startDate]);
  if (filter.endDate) ops.push(['lte', 'created_at', filter.endDate]);
  if (filter.minPrice != null) ops.push(['gte', 'total', filter.minPrice]);
  if (filter.maxPrice != null) ops.push(['lte', 'total', filter.maxPrice]);
  return ops;
}

// SERVER-ONLY. Reads the offline (POS) sales tables with the shared archive
// service-role key (see src/pos-data.ts). Leave the env unset to render mocks.

/**
 * All POS orders (newest first) with their line items, product names resolved
 * from pos_products. React-cached so a page and its layout don't double-fetch.
 */
export const getPosOrders = cache((): Promise<PosOrder[]> =>
  usingPosMock() ? Promise.resolve(MOCK_POS_ORDERS) : posOrdersCached(),
);

// Cached across navigations/prefetches; order writes revalidate POS_TAGS.orders,
// POS-originated sales heal within the window.
//
// Every bulk read below is paged via fetchAllRows: PostgREST silently caps each
// response at db.max_rows (default 1000), so an unbounded .select() on a table
// past that size drops rows — which once zeroed Units and mis-booked sales as
// "bundles". Each read is ordered by a unique key so pages don't overlap/skip.
// TODO(Option A): replace this ship-everything-and-aggregate-in-JS approach with
// server-side aggregation. See src/pos-fetch-paginate.ts + CHANGELOG 2026-09-27.
const posOrdersCached = unstable_cache(async (): Promise<PosOrder[]> => {
  return readPosOrders(posClient());
}, ['pos-orders'], {tags: [POS_TAGS.orders], revalidate: POS_CACHE_REVALIDATE});

/**
 * One page of orders (newest first) with server-side pagination. Reads a total
 * count, then only that page's order rows (via range) and only their line items
 * (by id) — so it stays bounded as history grows, unlike getPosOrders which
 * fetches everything for aggregation. Returns the clamped page info alongside.
 */
export const getPosOrdersPage = cache(async (
  page: number,
  filter: PosOrdersFilter = DEFAULT_ORDERS_FILTER,
  pageSize?: number,
): Promise<{orders: PosOrder[]; pageInfo: PageInfo}> => {
  if (usingPosMock()) {
    const filtered = filterOrders(MOCK_POS_ORDERS, filter);
    const info = paginate(filtered.length, page, pageSize);
    return {orders: filtered.slice(info.from, info.to + 1), pageInfo: info};
  }
  return posOrdersPageCached(page, filter, pageSize);
});

// unstable_cache keys on the page/filter/pageSize args, so each filter combo caches
// independently; order writes revalidate POS_TAGS.orders.
const posOrdersPageCached = unstable_cache(async (
  page: number,
  filter: PosOrdersFilter,
  pageSize?: number,
): Promise<{orders: PosOrder[]; pageInfo: PageInfo}> => {
  const supabase = posClient();
  const ops = orderFilterOps(filter);

  let countQuery = supabase.from('pos_orders').select('id', {count: 'exact', head: true});
  for (const op of ops) {
    countQuery = op[0] === 'or' ? countQuery.or(op[1])
      : op[0] === 'eq' ? countQuery.eq(op[1], op[2])
      : op[0] === 'gte' ? countQuery.gte(op[1], op[2])
      : countQuery.lte(op[1], op[2]);
  }
  const {count, error: countErr} = await countQuery;
  if (countErr) throw new Error(`pos_orders count failed: ${countErr.message}`);

  const info = paginate(count ?? 0, page, pageSize);
  if ((count ?? 0) === 0) return {orders: [], pageInfo: info};

  let rowQuery = supabase
    .from('pos_orders')
    .select('id,client_uuid,subtotal,discount,total,oversold,device_id,payment_method,customer_handle,status,remarks,created_at,edited_at,event_id,pet_type'); // pagination-ok: server-side paged — .range(info.from, info.to) is applied at execution below after the dynamic filter loop
  for (const op of ops) {
    rowQuery = op[0] === 'or' ? rowQuery.or(op[1])
      : op[0] === 'eq' ? rowQuery.eq(op[1], op[2])
      : op[0] === 'gte' ? rowQuery.gte(op[1], op[2])
      : rowQuery.lte(op[1], op[2]);
  }
  const {data: orderRows, error: ordersErr} = await rowQuery
    .order('created_at', {ascending: false})
    .range(info.from, info.to);
  if (ordersErr) throw new Error(`pos_orders read failed: ${ordersErr.message}`);

  const ids = (orderRows ?? []).map((o) => o.id as string);
  // itemsRes is bounded by `ids` (one clamped page of orders); the product/bundle
  // name lookups are whole-table, so page them via fetchAllRows (ordered by their
  // unique PK) — a bare .select() would silently cap at db.max_rows (1000).
  const [itemsRes, products, bundles] = await Promise.all([
    supabase.from('pos_order_items').select('order_id,product_id,bundle_id,bundle_group,qty,unit_price,line_total').in('order_id', ids),
    fetchAllRows('pos_products', (from, to) =>
      supabase.from('pos_products').select('product_id,name').order('product_id', {ascending: true}).range(from, to)),
    fetchAllRows('pos_bundles', (from, to) =>
      supabase.from('pos_bundles').select('bundle_id,name').order('bundle_id', {ascending: true}).range(from, to)),
  ]);
  if (itemsRes.error) throw new Error(`pos_order_items read failed: ${itemsRes.error.message}`);

  const nameBySku = new Map<string, string>();
  for (const p of products) nameBySku.set(p.product_id as string, p.name as string);
  const nameByBundle = new Map<string, string>();
  for (const b of bundles) nameByBundle.set(b.bundle_id as string, b.name as string);

  const itemsByOrder = new Map<string, PosOrderLine[]>();
  for (const it of itemsRes.data ?? []) {
    const orderId = it.order_id as string;
    const productId = (it.product_id as string | null) ?? null;
    const bundleId = (it.bundle_id as string | null) ?? null;
    const arr = itemsByOrder.get(orderId) ?? [];
    arr.push({
      product_id: productId,
      bundle_id: bundleId,
      bundle_group: (it.bundle_group as string | null) ?? null,
      name: (productId && nameBySku.get(productId)) || (bundleId && nameByBundle.get(bundleId)) || productId || bundleId || 'Unknown',
      qty: (it.qty as number) ?? 0,
      unit_price: Number(it.unit_price ?? 0),
      line_total: Number(it.line_total ?? 0),
    });
    itemsByOrder.set(orderId, arr);
  }

  const orders = (orderRows ?? []).map((o): PosOrder => ({
    id: o.id as string,
    client_uuid: o.client_uuid as string,
    subtotal: Number(o.subtotal ?? 0),
    discount: o.discount != null ? Number(o.discount) : null,
    total: Number(o.total ?? 0),
    oversold: Boolean(o.oversold),
    device_id: (o.device_id as string | null) ?? null,
    payment_method: (o.payment_method as string | null) ?? null,
    customer_handle: (o.customer_handle as string | null) ?? null,
    status: (o.status as string | null) === 'voided' ? 'voided' : 'completed',
    remarks: (o.remarks as string | null) ?? null,
    created_at: o.created_at as string,
    edited_at: (o.edited_at as string | null) ?? null,
    event_id: (o.event_id as string | null) ?? null,
    pet_type: normalizePetType(o.pet_type),
    items: itemsByOrder.get(o.id as string) ?? [],
  }));

  return {orders, pageInfo: info};
}, ['pos-orders-page'], {tags: [POS_TAGS.orders], revalidate: POS_CACHE_REVALIDATE});

/**
 * Completed revenue (voided excluded) over the SAME filtered set the orders list
 * shows — the peso subtotal that pairs with the count, so this page reconciles
 * against the POS Transactions screen in one place. A void didn't happen, so it
 * never adds revenue (a Status = Voided view totals ₱0).
 */
export const getPosOrdersRevenue = cache(async (
  filter: PosOrdersFilter = DEFAULT_ORDERS_FILTER,
): Promise<number> => {
  // Mock path reuses computeKpis (voided-excluded total sum) so the subtotal
  // matches the Overview / offline-sales revenue KPIs exactly; the SQL path below
  // mirrors that definition server-side.
  if (usingPosMock()) return computeKpis(filterOrders(MOCK_POS_ORDERS, filter)).revenue;
  return posOrdersRevenueCached(filter);
});

// unstable_cache keyed on the filter (like posOrdersPageCached); order writes
// revalidate POS_TAGS.orders.
const posOrdersRevenueCached = unstable_cache(async (filter: PosOrdersFilter): Promise<number> => {
  const supabase = posClient();
  const ops = orderFilterOps(filter);
  // Same predicates as the orders list, plus a hard voided exclusion so the sum
  // is always completed revenue. Paged by the PK (total alone isn't unique) so
  // PostgREST's 1000-row cap can't silently truncate the sum.
  const rows = await fetchAllRows('pos_orders revenue', (from, to) => {
    let q = supabase.from('pos_orders').select('id,total').neq('status', 'voided'); // pagination-ok: fetchAllRows pages this — .range(from, to) is applied after the dynamic filter loop below
    for (const op of ops) {
      q = op[0] === 'or' ? q.or(op[1])
        : op[0] === 'eq' ? q.eq(op[1], op[2])
        : op[0] === 'gte' ? q.gte(op[1], op[2])
        : q.lte(op[1], op[2]);
    }
    return q.order('id', {ascending: true}).range(from, to);
  });
  return rows.reduce((sum, r) => sum + Number((r as {total: number | null}).total ?? 0), 0);
}, ['pos-orders-revenue'], {tags: [POS_TAGS.orders], revalidate: POS_CACHE_REVALIDATE});

/**
 * Inclusive price bounds for the transactions filter slider, from the single
 * highest order total across the whole dataset (unfiltered, so the slider range
 * stays stable as other filters change). Returns a clean ceiling; 0..100 when
 * there are no orders.
 */
export const getPosOrdersPriceBounds = cache(async (): Promise<PriceBounds> => {
  noStore();
  if (usingPosMock()) return priceBounds(MOCK_POS_ORDERS);

  const supabase = posClient();
  const {data, error} = await supabase
    .from('pos_orders')
    .select('total')
    .order('total', {ascending: false})
    .limit(1);
  if (error) throw new Error(`pos_orders price bounds failed: ${error.message}`);

  return boundsFromMax(Number(data?.[0]?.total ?? 0));
});

/**
 * All POS events, newest first (by start date). Anon has SELECT on pos_events;
 * here we read with the service role like the other pos_* reads. React-cached.
 */
export const getPosEvents = cache((): Promise<PosEvent[]> =>
  usingPosMock() ? Promise.resolve(MOCK_POS_EVENTS) : posEventsCached(),
);

const posEventsCached = unstable_cache(async (): Promise<PosEvent[]> => {
  const supabase = posClient();
  // Paged via fetchAllRows (ordered by event_id as a unique tiebreaker under the
  // starts_on display order) so a bare .select() can't be capped at db.max_rows.
  const data = await fetchAllRows('pos_events', (from, to) =>
    supabase
      .from('pos_events')
      .select('event_id,name,venue,city,organizer,starts_on,ends_on,opening_cash,cash_note,closing_cash,status,created_by,created_at,updated_at')
      .order('starts_on', {ascending: false, nullsFirst: false})
      .order('event_id', {ascending: true})
      .range(from, to));

  return data.map((e): PosEvent => ({
    event_id: e.event_id as string,
    name: (e.name as string | null) ?? null,
    venue: (e.venue as string | null) ?? null,
    city: (e.city as string | null) ?? null,
    organizer: (e.organizer as string | null) ?? null,
    starts_on: (e.starts_on as string | null) ?? null,
    ends_on: (e.ends_on as string | null) ?? null,
    opening_cash: e.opening_cash != null ? Number(e.opening_cash) : null,
    cash_note: (e.cash_note as string | null) ?? null,
    closing_cash: e.closing_cash != null ? Number(e.closing_cash) : null,
    status: (e.status as string | null) === 'closed' ? 'closed' : 'active',
    created_by: (e.created_by as string | null) ?? null,
    created_at: (e.created_at as string | null) ?? null,
    updated_at: (e.updated_at as string | null) ?? null,
  }));
}, ['pos-events'], {tags: [POS_TAGS.events], revalidate: POS_CACHE_REVALIDATE});

/** Recent sync-log entries (newest first), for the "recently synced" strip. */
export const getPosSyncLog = cache(async (limit = 8): Promise<PosSyncEntry[]> => {
  noStore();
  if (usingPosMock()) return MOCK_POS_SYNC_LOG.slice(0, limit);

  const supabase = posClient();
  const {data, error} = await supabase
    .from('pos_sync_log')
    .select('synced_at,direction,entity,summary,device_id')
    .order('synced_at', {ascending: false})
    .limit(limit);
  if (error) throw new Error(`pos_sync_log read failed: ${error.message}`);

  return (data ?? []).map((r): PosSyncEntry => ({
    synced_at: r.synced_at as string,
    direction: r.direction as string,
    entity: r.entity as string,
    summary: (r.summary as Record<string, unknown> | null) ?? null,
    device_id: (r.device_id as string | null) ?? null,
  }));
});
