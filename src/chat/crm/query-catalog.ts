// The CRM query catalog (GET /api/catalog) as Ask Coop uses it: parsed defensively into a small closed shape, cached for ten minutes,
// dropped as soon as a query answer carries a different `catalog_version`, with a minimal built-in fallback when the CRM serves none
// (an older CRM, or unreachable). The fallback is deliberately small: the CRM refuses anything outside its own whitelist, so it stays
// the authority; this copy only lets Coop refuse the obvious mistakes without a round trip. Pure apart from the injected `get`.
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
/** What the CRM says it can do beyond v1 (declared joins, computed columns, HAVING, top-N per group). Absent keys: not supported yet. */
export interface CatFeatures {
  joins: string[];
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
  rowCap: number;
  groupedCap: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const strs = (v: unknown, max = 40): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : []);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const ID = /^[a-z][a-z0-9_]{0,40}$/;
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);

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
    tables.push({name: t.name, meaning: str(t.meaning, 240), rowLevel: t.row_level === true, windowCol: typeof t.window_required === 'string' && ID.test(t.window_required) ? t.window_required : null, maxWindowDays: typeof t.max_window_days === 'number' ? t.max_window_days : null, columns, notAvailable: strs(t.not_available, 12).map((s) => s.slice(0, 80))});
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
    features: {joins: strs(v2.joins, 12).filter((j) => ID.test(j)), computed: v2.computed === true || isObj(v2.computed), having: v2.having === true, topN: v2.top_n === true},
    rowCap: num(limits.ROW_CAP_ROWS, QUERY_LIMITS.modelRows),
    groupedCap: num(limits.ROW_CAP_GROUPED, QUERY_LIMITS.modelGrouped),
  };
}

const col = (name: string, type: CatColumn['type'], meaning: string, o: Partial<CatColumn> = {}): CatColumn => ({
  name, type, cls: 'safe', meaning, select: true, group: type !== 'number', filter: type === 'text' ? ['eq', 'in', 'is_null'] : ['eq', 'gte', 'lte', 'between', 'is_null'],
  aggs: type === 'number' ? ['sum', 'avg', 'min', 'max', 'count', 'count_distinct'] : type === 'date' ? ['min', 'max', 'count'] : ['count', 'count_distinct'], distinctOnly: false, unit: null, ...o,
});
const email = col('email', 'text', 'Distinct count only: never returned, filtered or grouped.', {cls: 'aggregate_only', select: false, group: false, filter: [], aggs: ['count_distinct'], distinctOnly: true});

/** Used when the CRM serves no catalog. Small on purpose; the CRM still checks everything. */
export const FALLBACK_CATALOG: Catalog = Object.freeze({
  version: 'fallback',
  tables: [
    {name: 'orders', meaning: 'One row per website order.', rowLevel: true, windowCol: 'created_at', maxWindowDays: 90, notAvailable: [], columns: [col('order_number', 'text', 'The order number.', {group: false}), col('created_at', 'date', 'When the order was placed.'), col('financial_status', 'text', 'Payment status.'), col('fulfillment_status', 'text', 'Fulfilment status.'), col('total_price', 'number', 'What the customer paid.'), col('customer_ref', 'text', 'Opaque customer id.', {select: false, aggs: ['count_distinct']}), email]},
    {name: 'order_lines', meaning: 'One row per order line item.', rowLevel: true, windowCol: 'created_at', maxWindowDays: 90, notAvailable: [], columns: [col('created_at', 'date', 'When the order was placed.'), col('sku', 'text', 'Line SKU.'), col('title', 'text', 'Product title.'), col('quantity', 'number', 'Units on the line.'), col('line_gross', 'number', 'Unit price x quantity.'), email]},
    {name: 'checkouts', meaning: 'One row per checkout; converted_at null means abandoned.', rowLevel: true, windowCol: 'created_at', maxWindowDays: 90, notAvailable: [], columns: [col('created_at', 'date', 'When the checkout started.'), col('converted_at', 'date', 'When it became an order.'), col('total_price', 'number', 'Cart value.'), email]},
    {name: 'customers', meaning: 'One row per customer; aggregate-only, identity detail on request.', rowLevel: false, windowCol: null, maxWindowDays: null, notAvailable: [], columns: [col('membership_tier', 'text', 'Membership tier.', {cls: 'aggregate_only', select: false}), col('orders_count', 'number', 'Orders count.', {cls: 'aggregate_only', select: false}), col('total_spent', 'number', 'Total spent.', {cls: 'aggregate_only', select: false}), email]},
  ],
  identity: {fields: ['customer_ref', 'full_name', 'email', 'phone', 'pet_name', 'pet_birthday', 'membership_tier', 'orders', 'total_spent', 'first_order_at', 'last_order_at'], filters: {customer_ref: ['eq', 'in'], email: ['eq', 'in'], full_name: ['eq', 'in'], membership_tier: ['eq', 'in', 'is_null'], orders_count: ['eq', 'gte', 'lte', 'between'], total_spent: ['gte', 'lte', 'between']}, orderBy: ['orders_count', 'total_spent', 'created_at'], cap: QUERY_LIMITS.modelIdentity, untrusted: ['full_name', 'pet_name']},
  special: 'customers_with_min_orders',
  features: {joins: [], computed: false, having: false, topN: false},
  rowCap: QUERY_LIMITS.modelRows,
  groupedCap: QUERY_LIMITS.modelGrouped,
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
