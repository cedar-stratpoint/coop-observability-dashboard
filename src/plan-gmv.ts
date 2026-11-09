// Business Health Report: GMV actuals by Manila (UTC+8) calendar month. Pure, no I/O: src/plan-data.ts reads, this decides.
// One rule runs through all of it: a month with no data is a GAP (empty cell, "waiting"), never PHP 0 and never red. PHP 0 is only
// ever a real zero, i.e. the source demonstrably covered that month. A failed or truncated read is a gap, never an understated number.
import {effectiveEventId} from './pos-sales-compute';
import type {RollupBucket} from './period-rollup';
import type {ActualCell} from './plan-compute';
import {GAP} from './plan-compute';
import type {PosEvent, PosOrder} from './pos-sales-types';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** 'YYYY-MM' of an instant in Manila (no DST), or null when it cannot be read. */
export function phMonthKey(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t + 8 * 3_600_000).toISOString().slice(0, 7) : null;
}

const key = (month: string): string => month.slice(0, 7);

/**
 * Months with a real value: from the first month the source has data up to the current month. Before the first month the source did
 * not exist (gap); after the current month nothing has happened yet (gap).
 */
function covered(months: readonly string[], nowKey: string, firstKey: string | null, value: (m: string) => number): ActualCell[] {
  return months.map((m) => {
    const k = key(m);
    if (firstKey === null || k < firstKey || k > nowKey) return GAP;
    return {value: round2(value(k)), state: 'ok'};
  });
}

function minKey(keys: Iterable<string | null>): string | null {
  let min: string | null = null;
  for (const k of keys) if (k !== null && (min === null || k < min)) min = k;
  return min;
}

/* ---------- Events ---------- */

/**
 * Events GMV = pos_orders.total of non-voided orders that belong to an event (stored event_id, or the single event covering the day,
 * via effectiveEventId). Non-event POS orders are not Events GMV. A free taste rung at an event is a PHP 0 order and adds nothing;
 * spin prizes are not orders at all.
 */
export function eventsCells(months: readonly string[], nowKey: string, pos: {orders: readonly PosOrder[]; events: PosEvent[]} | null): ActualCell[] {
  if (!pos || pos.orders.length === 0) return months.map(() => GAP);
  const sums = new Map<string, number>();
  for (const o of pos.orders) {
    if (o.status === 'voided') continue;
    const m = phMonthKey(o.created_at);
    if (m === null || !effectiveEventId(o, pos.events)) continue;
    sums.set(m, (sums.get(m) ?? 0) + (Number(o.total) || 0));
  }
  const first = minKey(pos.orders.map((o) => phMonthKey(o.created_at))); // the POS has data from its first order of any kind
  return covered(months, nowKey, first, (k) => sums.get(k) ?? 0);
}

/* ---------- Website ---------- */

/** The Worker's /api/orders is `ORDER BY created_at DESC LIMIT 1000` and ignores limit/offset (zoomy-crm src/routes/api.ts). */
export const CRM_ORDERS_CAP = 1000;

/** Did the read miss orders? Yes when the Worker hit its cap, or when its own order count (/api/metrics) exceeds what came back. */
export function crmCoverage(returned: number, reportedTotal: number | null): {truncated: boolean} {
  return {truncated: returned >= CRM_ORDERS_CAP || (reportedTotal !== null && reportedTotal > returned)};
}

/** Page ceiling for the filtered /api/orders read (500 rows a page), so a runaway cursor cannot loop for ever. */
export const CRM_ORDER_MAX_PAGES = 40;

export interface OrderPage<T> {orders: readonly T[]; nextCursor: string | null | undefined}

/**
 * Follows the Worker's keyset `next_cursor` until it is null. `nextCursor === undefined` means the Worker has no paging (old code: newest
 * 1000 only), reported as `legacy`. Hitting the ceiling gives `complete: false`. A page that throws rejects the whole read: a gap, never a partial sum.
 */
export async function collectOrderPages<T>(
  fetchPage: (cursor: string | null) => Promise<OrderPage<T>>,
  maxPages: number = CRM_ORDER_MAX_PAGES,
): Promise<{orders: T[]; complete: boolean; legacy: boolean}> {
  const orders: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(cursor);
    orders.push(...res.orders);
    if (res.nextCursor === undefined) return {orders, complete: true, legacy: true};
    if (res.nextCursor === null) return {orders, complete: true, legacy: false};
    cursor = res.nextCursor;
  }
  return {orders, complete: false, legacy: false};
}

/** A line as read from the Worker's `/api/orders?lines=1` (price and quantity only). Either may arrive as a string or a number. */
export interface WebsiteLineLike {price: unknown; quantity: unknown}
export interface WebsiteOrderLike {createdAt: string | null; lines?: readonly WebsiteLineLike[] | null}

const readNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Shopify "Gross sales" of one order: the sum of line price x quantity, before discounts, returns, shipping and tax (the same definition
 * as the CRM's /api/sales/summary `gross`). null = unknown: no lines array, an empty one (a Shopify order always has a line), or a line
 * without a usable price (>= 0) or quantity (> 0; the Worker sends 0 for a missing quantity). Never a silently low number.
 */
export function orderGross(order: {lines?: readonly WebsiteLineLike[] | null}): number | null {
  const lines = order.lines;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  let sum = 0;
  for (const l of lines) {
    const price = readNum(l?.price);
    const qty = readNum(l?.quantity);
    if (price === null || price < 0 || qty === null || qty <= 0) return null;
    sum += price * qty;
  }
  return sum;
}

export const MISSING_LINES_NOTE = 'Some orders this month came without readable line items, so this is understated.';
export const NO_LINES_NOTE = 'The CRM sent no line items, so Shopify gross sales cannot be worked out yet.';

/**
 * Website GMV = Shopify gross sales by Manila month. Owner decision (2026-11-09): match Shopify, so EVERY order counts whatever its
 * financial status (refunded, voided and cancelled included; Shopify subtracts returns later, in net sales).
 * `crm` is null when the CRM is not configured or the read failed. A truncated read only covers months after the oldest order we hold.
 * An order whose gross is unknown makes its month partial (grey, understated). No line items on ANY order (an old Worker that ignores
 * `lines=1`) is a gap with a note: there is no gross figure at all, and a gap is never shown as PHP 0.
 */
export function websiteCells(months: readonly string[], nowKey: string, crm: {orders: readonly WebsiteOrderLike[]; truncated: boolean} | null): ActualCell[] {
  if (!crm || crm.orders.length === 0) return months.map(() => GAP);
  if (!crm.orders.some((o) => Array.isArray(o.lines))) return months.map(() => ({...GAP, note: NO_LINES_NOTE}));
  const sums = new Map<string, number>();
  const unknown = new Set<string>();
  for (const o of crm.orders) {
    const m = phMonthKey(o.createdAt);
    if (m === null) continue;
    const gross = orderGross(o);
    if (gross === null) unknown.add(m);
    else sums.set(m, (sums.get(m) ?? 0) + gross);
  }
  const oldest = minKey(crm.orders.map((o) => phMonthKey(o.createdAt)));
  // Truncated: the oldest month we hold is only partly there, so coverage starts the month after it.
  const first = oldest !== null && crm.truncated ? nextKey(oldest) : oldest;
  return covered(months, nowKey, first, (k) => sums.get(k) ?? 0).map((c, i) => (c.state === 'ok' && unknown.has(key(months[i])) ? {...c, state: 'partial', note: MISSING_LINES_NOTE} : c));
}

function nextKey(k: string): string {
  const [y, m] = k.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/* ---------- Marketplace ---------- */

/**
 * Shopee + Lazada per PH day, from rollupChannels(['shopee','lazada'], 'month'). ok = both channels cover the whole month; one channel
 * or part of a month = partial (value understated, grey); neither = gap. `buckets` is null when the digests could not be read.
 */
export function marketplaceCells(months: readonly string[], nowKey: string, buckets: readonly RollupBucket[] | null): ActualCell[] {
  if (!buckets) return months.map(() => GAP);
  const byMonth = new Map(buckets.map((b) => [key(b.fromDay), b] as const));
  return months.map((m) => {
    const b = byMonth.get(key(m));
    if (!b || key(m) > nowKey) return GAP;
    const have = b.channels.filter((c) => (c.status === 'ok' || c.status === 'partial') && c.revenue !== null);
    if (have.length === 0) return GAP;
    const value = round2(have.reduce((a, c) => a + (c.revenue as number), 0));
    const whole = have.length === b.channels.length && have.every((c) => c.status === 'ok');
    return {value, state: whole ? 'ok' : 'partial', ...(whole ? {} : {note: 'Some Shopee or Lazada days are missing.'})};
  });
}

/* ---------- Total ---------- */

/** The sum only when no channel is a gap or partial; otherwise the sum of what exists, marked partial (grey). Every channel a gap = gap. */
export function totalCells(channels: readonly (readonly ActualCell[])[]): ActualCell[] {
  const n = Math.max(0, ...channels.map((c) => c.length));
  return Array.from({length: n}, (_, i): ActualCell => {
    const cells = channels.map((c) => c[i] ?? GAP);
    const have = cells.filter((c) => c.value !== null);
    if (have.length === 0) return GAP;
    const value = round2(have.reduce((a, c) => a + (c.value as number), 0));
    return cells.every((c) => c.state === 'ok') ? {value, state: 'ok'} : {value, state: 'partial', note: 'At least one channel is missing or partial.'};
  });
}
