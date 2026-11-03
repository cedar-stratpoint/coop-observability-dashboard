import type {PosProductRow} from './pos-types';
import type {ChannelFacts} from './health-types';
import type {BundleSalesSummary, DailySales, DayMethodRevenue, EditEntry, EventRollup, FeaturedEvent, PetMix, PetMixSegment, PosEvent, PosOrder, PosOrdersFilter, PriceBounds, SalesKpis, SalesRange, TopBundle, TopProduct} from './pos-sales-types';

// Pure aggregation helpers for the Offline (POS) reporting surfaces. No
// server/client concerns so they're unit-testable and shared across pages.

export const SALES_RANGES: {value: SalesRange; label: string}[] = [
  {value: 'today', label: 'Today'},
  {value: '7d', label: '7 days'},
  {value: '30d', label: '30 days'},
  {value: 'all', label: 'All'},
];

export function isSalesRange(v: string | undefined): v is SalesRange {
  return v === 'today' || v === '7d' || v === '30d' || v === 'all';
}

// Asia/Manila is UTC+8 year-round (no DST). Sales are reported on the Manila
// calendar day so "Today" and the daily chart match how an owner thinks about a
// bazaar day (and match the Daily target bar). A Manila day begins at 16:00 UTC
// the previous day.
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

/** The UTC instant at which the current Asia/Manila calendar day began. */
export function manilaDayStart(now: Date = new Date()): Date {
  const shifted = new Date(now.getTime() + MANILA_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - MANILA_OFFSET_MS);
}

/** The Manila calendar day (YYYY-MM-DD) an instant falls on. */
export function manilaDayKey(iso: string): string {
  return new Date(new Date(iso).getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Inclusive lower bound (ISO) for a range, or null for 'all'. 'today' is the
 *  Manila calendar day; 7d/30d are rolling 7x/30x-24h windows. */
export function rangeStart(range: SalesRange, now: Date = new Date()): string | null {
  if (range === 'all') return null;
  if (range === 'today') return manilaDayStart(now).toISOString();
  const d = new Date(now);
  if (range === '7d') {
    d.setUTCDate(d.getUTCDate() - 7);
  } else if (range === '30d') {
    d.setUTCDate(d.getUTCDate() - 30);
  }
  return d.toISOString();
}

/** Keep orders whose created_at is at/after the range start. */
export function filterOrdersByRange(orders: PosOrder[], range: SalesRange, now: Date = new Date()): PosOrder[] {
  const start = rangeStart(range, now);
  if (!start) return orders;
  return orders.filter((o) => o.created_at >= start);
}

/** A voided sale didn't happen: it's excluded from every revenue aggregation. */
function isVoided(o: PosOrder): boolean {
  return o.status === 'voided';
}

export function computeKpis(orders: PosOrder[]): SalesKpis {
  let revenue = 0;
  let count = 0;
  let units = 0;
  let oversells = 0;
  for (const o of orders) {
    if (isVoided(o)) continue;
    revenue += o.total;
    count += 1;
    if (o.oversold) oversells += 1;
    for (const it of o.items) units += it.qty;
  }
  return {revenue, orders: count, units, oversells};
}

/**
 * Split orders by the pet each sale was tagged for: dog / cat / both / untagged
 * (null pet_type). Each segment carries revenue (Σ order total) and order count.
 * Voided sales are excluded, consistent with every other revenue aggregation.
 */
export function petMix(orders: PosOrder[]): PetMix {
  const seg = (): PetMixSegment => ({revenue: 0, orders: 0});
  const mix: PetMix = {dog: seg(), cat: seg(), both: seg(), untagged: seg()};
  for (const o of orders) {
    if (isVoided(o)) continue;
    const key: keyof PetMix =
      o.pet_type === 'dog' || o.pet_type === 'cat' || o.pet_type === 'both' ? o.pet_type : 'untagged';
    mix[key].revenue += o.total;
    mix[key].orders += 1;
  }
  return mix;
}

/**
 * Per-event sales rollups: revenue, order count, and cash-method sales for each
 * event, plus the expected till (opening_cash + cash sales) for a reconciliation
 * line. Orders with no event_id (normal non-event days) are ignored. Events with
 * no sales still appear, with zeroed figures. Voided sales are excluded.
 */
export function eventRollups(events: PosEvent[], orders: PosOrder[]): EventRollup[] {
  const byEvent = new Map<string, {revenue: number; orders: number; cashSales: number}>();
  for (const o of orders) {
    if (isVoided(o) || !o.event_id) continue;
    const cur = byEvent.get(o.event_id) ?? {revenue: 0, orders: 0, cashSales: 0};
    cur.revenue += o.total;
    cur.orders += 1;
    if (orderMethod(o) === 'cash') cur.cashSales += o.total;
    byEvent.set(o.event_id, cur);
  }
  return events.map((event) => {
    const agg = byEvent.get(event.event_id) ?? {revenue: 0, orders: 0, cashSales: 0};
    const expectedCash = event.opening_cash != null ? event.opening_cash + agg.cashSales : null;
    return {event, revenue: agg.revenue, orders: agg.orders, cashSales: agg.cashSales, expectedCash};
  });
}

/**
 * The event a sale effectively belongs to for Coop reporting. A POS-stamped
 * event_id is authoritative and kept as-is; an untagged sale (event_id null) is
 * attributed by its Manila calendar date ONLY when exactly one dated event covers
 * that day. Now that overlapping / same-day events are allowed, a date no longer
 * uniquely identifies an event, so an ambiguous day (two or more events) is left
 * untagged rather than guessed — the POS stamps event_id explicitly at checkout,
 * and anything still blank can be reassigned from the dashboard. Single bound =
 * that one day. Read-time only: never writes pos_orders.event_id.
 */
export function effectiveEventId(order: {event_id: string | null; created_at: string}, events: PosEvent[]): string | null {
  if (order.event_id) return order.event_id;
  const day = manilaDayKey(order.created_at);
  const from = (e: PosEvent) => (e.starts_on ?? e.ends_on) as string;
  const to = (e: PosEvent) => (e.ends_on ?? e.starts_on) as string;
  const covering = events.filter((e) => (e.starts_on || e.ends_on) && from(e) <= day && day <= to(e));
  // Only auto-attribute on an unambiguous day; two or more events covering the day
  // stays untagged (don't guess which one the sale belonged to).
  return covering.length === 1 ? covering[0].event_id : null;
}

/**
 * Every event whose dates cover today (Manila), newest start first. All live
 * events are pinned to the top of the events list and spotlighted, since
 * overlapping / same-day events are now allowed (there can be more than one).
 */
export function currentEventIds(events: PosEvent[], todayKey: string): string[] {
  const from = (e: PosEvent) => (e.starts_on ?? e.ends_on) as string;
  const to = (e: PosEvent) => (e.ends_on ?? e.starts_on) as string;
  return events
    .filter((e) => (e.starts_on || e.ends_on) && from(e) <= todayKey && todayKey <= to(e))
    .sort((a, b) => from(b).localeCompare(from(a)))
    .map((e) => e.event_id);
}

/**
 * Null-event sales that fall on a day some event covers — the ones likely needing
 * a manual event assignment. The POS normally tags these at checkout, but an
 * ambiguous same-day pick or a legacy/offline sale can leave one blank. Walk-ins
 * on true non-event days are excluded (those are legitimately untagged). Voided
 * excluded. Feeds the dashboard's "Untagged" bucket + reassign control.
 */
export function untaggedOnEventDays(orders: PosOrder[], events: PosEvent[]): PosOrder[] {
  const dated = events.filter((e) => e.starts_on || e.ends_on);
  if (dated.length === 0) return [];
  const from = (e: PosEvent) => (e.starts_on ?? e.ends_on) as string;
  const to = (e: PosEvent) => (e.ends_on ?? e.starts_on) as string;
  return orders.filter((o) => {
    if (isVoided(o) || o.event_id) return false;
    const day = manilaDayKey(o.created_at);
    return dated.some((e) => from(e) <= day && day <= to(e));
  });
}

/**
 * Attribute untagged sales to their covering event (automatic, read-time,
 * fill-the-blanks). POS-tagged orders pass through untouched; only a null-event
 * sale that now resolves to an event gets a fresh object with that event_id. With
 * no dated events, returns the input as-is. Coop-side reporting only.
 */
export function resolveOrderEvents<T extends {event_id: string | null; created_at: string}>(orders: T[], events: PosEvent[]): T[] {
  if (!events.some((e) => e.starts_on || e.ends_on)) return orders;
  return orders.map((o) => {
    if (o.event_id) return o;
    const ev = effectiveEventId(o, events);
    return ev ? {...o, event_id: ev} : o;
  });
}

/**
 * The first existing event whose dates intersect a proposed [startsOn, endsOn]
 * range, or null if none. Overlapping / same-day events are allowed now (no DB
 * guard), so this is no longer a blocker — the form uses it to show a neutral
 * "runs alongside <event>" note so the scheduler knows another event shares the
 * day. Single bound = that one day; pass selfId when editing to skip itself.
 */
export function overlappingEvent(events: PosEvent[], startsOn: string | null, endsOn: string | null, selfId?: string): PosEvent | null {
  if (!startsOn && !endsOn) return null;
  const from = (startsOn ?? endsOn) as string;
  const to = (endsOn ?? startsOn) as string;
  for (const e of events) {
    if (e.event_id === selfId) continue;
    const eFrom = e.starts_on ?? e.ends_on;
    const eTo = e.ends_on ?? e.starts_on;
    if (!eFrom || !eTo) continue;
    if (eFrom <= to && from <= eTo) return e;
  }
  return null;
}

/**
 * Pick the event to spotlight on the Offline Sales home: the one covering today
 * ('current'), else the nearest future one by start date ('upcoming'), else null.
 * Uses the same single-bound-as-one-day semantics as POS detection, and ignores
 * events with no dates. When more than one event covers today (same-day events are
 * allowed), the later-starting one is the single home spotlight; the events page
 * pins every live event via currentEventIds.
 */
export function featuredEvent(events: PosEvent[], todayKey: string): FeaturedEvent | null {
  const dated = events.filter((e) => e.starts_on || e.ends_on);
  const from = (e: PosEvent) => (e.starts_on ?? e.ends_on) as string;
  const to = (e: PosEvent) => (e.ends_on ?? e.starts_on) as string;

  const current = dated
    .filter((e) => from(e) <= todayKey && todayKey <= to(e))
    .sort((a, b) => from(b).localeCompare(from(a)));
  if (current[0]) return {event: current[0], state: 'current'};

  const upcoming = dated
    .filter((e) => from(e) > todayKey)
    .sort((a, b) => from(a).localeCompare(from(b)));
  if (upcoming[0]) return {event: upcoming[0], state: 'upcoming'};

  return null;
}

// ── Events page: search, time filter, and sort (client-side; the list is modest
// and each card computes its own analytics, so paginating on the server isn't
// worth it). All pure so they're unit-tested and shared by the view + its badges.

export type EventWhen = 'all' | 'upcoming' | 'ongoing' | 'past';
export type EventSort = 'recent' | 'oldest' | 'revenue';

export const EVENT_WHEN_FILTERS: {value: EventWhen; label: string}[] = [
  {value: 'all', label: 'All'},
  {value: 'upcoming', label: 'Upcoming'},
  {value: 'ongoing', label: 'Happening'},
  {value: 'past', label: 'Done'},
];

export const EVENT_SORT_OPTIONS: {value: EventSort; label: string}[] = [
  {value: 'recent', label: 'Recent'},
  {value: 'oldest', label: 'Oldest'},
  {value: 'revenue', label: 'Top ₱'},
];

/** Where an event sits relative to today (Manila day key): before its dates
 *  (upcoming), within them (ongoing/"happening now"), or after (past/"done").
 *  A dateless event has no timeline, so it reads as ongoing (kept visible). */
export function eventTimeState(event: PosEvent, todayKey: string): 'upcoming' | 'ongoing' | 'past' {
  const start = event.starts_on ?? event.ends_on;
  const end = event.ends_on ?? event.starts_on;
  if (start && start > todayKey) return 'upcoming';
  if (end && end < todayKey) return 'past';
  return 'ongoing';
}

/** Case-insensitive match of a free-text query against an event's name, venue,
 *  city, and organizer. Empty query matches everything. */
export function eventMatchesQuery(event: PosEvent, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [event.name, event.venue, event.city, event.organizer].some((field) =>
    (field ?? '').toLowerCase().includes(needle),
  );
}

/** Filter event rollups by search + time bucket, then sort. Pure, so the view
 *  just paginates the result. `recent` = latest start first; `oldest` = earliest
 *  first; `revenue` = highest first (start date breaks ties). */
export function filterAndSortEvents(
  rollups: EventRollup[],
  opts: {query: string; when: EventWhen; sort: EventSort},
  todayKey: string,
): EventRollup[] {
  const filtered = rollups.filter(
    (r) =>
      eventMatchesQuery(r.event, opts.query) &&
      (opts.when === 'all' || eventTimeState(r.event, todayKey) === opts.when),
  );
  const startKey = (r: EventRollup) => r.event.starts_on ?? r.event.ends_on ?? '';
  const sorted = [...filtered];
  if (opts.sort === 'revenue') {
    sorted.sort((a, b) => b.revenue - a.revenue || startKey(b).localeCompare(startKey(a)));
  } else if (opts.sort === 'oldest') {
    sorted.sort((a, b) => startKey(a).localeCompare(startKey(b)));
  } else {
    sorted.sort((a, b) => startKey(b).localeCompare(startKey(a)));
  }
  return sorted;
}

/** Inclusive list of calendar-day keys (YYYY-MM-DD) from start to end. A single
 *  bound yields that one day; a reversed or empty range yields []. Capped so a
 *  bad range can't loop. Used for the per-event day granularity toggle. */
export function datesInRange(start: string | null, end: string | null): string[] {
  if (!start && !end) return [];
  const s = (start ?? end) as string;
  const e = (end ?? start) as string;
  if (e < s) return [];
  const out: string[] = [];
  let cur = new Date(`${s}T00:00:00Z`).getTime();
  const last = new Date(`${e}T00:00:00Z`).getTime();
  for (let guard = 0; cur <= last && guard < 400; guard++) {
    out.push(new Date(cur).toISOString().slice(0, 10));
    cur += 86_400_000;
  }
  return out;
}

export interface PaymentSlice {
  method: string; // 'cash' | 'gcash' | ...
  revenue: number;
  orders: number;
}

/** Revenue + order count per payment method for a set of orders (voided
 *  excluded), richest first. Powers the event payment split. */
export function paymentBreakdown(orders: PosOrder[]): PaymentSlice[] {
  const by = new Map<string, {revenue: number; orders: number}>();
  for (const o of orders) {
    if (isVoided(o)) continue;
    const key = orderMethod(o);
    const cur = by.get(key) ?? {revenue: 0, orders: 0};
    cur.revenue += o.total;
    cur.orders += 1;
    by.set(key, cur);
  }
  return [...by.entries()]
    .map(([method, v]) => ({method, revenue: v.revenue, orders: v.orders}))
    .sort((a, b) => b.revenue - a.revenue);
}

export interface RevenuePoint {
  t: string; // ISO instant of the order
  revenue: number; // running (cumulative) revenue up to and including this order
}

/** Cumulative revenue over time for an event's orders (voided excluded), oldest
 *  first: a smooth rising series for the trend line. Each order adds a point. */
export function eventRevenueSeries(orders: PosOrder[]): RevenuePoint[] {
  const sorted = orders.filter((o) => !isVoided(o)).slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
  let running = 0;
  return sorted.map((o) => {
    running += o.total;
    return {t: o.created_at, revenue: running};
  });
}

/** Minutes since Manila midnight (0..1439) for an ISO instant. Time-of-day only,
 *  so orders from different calendar days line up on one axis. */
export function manilaMinuteOfDay(iso: string): number {
  const min = Math.floor(new Date(iso).getTime() / 60_000) + MANILA_OFFSET_MS / 60_000;
  return ((min % 1440) + 1440) % 1440;
}

/** One row per clock-hour mark of the event window; each event day is a numeric
 *  column holding that day's cumulative revenue BY that mark (inclusive of a sale
 *  landing exactly on it). Completed days span the full window — flat ₱0 before
 *  their first sale, flat at the day total after their last — so every line runs
 *  edge to edge. Only the latest (maybe in-progress) day is null after its last
 *  sale, so it isn't flat-lined into the future. `tod` is minutes since Manila
 *  midnight at the mark, so a 9:37 sale reads "₱1,200 by 10 AM". */
export interface DayPacingRow {
  tod: number;
  [dayKey: string]: number | null;
}

export interface DayPacingSeries {
  days: string[]; // day keys (YYYY-MM-DD) that actually had sales, ascending
  rows: DayPacingRow[];
}

/** Per-day intraday cumulative revenue on a shared HOURLY grid, aligned by Manila
 *  time-of-day, for the "compare days" overlay: each day resets to 0 and climbs, so
 *  a later day's pace reads directly against earlier days at the same clock hour.
 *  One point per hour means an even hover step (10 AM, 11 AM, …) instead of jumping
 *  between sparse order times. Each mark holds the running total BY that clock hour
 *  (a 9:37 sale counts toward the 10 AM mark, leaving 9 AM at its ₱0 baseline). A
 *  completed day's line spans the whole window (flat ₱0 before its first sale, flat
 *  at its total after its last); only the latest, still-selling day is left null
 *  past its last sale. Voided excluded. */
export function eventDayPacingSeries(orders: PosOrder[]): DayPacingSeries {
  const byDay = new Map<string, PosOrder[]>();
  for (const o of orders) {
    if (isVoided(o)) continue;
    const key = manilaDayKey(o.created_at);
    const arr = byDay.get(key) ?? [];
    arr.push(o);
    byDay.set(key, arr);
  }
  const days = Array.from(byDay.keys()).sort();
  if (days.length === 0) return {days: [], rows: []};

  // Per day: ascending cumulative points (one per selling minute) + its window.
  const perDay = new Map<string, {points: {tod: number; val: number}[]; firstMark: number; lastMark: number; total: number}>();
  let startHour = Infinity;
  let endHour = -Infinity;
  for (const d of days) {
    const sorted = byDay.get(d)!.slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
    const points: {tod: number; val: number}[] = [];
    let running = 0;
    for (const o of sorted) {
      running += o.total;
      const tod = manilaMinuteOfDay(o.created_at);
      const last = points[points.length - 1];
      if (last && last.tod === tod) last.val = running; // same minute keeps the latest total
      else points.push({tod, val: running});
    }
    // firstMark: the clock-hour mark the line starts on. It reads 0 when the first
    // sale is after the hour (e.g. 9:37 → a ₱0 baseline at 9 AM), or the sale's own
    // value when it lands exactly on the hour. lastMark: rounded UP so the mark
    // always sits at or past the last sale, capturing the full day total (a 12:30
    // sale is counted "by 1 PM", never dropped).
    const firstMark = Math.floor(points[0].tod / 60);
    const lastMark = Math.ceil(points[points.length - 1].tod / 60);
    perDay.set(d, {points, firstMark, lastMark, total: points[points.length - 1].val});
    startHour = Math.min(startHour, firstMark);
    endHour = Math.max(endHour, lastMark);
  }

  // The most recent day may still be selling, so it must not be flat-lined to the
  // right (that would fake future sales); every earlier day is complete and holds
  // its total to the axis end so all completed lines span the full window.
  const latestDay = days[days.length - 1];

  const rows: DayPacingRow[] = [];
  for (let h = startHour; h <= endHour; h++) {
    const mark = h * 60; // cumulative revenue BY this clock-hour mark, inclusive
    const row: DayPacingRow = {tod: mark};
    for (const d of days) {
      const info = perDay.get(d)!;
      // Before the day's first sale: flat ₱0 baseline (nothing sold yet) so every
      // line starts at the shared left edge.
      if (h < info.firstMark) {
        row[d] = 0;
        continue;
      }
      // After the day's last sale: hold the day's total flat to the right edge so a
      // completed day spans the full axis; the latest (maybe in-progress) day stops
      // at its real last sale instead (null), never faking the future.
      if (h > info.lastMark) {
        row[d] = d === latestDay ? null : info.total;
        continue;
      }
      let val = 0;
      for (const p of info.points) {
        if (p.tod <= mark) val = p.val;
        else break;
      }
      row[d] = val;
    }
    rows.push(row);
  }

  return {days, rows};
}

/** Group orders by Manila calendar day, ascending. Days with no sales omitted. */
export function salesByDay(orders: PosOrder[]): DailySales[] {
  const byDay = new Map<string, {revenue: number; orders: number}>();
  for (const o of orders) {
    if (isVoided(o)) continue;
    const day = manilaDayKey(o.created_at); // YYYY-MM-DD (Asia/Manila)
    const cur = byDay.get(day) ?? {revenue: 0, orders: 0};
    cur.revenue += o.total;
    cur.orders += 1;
    byDay.set(day, cur);
  }
  return Array.from(byDay.entries())
    .map(([day, v]) => ({day, revenue: v.revenue, orders: v.orders}))
    .sort((a, b) => a.day.localeCompare(b.day));
}

// ── Payment-method breakdown ──────────────────────────────────────────────
// Canonical display order for methods (matches the POS pay control + badges).
// A null/legacy payment_method reads as cash, consistent with the label helper.
const PAYMENT_METHOD_ORDER = ['cash', 'qrph', 'gcash', 'maya', 'card', 'bpi', 'bank_transfer'];

/** An order's payment method, with null/legacy normalized to 'cash'. */
export function orderMethod(o: PosOrder): string {
  return o.payment_method ?? 'cash';
}

/** Distinct payment methods present in these orders (voided excluded), in
 *  canonical order, with any unknown method appended alphabetically. */
export function presentMethods(orders: PosOrder[]): string[] {
  const set = new Set<string>();
  for (const o of orders) if (!isVoided(o)) set.add(orderMethod(o));
  return Array.from(set).sort((a, b) => {
    const ia = PAYMENT_METHOD_ORDER.indexOf(a);
    const ib = PAYMENT_METHOD_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

export interface PaymentMethodOption {
  method: string;
  enabled: boolean; // has sales in this data (filterable); false = greyed/unclickable
}

/** Payment methods for the filter dropdown: those with sales ("enabled",
 *  filterable) first in canonical order, then the remaining known methods
 *  ("disabled", shown greyed so the user sees the full set). */
export function paymentMethodOptions(orders: PosOrder[]): PaymentMethodOption[] {
  const present = presentMethods(orders);
  const presentSet = new Set(present);
  const disabled = PAYMENT_METHOD_ORDER.filter((m) => !presentSet.has(m));
  return [
    ...present.map((method) => ({method, enabled: true})),
    ...disabled.map((method) => ({method, enabled: false})),
  ];
}

/** Revenue per Manila day split by payment method, ascending by day. Days with
 *  no (non-voided) sales are omitted. Feeds the stacked sales-over-time chart. */
export function salesByDayAndMethod(orders: PosOrder[]): DayMethodRevenue[] {
  const byDay = new Map<string, Record<string, number>>();
  for (const o of orders) {
    if (isVoided(o)) continue;
    const day = manilaDayKey(o.created_at);
    const method = orderMethod(o);
    const rec = byDay.get(day) ?? {};
    rec[method] = (rec[method] ?? 0) + o.total;
    byDay.set(day, rec);
  }
  return Array.from(byDay.entries())
    .map(([day, byMethod]) => ({day, byMethod}))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** How the Top products list is ranked: by itemized revenue or by units sold. */
export type TopProductSort = 'revenue' | 'units';

/** Top products from order line items, ranked by revenue (default) or units,
 *  each with the other as tiebreak. */
export function topProducts(orders: PosOrder[], limit = 5, sortBy: TopProductSort = 'revenue'): TopProduct[] {
  const byProduct = new Map<string, TopProduct>();
  for (const o of orders) {
    if (isVoided(o)) continue;
    for (const it of o.items) {
      if (!it.product_id) continue; // skip bundle-only lines with no SKU
      const cur = byProduct.get(it.product_id) ?? {product_id: it.product_id, name: it.name, revenue: 0, units: 0, bundledUnits: 0};
      cur.revenue += it.line_total;
      cur.units += it.qty;
      // A ₱0 line is a bundle pick: it moved stock but its value sits on the
      // order header (see the RCA in COOP_INTEGRATION_PLAN.md), so it adds units
      // without adding revenue.
      if (it.line_total === 0) cur.bundledUnits += it.qty;
      byProduct.set(it.product_id, cur);
    }
  }
  const byRevenue = (a: TopProduct, b: TopProduct) => b.revenue - a.revenue || b.units - a.units;
  const byUnits = (a: TopProduct, b: TopProduct) => b.units - a.units || b.revenue - a.revenue;
  return Array.from(byProduct.values())
    .sort(sortBy === 'units' ? byUnits : byRevenue)
    .slice(0, limit);
}

/**
 * A bundle order carries a "bundle premium": money on the order total that no
 * product line accounts for (a "Buy Any N for ₱X" deal records its picks as ₱0
 * component lines and puts ₱X only on the order header). There's no bundle flag
 * on pos_orders, so this premium — total exceeding the sum of product line totals
 * — is the reliable signal. Such orders are NOT safe to edit line-by-line: the
 * edit RPC recomputes total from the line totals, which would wipe the premium.
 * (A plain discounted order has total <= line sum, so it's never misflagged.)
 */
export function isBundleOrder(order: PosOrder): boolean {
  let productLineSum = 0;
  for (const it of order.items) if (it.product_id) productLineSum += it.line_total;
  return order.total - productLineSum > 0.005;
}

/** Minimal bundle facts orderToEntries needs to re-link / price a bundle group. */
export type BundleMatch = {bundle_id: string; bundle_type: 'pick' | 'fixed'; pick_count: number | null; price: number};

type BundleEntry = Extract<EditEntry, {kind: 'bundle'}>;
type ItemEntry = Extract<EditEntry, {kind: 'item'}>;

/**
 * Reconstruct an order's stored lines into editable entries (individual items +
 * bundle groups), so editing shows the sale's real content on first load. Groups
 * are rebuilt from bundle_group: a header row (product_id null) gives the price
 * and, when present, the bundle_id; the ₱0 product rows in the group are its
 * picks. Each group stays its own bundle (two bundles show as two), never merged.
 *
 * Older or unresolvable sales may carry ₱0 picks without a header (the price sat
 * only on the order total). Such groups reconstruct as custom bundles; a group's
 * bundle is auto-identified by matching its pick quantity to a bundle's pick_count
 * (unique), and any leftover premium is defaulted onto the ₱0-priced bundles (a
 * matched bundle takes its list price first, the remainder lands on the first).
 * A truly ungrouped legacy bundle (loose ₱0 items + premium) folds into one
 * custom bundle. Everything stays editable; saving self-heals into grouped shape.
 */
export function orderToEntries(order: PosOrder, defs: BundleMatch[] = []): EditEntry[] {
  const out: EditEntry[] = [];
  const groupIndex = new Map<string, number>();
  for (const l of order.items) {
    const grp = l.bundle_group ?? null;
    if (grp != null) {
      let idx = groupIndex.get(grp);
      if (idx === undefined) {
        idx = out.length;
        groupIndex.set(grp, idx);
        out.push({kind: 'bundle', bundle_id: '', price: 0, picks: []});
      }
      const e = out[idx] as BundleEntry;
      if (l.product_id == null) {
        // Header line (real bundle header or a custom premium line): carries price.
        e.price = l.line_total;
        if (l.bundle_id) e.bundle_id = l.bundle_id;
      } else {
        e.picks.push({product_id: l.product_id, qty: l.qty});
      }
    } else if (l.bundle_id && l.product_id == null) {
      out.push({kind: 'bundle', bundle_id: l.bundle_id, price: l.line_total, picks: []});
    } else if (l.product_id) {
      out.push({kind: 'item', product_id: l.product_id, qty: l.qty, unit_price: l.unit_price});
    }
  }

  const defById = new Map(defs.map((d) => [d.bundle_id, d]));
  // Auto-identify unlinked bundle groups by matching pick quantity to a pick_count.
  for (const e of out) {
    if (e.kind === 'bundle' && !e.bundle_id) {
      const pickQty = e.picks.reduce((s, p) => s + p.qty, 0);
      const matches = defs.filter((d) => d.bundle_type === 'pick' && d.pick_count === pickQty);
      if (matches.length === 1) e.bundle_id = matches[0].bundle_id;
    }
  }

  // Default prices for any bundle group that lacks one (no header recorded).
  const sumAmounts = () => out.reduce((s, e) => s + (e.kind === 'item' ? e.qty * e.unit_price : e.price), 0);
  let leftover = order.total - sumAmounts();
  if (leftover > 0.005) {
    for (const e of out) {
      if (e.kind === 'bundle' && e.price === 0) {
        const def = defById.get(e.bundle_id);
        if (def && def.price > 0 && def.price <= leftover) {
          e.price = def.price;
          leftover -= def.price;
        }
      }
    }
    if (leftover > 0.005) {
      const t = out.find((e): e is BundleEntry => e.kind === 'bundle' && e.price === 0);
      if (t) {
        t.price += leftover;
        leftover = 0;
      }
    }
  }

  // Truly ungrouped legacy bundle: loose ₱0 items with a premium on the total.
  if (leftover > 0.005) {
    const zeros = out.filter((e): e is ItemEntry => e.kind === 'item' && e.unit_price === 0);
    if (zeros.length > 0) {
      const rest = out.filter((e) => !(e.kind === 'item' && e.unit_price === 0));
      const pickQty = zeros.reduce((s, e) => s + e.qty, 0);
      const matches = defs.filter((d) => d.bundle_type === 'pick' && d.pick_count === pickQty);
      rest.push({kind: 'bundle', bundle_id: matches.length === 1 ? matches[0].bundle_id : '', price: leftover, picks: zeros.map((e) => ({product_id: e.product_id, qty: e.qty}))});
      return rest;
    }
  }
  return out;
}

/**
 * Reconcile itemized (per-product) revenue with the Revenue KPI. Bundle revenue
 * is everything NOT attributed to a product line, whether it sits on a bundle_id
 * line (post write-path fix) or only on the order header (pre-fix / offline
 * retries). So itemizedRevenue sums product lines only, and bundleRevenue is the
 * remainder; itemizedRevenue + bundleRevenue == totalRevenue by construction.
 */
export function bundleSalesSummary(orders: PosOrder[]): BundleSalesSummary {
  let itemizedRevenue = 0;
  let totalRevenue = 0;
  let bundleOrders = 0;
  for (const o of orders) {
    if (isVoided(o)) continue;
    totalRevenue += o.total;
    let productLineSum = 0;
    for (const it of o.items) if (it.product_id) productLineSum += it.line_total;
    itemizedRevenue += productLineSum;
    if (o.total - productLineSum > 0) bundleOrders += 1;
  }
  return {itemizedRevenue, bundleRevenue: totalRevenue - itemizedRevenue, bundleOrders, totalRevenue};
}

/**
 * Top bundles by revenue, from bundle_id lines. Only sales recorded with a real
 * bundle line appear here (online sales after the write-path fix); pre-fix and
 * offline-retried bundle sales carry no bundle_id, so they don't show by name
 * but are still counted in bundleSalesSummary's bundleRevenue. Voided excluded.
 */
export function topBundles(orders: PosOrder[], limit = 5): TopBundle[] {
  const byBundle = new Map<string, TopBundle>();
  for (const o of orders) {
    if (isVoided(o)) continue;
    for (const it of o.items) {
      if (!it.bundle_id) continue;
      const cur = byBundle.get(it.bundle_id) ?? {bundle_id: it.bundle_id, name: it.name, revenue: 0, orders: 0};
      cur.revenue += it.line_total;
      cur.orders += 1;
      byBundle.set(it.bundle_id, cur);
    }
  }
  return Array.from(byBundle.values())
    .sort((a, b) => b.revenue - a.revenue || b.orders - a.orders)
    .slice(0, limit);
}

// ── Transactions filters ──────────────────────────────────────────────────
export const DEFAULT_ORDERS_FILTER: PosOrdersFilter = {
  method: 'all',
  status: 'all',
  event: 'all',
  startDate: null,
  endDate: null,
  minPrice: null,
  maxPrice: null,
};

/**
 * The events in scope for the Transactions Event filter, per the show rule: when a
 * date range is selected, the events overlapping that range; otherwise the events
 * live today. The filter is only shown (and worth showing) when this returns 2+.
 * All dated events count (including closed ones), since a closed event's sales are
 * still in the list. Manila day keys throughout.
 */
export function eventFilterScope(events: PosEvent[], filter: PosOrdersFilter, todayKey: string): PosEvent[] {
  const dated = events.filter((e) => e.starts_on || e.ends_on);
  const from = (e: PosEvent) => (e.starts_on ?? e.ends_on) as string;
  const to = (e: PosEvent) => (e.ends_on ?? e.starts_on) as string;
  if (filter.startDate || filter.endDate) {
    const lo = filter.startDate ? manilaDayKey(filter.startDate) : null;
    const hi = filter.endDate ? manilaDayKey(filter.endDate) : null;
    const rangeLo = (lo ?? hi) as string;
    const rangeHi = (hi ?? lo) as string;
    return dated.filter((e) => from(e) <= rangeHi && rangeLo <= to(e));
  }
  return dated.filter((e) => from(e) <= todayKey && todayKey <= to(e));
}

/**
 * The dated events whose range covers a given order's Manila day. These are the
 * plausible events a sale could belong to, so the reassign control offers exactly
 * these (plus Untagged), and only makes the badge interactive when there are 2+
 * (an unambiguous day has nothing to switch to).
 */
export function eventsCoveringOrder(order: {created_at: string}, events: PosEvent[]): PosEvent[] {
  const day = manilaDayKey(order.created_at);
  const from = (e: PosEvent) => (e.starts_on ?? e.ends_on) as string;
  const to = (e: PosEvent) => (e.ends_on ?? e.starts_on) as string;
  return events.filter((e) => (e.starts_on || e.ends_on) && from(e) <= day && day <= to(e));
}

/** Methods offered as filter chips (mirrors the POS cart Pay control order). */
export const ORDER_METHOD_FILTERS: {value: string; label: string}[] = [
  {value: 'all', label: 'All'},
  {value: 'cash', label: 'Cash'},
  {value: 'qrph', label: 'QRPH'},
  {value: 'gcash', label: 'GCash'},
  {value: 'maya', label: 'Maya'},
  {value: 'card', label: 'Card'},
];

/** Status chips for the transactions filter. */
export const ORDER_STATUS_FILTERS: {value: string; label: string}[] = [
  {value: 'all', label: 'All'},
  {value: 'completed', label: 'Completed'},
  {value: 'voided', label: 'Voided'},
];

/** Parse a non-negative number param; null when blank or invalid. */
function parseMoneyParam(raw: string | undefined): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** A valid ISO instant string, else null. */
export function parseInstantParam(raw: string | undefined): string | null {
  if (raw == null || raw === '') return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

/** Normalize raw search params into a well-formed filter (unknowns fall back). */
export function parseOrdersFilter(sp: {
  method?: string;
  status?: string;
  event?: string;
  from?: string;
  to?: string;
  min?: string;
  max?: string;
}): PosOrdersFilter {
  const method = ORDER_METHOD_FILTERS.some((m) => m.value === sp.method) ? (sp.method as string) : 'all';
  const status = ORDER_STATUS_FILTERS.some((s) => s.value === sp.status) ? (sp.status as string) : 'all';
  // event is an event_id (uuid) or the literal 'untagged'; anything else (incl.
  // blank) means no event filter. An unknown id simply matches nothing, which is
  // harmless. Visibility of the control is decided separately (eventFilterScope).
  const event = sp.event && sp.event.trim() !== '' ? sp.event.trim() : 'all';
  let startDate = parseInstantParam(sp.from);
  let endDate = parseInstantParam(sp.to);
  // A reversed range is a user error; swap so it always reads earliest → latest.
  if (startDate && endDate && Date.parse(startDate) > Date.parse(endDate)) {
    [startDate, endDate] = [endDate, startDate];
  }
  let minPrice = parseMoneyParam(sp.min);
  let maxPrice = parseMoneyParam(sp.max);
  // A reversed price range is a user error; swap so it always reads low → high.
  if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
    [minPrice, maxPrice] = [maxPrice, minPrice];
  }
  return {method, status, event, startDate, endDate, minPrice, maxPrice};
}

/** True when any filter is narrowing the results (used to show a Reset). */
export function isFilterActive(f: PosOrdersFilter): boolean {
  return f.method !== 'all' || f.status !== 'all' || f.event !== 'all' || f.startDate != null || f.endDate != null || f.minPrice != null || f.maxPrice != null;
}

/** A null payment_method is a legacy row; the UI reads it as Cash, so match it. */
function methodMatches(orderMethod: string | null, filterMethod: string): boolean {
  if (filterMethod === 'all') return true;
  if (filterMethod === 'cash') return orderMethod === 'cash' || orderMethod == null;
  return orderMethod === filterMethod;
}

/** Apply the transactions filter in memory (mock path + unit tests). */
export function filterOrders(orders: PosOrder[], f: PosOrdersFilter): PosOrder[] {
  return orders.filter((o) => {
    if (!methodMatches(o.payment_method, f.method)) return false;
    if (f.status !== 'all' && o.status !== f.status) return false;
    if (f.event === 'untagged') { if (o.event_id != null) return false; }
    else if (f.event !== 'all' && o.event_id !== f.event) return false;
    if (f.startDate && o.created_at < f.startDate) return false;
    if (f.endDate && o.created_at > f.endDate) return false;
    if (f.minPrice != null && o.total < f.minPrice) return false;
    if (f.maxPrice != null && o.total > f.maxPrice) return false;
    return true;
  });
}

/** Slider bounds from the dataset's max order total, rounded up to a clean step. */
export function priceBounds(orders: PosOrder[]): PriceBounds {
  const max = orders.reduce((m, o) => Math.max(m, o.total), 0);
  return boundsFromMax(max);
}

/** Round a raw max total up to a tidy slider ceiling (nearest 100, min 100). */
export function boundsFromMax(max: number): PriceBounds {
  const ceiling = Math.max(100, Math.ceil(max / 100) * 100);
  return {min: 0, max: ceiling};
}

// ── Pagination (transactions list) ────────────────────────────────────────
export const ORDERS_PAGE_SIZE = 10;

export interface PageInfo {
  page: number; // clamped, 1-based
  pageSize: number;
  totalPages: number;
  from: number; // 0-based inclusive start index (for a range query)
  to: number; // 0-based inclusive end index
  total: number; // rows matching the filter, across all pages
}

/** Pure page math: clamp `page` into [1, totalPages] and derive range indices. */
export function paginate(total: number, page: number, pageSize = ORDERS_PAGE_SIZE): PageInfo {
  const size = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(total / size));
  const clamped = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const from = (clamped - 1) * size;
  const to = from + size - 1;
  return {page: clamped, pageSize: size, totalPages, from, to, total: Math.max(0, total)};
}

/** Parse a `?page=` param into a positive integer, defaulting to 1. */
export function parsePage(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

// ── Business Health channel facts (Surface D) ─────────────────────────────
/**
 * Build a synthetic "offline" ChannelFacts from POS orders so Business Health
 * can render offline as a fourth channel that pools into the Overall QRR. Shaped
 * like the Website channel: no ads (adSpend/adRevenue null → no ROAS), no
 * platform fee, and a ₱0 event-cost default so it stays OUT of the pooled QRR
 * until someone enters an event cost. buyers is 0 — the POS has no buyer
 * identity — so the card shows Repeat rate N/A. Returns null when there are no
 * orders (nothing to show).
 */
export function offlineChannelFacts(orders: PosOrder[]): ChannelFacts | null {
  if (orders.length === 0) return null;
  const {revenue, orders: count} = computeKpis(orders);
  return {
    channel: 'offline',
    orders: count,
    buyers: 0,
    revenue,
    adSpend: null,
    adRevenue: null,
    platformFeeApplies: false,
    defaults: {cogsPct: 0.35, platformFeePct: 0, promos: 0, acqCost: 0},
  };
}

/**
 * Offline metrics shaped for the Overview "Compare Channels" chart: revenue,
 * orders, aov, units — no adSpend/roas (bazaar sales have no ads, shown as N-A).
 * Returns null when there are no orders. The shape mirrors the chart's per-channel
 * metric record (keys: revenue, orders, aov, units, adSpend, roas).
 */
export function offlineCompareMetrics(orders: PosOrder[]): {
  revenue: number;
  orders: number;
  aov: number;
  units: number;
  adSpend: number | null;
  roas: number | null;
} | null {
  if (orders.length === 0) return null;
  const {revenue, orders: count, units} = computeKpis(orders);
  return {
    revenue,
    orders: count,
    aov: count ? Math.round((revenue / count) * 100) / 100 : 0,
    units,
    adSpend: null,
    roas: null,
  };
}

// ── Stock alerts (Surface B) ──────────────────────────────────────────────
export const LOW_STOCK_UNITS = 10;
export const NEAR_EXPIRY_DAYS = 30;

export interface StockAlerts {
  low: PosProductRow[]; // in stock but at/under the low threshold (excludes out)
  out: PosProductRow[]; // zero or negative stock
  nearExpiry: PosProductRow[]; // has stock and an expiry within the window
}

/** Split the catalog into low / out / near-expiry buckets for the alerts card. */
export function stockAlerts(
  products: PosProductRow[],
  now: Date = new Date(),
  lowUnits = LOW_STOCK_UNITS,
  expiryDays = NEAR_EXPIRY_DAYS,
): StockAlerts {
  const horizon = new Date(now);
  horizon.setUTCDate(horizon.getUTCDate() + expiryDays);
  const horizonIso = horizon.toISOString().slice(0, 10);

  const low: PosProductRow[] = [];
  const out: PosProductRow[] = [];
  const nearExpiry: PosProductRow[] = [];

  for (const p of products) {
    if (p.stock <= 0) out.push(p);
    else if (p.stock <= lowUnits) low.push(p);
    if (p.stock > 0 && p.next_expiry && p.next_expiry <= horizonIso) nearExpiry.push(p);
  }

  low.sort((a, b) => a.stock - b.stock);
  nearExpiry.sort((a, b) => (a.next_expiry ?? '').localeCompare(b.next_expiry ?? ''));
  return {low, out, nearExpiry};
}
