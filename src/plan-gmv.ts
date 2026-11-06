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

/**
 * Which Shopify financial_status values count as Website GMV. The CRM Worker stores Shopify's REST value as is (lower case).
 * Owner rule (2026-11-05): Website GMV excludes only cancelled, voided and refunded orders.
 * - paid, pending (cash on delivery), authorized, partially_paid: count at the order total.
 * - partially_refunded: counts at the FULL order total (the sale happened and the Worker does not expose the refunded amount), so the
 *   month can overstate by the refund; the cell carries a "may overstate" note (PARTIAL_REFUND_NOTE).
 * - refunded, voided: excluded. expired never happened (a checkout that timed out), so it stays excluded too.
 * Anything not listed (including null) is excluded, never guessed in. A cancelled order reaches us as voided or refunded; the CRM
 * projection carries no separate cancel flag. The Sales page should adopt this one helper.
 */
export const WEBSITE_STATUS_RULES: Readonly<Record<string, boolean>> = {
  paid: true, pending: true, authorized: true, partially_paid: true, partially_refunded: true,
  refunded: false, voided: false, expired: false,
};
export const PARTIAL_REFUND_NOTE = 'Includes partially refunded orders at their full total, so this may overstate.';
const isPartiallyRefunded = (status: string | null | undefined): boolean => (status ?? '').trim().toLowerCase() === 'partially_refunded';
export const websiteOrderCounts = (status: string | null | undefined): boolean => WEBSITE_STATUS_RULES[(status ?? '').trim().toLowerCase()] === true;

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

export interface WebsiteOrderLike {createdAt: string | null; totalPrice: string | null; financialStatus: string | null}

/** `crm` is null when the CRM is not configured or the read failed. A truncated read only covers months after the oldest order we hold. */
export function websiteCells(months: readonly string[], nowKey: string, crm: {orders: readonly WebsiteOrderLike[]; truncated: boolean} | null): ActualCell[] {
  if (!crm || crm.orders.length === 0) return months.map(() => GAP);
  const sums = new Map<string, number>();
  const overstated = new Set<string>();
  for (const o of crm.orders) {
    const m = phMonthKey(o.createdAt);
    const price = Number(o.totalPrice);
    if (m === null || !websiteOrderCounts(o.financialStatus) || !Number.isFinite(price)) continue;
    sums.set(m, (sums.get(m) ?? 0) + price);
    if (isPartiallyRefunded(o.financialStatus)) overstated.add(m);
  }
  const oldest = minKey(crm.orders.map((o) => phMonthKey(o.createdAt)));
  // Truncated: the oldest month we hold is only partly there, so coverage starts the month after it.
  const first = oldest !== null && crm.truncated ? nextKey(oldest) : oldest;
  return covered(months, nowKey, first, (k) => sums.get(k) ?? 0).map((c, i) => (c.state === 'ok' && overstated.has(key(months[i])) ? {...c, note: PARTIAL_REFUND_NOTE} : c));
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
