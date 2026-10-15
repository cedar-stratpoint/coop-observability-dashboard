// Custom date range inside a reporting period (`?from=YYYY-MM-DD&to=YYYY-MM-DD`,
// PH calendar days). Pure — shared by the Overview page (server) and its tests.
//
// Only channels with per-order data can honour a sub-range: Website (live CRM
// orders) and Offline (POS orders). Lazada and Shopee exist here only as the
// digest's whole-period totals, so they stay "full period only".

const PH_MS = 8 * 3600_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** PH calendar day (YYYY-MM-DD) an instant falls on. */
export const phDay = (ms: number) => new Date(ms + PH_MS).toISOString().slice(0, 10);
/** The instant a PH calendar day begins. */
export const phDayStart = (day: string) => Date.parse(`${day}T00:00:00+08:00`);

/** First and last PH day a period touches — the picker's selectable bounds. */
export function periodDays(windowFrom: string, windowTo: string): {min: string; max: string} {
  return {min: phDay(Date.parse(windowFrom)), max: phDay(Date.parse(windowTo) - 1)};
}

export type CustomRange = {from: string; to: string; fromDay: string; toDay: string};

/**
 * Resolve `?from`/`?to` into an instant range [from, to), clamped to the period.
 * Null when either param is missing or malformed, or the range misses the period
 * entirely. Picking the period's first..last day yields exactly its window, so a
 * full-period "custom" range matches the digest's own numbers.
 */
export function resolveCustomRange(windowFrom: string, windowTo: string, from?: string, to?: string): CustomRange | null {
  if (!from || !to || !DAY_RE.test(from) || !DAY_RE.test(to)) return null;
  let [a, b] = from <= to ? [from, to] : [to, from];
  const lo = Math.max(phDayStart(a), Date.parse(windowFrom));
  const hi = Math.min(phDayStart(b) + 86_400_000, Date.parse(windowTo));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) return null;
  a = phDay(lo);
  b = phDay(hi - 1);
  return {from: new Date(lo).toISOString(), to: new Date(hi).toISOString(), fromDay: a, toDay: b};
}

/** True when an ISO instant falls in [from, to). */
export function inRange(iso: string | null | undefined, {from, to}: {from: string; to: string}): boolean {
  const t = Date.parse(String(iso ?? ''));
  return Number.isFinite(t) && t >= Date.parse(from) && t < Date.parse(to);
}

type LineItem = {title: string; quantity: number; unitPrice: number; discount: number};

// Port of the batch's parseLineItems (zoomy-observability src/observability/sales.js)
// so a full-period range reconciles to the digest. Tolerant; never throws.
export function parseLineItems(raw: unknown): LineItem[] {
  let items: unknown;
  try {
    items = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  return items
    .filter((it): it is Record<string, unknown> => Boolean(it) && typeof it === 'object')
    .map((it) => {
      const allocations = Array.isArray(it.discount_allocations) ? it.discount_allocations : [];
      const allocated = allocations.reduce((s: number, d: {amount?: unknown}) => s + (Number(d?.amount) || 0), 0);
      return {
        title: String(it.title || it.name || it.product_title || 'Unknown').trim() || 'Unknown',
        quantity: Number(it.quantity ?? it.qty ?? 1) || 0,
        unitPrice: Number(it.price ?? it.unit_price ?? it.unitPrice ?? 0) || 0,
        discount: (Number(it.total_discount) || 0) + allocated,
      };
    })
    .filter((it) => it.quantity > 0);
}

export type RangeOrder = {createdAt: string | null; totalPrice: string | number | null; lineItems?: unknown};
export type RangeMetrics = {revenue: number; orders: number; aov: number; units: number; adSpend: null; roas: null};

/**
 * Website figures for a range, with the batch's definitions: revenue = Σ totalPrice,
 * AOV = revenue ÷ orders, units = Σ line quantities, top products by net
 * (discount-aware) line revenue. Null metrics when nothing falls in range, so a
 * failed CRM read shows "no data" rather than a false ₱0.
 */
export function websiteRangeMetrics(orders: RangeOrder[], range: {from: string; to: string}, limit = 6) {
  let count = 0;
  let revenue = 0;
  let units = 0;
  const byTitle = new Map<string, {title: string; units: number; revenue: number}>();
  for (const o of orders) {
    if (!o || !inRange(o.createdAt, range)) continue;
    count += 1;
    revenue += Number(o.totalPrice) || 0;
    for (const li of parseLineItems(o.lineItems)) {
      units += li.quantity;
      const cur = byTitle.get(li.title) ?? {title: li.title, units: 0, revenue: 0};
      cur.units += li.quantity;
      cur.revenue += li.quantity * li.unitPrice - li.discount;
      byTitle.set(li.title, cur);
    }
  }
  if (!count) return {metrics: null, topProducts: []};
  const rev = round2(revenue);
  return {
    metrics: {revenue: rev, orders: count, aov: round2(rev / count), units, adSpend: null, roas: null} as RangeMetrics,
    topProducts: [...byTitle.values()]
      .map((p) => ({...p, revenue: round2(p.revenue)}))
      .sort((x, y) => y.revenue - x.revenue)
      .slice(0, limit),
  };
}

export type DaySales = {day: string; revenue: number; orders: number; units: number};

/**
 * Shopee/Lazada figures for a range, summed from the digest's per-PH-day series
 * (`digest.daily`, stamped by the batch). `undefined` when the period has no series
 * (older rows → still "full period only"); null when no sales fall in the range.
 * Ad spend / ROAS have no daily source, so they stay null.
 */
export function dailyRangeMetrics(days: DaySales[] | undefined, range: {fromDay: string; toDay: string}): RangeMetrics | null | undefined {
  if (!days?.length) return undefined;
  let revenue = 0;
  let orders = 0;
  let units = 0;
  for (const d of days) {
    if (d.day < range.fromDay || d.day > range.toDay) continue;
    revenue += d.revenue;
    orders += d.orders;
    units += d.units;
  }
  if (!orders) return null;
  const rev = round2(revenue);
  return {revenue: rev, orders, aov: round2(rev / orders), units, adSpend: null, roas: null};
}
