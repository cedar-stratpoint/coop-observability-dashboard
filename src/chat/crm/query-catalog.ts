// The CRM query catalog (GET /api/catalog) as Ask Coop uses it: parsed defensively into a small closed shape, cached for ten minutes,
// dropped as soon as a query answer carries a different `catalog_version`, with a minimal built-in fallback when the CRM serves none
// (the CRM unreachable). The fallback is a trimmed copy of the final zoomy-crm catalog (2026-10-23.1): the CRM refuses anything outside
// its own whitelist, so it stays the authority; this copy only lets Coop refuse the obvious mistakes without a round trip. Pure apart from the injected `get`.
import {QUERY_LIMITS} from './query-config';
import type {CrmGet} from './tools';

export const AGGS = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'] as const;
export const OPS = ['eq', 'in', 'gte', 'lte', 'between', 'is_null'] as const;
export const BUCKETS = ['day', 'week', 'month'] as const;
export const TZS = ['Asia/Manila', 'UTC'] as const;

export type ColClass = 'safe' | 'aggregate_only' | 'identity';
export interface CatColumn {
  name: string;
  type: 'text' | 'number' | 'date';
  cls: ColClass;
  meaning: string;
  select: boolean;
  group: boolean;
  filter: string[];
  aggs: string[];
  /** Email: count_distinct only. */
  distinctOnly: boolean;
  unit: string | null;
}
export interface CatTable {
  name: string;
  meaning: string;
  rowLevel: boolean;
  windowCol: string | null;
  maxWindowDays: number | null;
  /** Declared joins this table offers (the CRM's `joins` list: `customers` on orders, order_lines and order_discount_codes). */
  joins: string[];
  columns: CatColumn[];
  notAvailable: string[];
}
export interface CatIdentity {
  fields: string[];
  filters: Record<string, string[]>;
  orderBy: string[];
  cap: number;
  untrusted: string[];
}
/** What the CRM's `v2` block advertises: computed select items, HAVING, top-N (`key` / `per`). Joins are per table (`CatTable.joins`). Absent keys: not offered. */
export interface CatFeatures {
  computed: boolean;
  having: boolean;
  topN: boolean;
}
export interface Catalog {
  version: string;
  tables: CatTable[];
  identity: CatIdentity | null;
  special: string | null;
  features: CatFeatures;
  /** Row-level cap without a cursor (to the model). */
  rowCap: number;
  groupedCap: number;
  /** Row-level page size with a cursor ("start" or a next_cursor): the CRM's ROW_CAP_PAGED. Identity pages stay at the identity cap. */
  pagedCap: number;
  /** Longest raw spec the CRM accepts. */
  specChars: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const strs = (v: unknown, max = 40): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : []);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const ID = /^[a-z][a-z0-9_]{0,40}$/;
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
/** A v2 capability is advertised as its grammar text (the CRM) or `true`. */
const on = (v: unknown): boolean => v === true || (typeof v === 'string' && v.length > 0);

/** The CRM's catalog body, or null when it is not a catalog. Unknown fields are ignored; ids that are not plain names are dropped. */
export function parseCatalog(body: unknown): Catalog | null {
  if (!isObj(body) || typeof body.catalog_version !== 'string' || !Array.isArray(body.tables)) return null;
  const tables: CatTable[] = [];
  for (const t of body.tables.slice(0, 40)) {
    if (!isObj(t) || typeof t.name !== 'string' || !ID.test(t.name) || !Array.isArray(t.columns)) continue;
    const columns: CatColumn[] = [];
    for (const c of t.columns.slice(0, 80)) {
      if (!isObj(c) || typeof c.name !== 'string' || !ID.test(c.name)) continue;
      const type = c.type === 'number' || c.type === 'date' ? c.type : 'text';
      const cls: ColClass = c.class === 'identity' ? 'identity' : c.class === 'aggregate_only' ? 'aggregate_only' : 'safe';
      columns.push({name: c.name, type, cls, meaning: str(c.meaning, 240), select: c.select === true, group: c.group === true, filter: strs(c.filter, 6), aggs: strs(c.aggs, 6), distinctOnly: c.count_distinct_only === true, unit: typeof c.unit === 'string' ? c.unit.slice(0, 12) : null});
    }
    tables.push({name: t.name, meaning: str(t.meaning, 240), rowLevel: t.row_level === true, windowCol: typeof t.window_required === 'string' && ID.test(t.window_required) ? t.window_required : null, maxWindowDays: typeof t.max_window_days === 'number' ? t.max_window_days : null, joins: strs(t.joins, 4).filter((j) => ID.test(j)), columns, notAvailable: strs(t.not_available, 12).map((s) => s.slice(0, 80))});
  }
  if (tables.length === 0) return null;
  let identity: CatIdentity | null = null;
  const id = body.identity_detail;
  if (isObj(id) && Array.isArray(id.fields)) {
    const filters: Record<string, string[]> = {};
    if (isObj(id.filters)) for (const [k, v] of Object.entries(id.filters)) if (ID.test(k) && isObj(v)) filters[k] = strs(v.ops, 6);
    identity = {fields: strs(id.fields, 30), filters, orderBy: strs(id.order_by, 6), cap: num(id.cap, QUERY_LIMITS.modelIdentity), untrusted: strs(id.untrusted_text_fields, 12)};
  }
  const sp = body.special_aggregate;
  const v2 = isObj(body.v2) ? body.v2 : {};
  const limits = isObj(body.limits) ? body.limits : {};
  return {
    version: body.catalog_version.slice(0, 40),
    tables,
    identity,
    special: isObj(sp) && typeof sp.name === 'string' && ID.test(sp.name) ? sp.name : null,
    features: {computed: on(v2.computed), having: on(v2.having), topN: on(v2.top_n)},
    rowCap: num(limits.ROW_CAP_ROWS, QUERY_LIMITS.modelRows),
    groupedCap: num(limits.ROW_CAP_GROUPED, QUERY_LIMITS.modelGrouped),
    pagedCap: num(limits.ROW_CAP_PAGED, QUERY_LIMITS.crmPagedRows),
    specChars: num(limits.MAX_SPEC_CHARS, QUERY_LIMITS.maxSpecChars),
  };
}

const col = (name: string, type: CatColumn['type'], meaning: string, o: Partial<CatColumn> = {}): CatColumn => ({
  name, type, cls: 'safe', meaning, select: true, group: type !== 'number', filter: type === 'text' ? ['eq', 'in', 'is_null'] : ['eq', 'gte', 'lte', 'between', 'is_null'],
  aggs: type === 'number' ? ['sum', 'avg', 'min', 'max', 'count', 'count_distinct'] : type === 'date' ? ['min', 'max', 'count'] : ['count', 'count_distinct'], distinctOnly: false, unit: null, ...o,
});
const email = col('email', 'text', 'Distinct count only: never returned, filtered or grouped.', {cls: 'aggregate_only', select: false, group: false, filter: [], aggs: ['count_distinct'], distinctOnly: true});
const JOINED = ['customers'];
// customers columns are aggregate-only: they are group keys, filters and aggregates (also through the `customers` join), never rows
const agg = (name: string, type: CatColumn['type'], meaning: string, o: Partial<CatColumn> = {}): CatColumn => col(name, type, meaning, {cls: 'aggregate_only', select: false, ...o});
const ref = col('customer_ref', 'text', 'Opaque customer id (null = guest).', {select: false, group: false, filter: ['eq', 'in', 'is_null'], aggs: ['count', 'count_distinct']});
const win = {windowCol: 'created_at', maxWindowDays: QUERY_LIMITS.crmWindowDays, notAvailable: []};

/** Used when the CRM serves no catalog. A trimmed copy of the final CRM catalog; the CRM still checks everything. */
export const FALLBACK_CATALOG: Catalog = Object.freeze({
  version: 'fallback',
  tables: [
    {name: 'orders', meaning: 'One row per website order.', rowLevel: true, ...win, joins: JOINED, columns: [col('order_number', 'text', 'The order number.', {group: false}), col('created_at', 'date', 'When the order was placed.'), col('financial_status', 'text', 'Payment status.'), col('fulfillment_status', 'text', 'Fulfilment status.'), col('total_price', 'number', 'What the customer paid.'), ref, email]},
    {name: 'order_lines', meaning: 'One row per order line item.', rowLevel: true, ...win, joins: JOINED, columns: [col('created_at', 'date', 'When the order was placed.'), col('financial_status', 'text', 'Payment status.'), col('sku', 'text', 'Line SKU.'), col('title', 'text', 'Product title.'), col('quantity', 'number', 'Units on the line.'), col('line_gross', 'number', 'Unit price x quantity.'), col('line_discount', 'number', 'Line-level discount.'), ref, email]},
    {name: 'order_discount_codes', meaning: 'One row per discount code on an order.', rowLevel: true, ...win, joins: JOINED, columns: [col('created_at', 'date', 'When the order was placed.'), col('code', 'text', 'The discount code.'), col('amount', 'number', 'Amount taken off.'), ref, email]},
    {name: 'checkouts', meaning: 'One row per checkout; converted_at null means abandoned.', rowLevel: true, ...win, joins: [], columns: [col('created_at', 'date', 'When the checkout started.'), col('converted_at', 'date', 'When it became an order.'), col('total_price', 'number', 'Cart value.'), email]},
    {name: 'checkout_lines', meaning: 'One row per cart line item.', rowLevel: true, ...win, joins: [], columns: [col('created_at', 'date', 'When the checkout started.'), col('converted_at', 'date', 'When it became an order.'), col('sku', 'text', 'Line SKU.'), col('quantity', 'number', 'Units on the line.'), col('line_gross', 'number', 'Unit price x quantity.'), email]},
    {name: 'customers', meaning: 'One row per customer; aggregate-only, identity detail on request.', rowLevel: false, windowCol: null, maxWindowDays: null, joins: [], notAvailable: [], columns: [agg('membership_tier', 'text', 'Membership tier.'), agg('orders_count', 'number', 'Orders count.'), agg('total_spent', 'number', 'Total spent.'), agg('created_at', 'date', 'When the customer was created.'), agg('email_marketing_state', 'text', 'subscribed, not_subscribed, unsubscribed.'), {...ref, filter: ['eq', 'in']}, email]},
  ],
  identity: {fields: ['customer_ref', 'full_name', 'email', 'phone', 'pet_name', 'pet_birthday', 'pet_profiles', 'membership_tier', 'email_marketing_state', 'orders', 'total_spent', 'first_order_at', 'last_order_at', 'last_order_skus', 'discount_codes_used'], filters: {customer_ref: ['eq', 'in'], email: ['eq', 'in'], full_name: ['eq', 'in'], membership_tier: ['eq', 'in', 'is_null'], orders_count: ['eq', 'gte', 'lte', 'between'], total_spent: ['gte', 'lte', 'between'], created_at: ['gte', 'lte', 'between']}, orderBy: ['orders_count', 'total_spent', 'created_at'], cap: QUERY_LIMITS.modelIdentity, untrusted: ['full_name', 'pet_name', 'pet_profiles']},
  special: 'customers_with_min_orders',
  features: {computed: true, having: true, topN: true},
  rowCap: QUERY_LIMITS.modelRows,
  groupedCap: QUERY_LIMITS.modelGrouped,
  pagedCap: QUERY_LIMITS.crmPagedRows,
  specChars: QUERY_LIMITS.maxSpecChars,
} satisfies Catalog);

export const tableOf = (cat: Catalog, name: string): CatTable | null => cat.tables.find((t) => t.name === name) ?? null;
export const columnOf = (t: CatTable, name: string): CatColumn | null => t.columns.find((c) => c.name === name) ?? null;

let cached: {catalog: Catalog; at: number} | null = null;
/** Tests only. */
export function resetCatalogCache(): void {
  cached = null;
}
/** A query answer carried this version: a different one means the cached catalog is stale, so the next call reads it again. */
export function noteCatalogVersion(version: unknown): void {
  if (cached && typeof version === 'string' && version !== cached.catalog.version) cached = null;
}

/** The catalog to validate against. Never throws: no catalog endpoint (404), a bad body or an unreachable CRM gives the fallback. */
export async function loadCatalog(get: CrmGet, now = Date.now()): Promise<{catalog: Catalog; source: 'live' | 'fallback'}> {
  if (cached && now - cached.at < QUERY_LIMITS.catalogTtlMs) return {catalog: cached.catalog, source: 'live'};
  try {
    const live = parseCatalog((await get('catalog')).body);
    if (live) {
      cached = {catalog: live, at: now};
      return {catalog: live, source: 'live'};
    }
  } catch {
    // the fallback below is a safe answer; the CRM check is the real guard
  }
  return {catalog: FALLBACK_CATALOG, source: 'fallback'};
}
