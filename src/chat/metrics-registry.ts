import type {PosEvent, PosOrder} from '../pos-sales-types';
import {bundleSalesSummary, computeKpis, eventRollups, paymentBreakdown, petMix, salesByDay, topProducts} from '../pos-sales-compute';
import {aggregatePicks, bundlePickRows, bundleRevenueByPet, type PetBucket, type PicksBy} from '../pos-bundle-compute';
import {priceChangesInRange, type PriceHistory} from '../pos-price-history';
import {formatPeso} from '../pos-format';
import {addDaysKey, dayKeysBetween, mondayOf} from './range';
import type {ChecksInput, ColumnRole, ColumnUnit, InsightCode, InsightsInput, MeasureDecl, MetricId, MetricRow, ResultColumn} from './result-types';

// The semantic layer: one definition per number Ask Coop can show (knowledge/best-practices/chat-metrics-registry.md).
// Each metric declares its dimensions and measures, and a pure `compute` over already-filtered orders.
// The executor (query-metric.ts) validates the request, filters orders, then calls `compute`.

export type DimensionShape = 'aggregate' | 'category' | 'series' | 'matrix';

export interface DimensionDecl {
  key: string;
  label: string;
  /** aggregate/category rows can be compared with the previous period; series (day/week) and matrix cannot. */
  shape: DimensionShape;
}

export interface AnalystProfile {
  job: 'compare' | 'trend' | 'composition' | 'single' | 'detail';
  headlineColumns: string[];
  shareBasis: string | null;
}

export interface ComputeContext {
  /** Non-voided orders inside the range, after the event and pet filters. */
  orders: PosOrder[];
  /** All events (for names and event attribution). */
  events: PosEvent[];
  history: PriceHistory;
  dimension: string;
  /** A declared measure key (never 'default'). */
  measure: string;
  range: {from: string; to: string; label: string};
  /** The part of the range the data covers (null/null when none): series only list days inside it. */
  covered: {from: string | null; to: string | null};
  /** Ids of the orders that carry an explicit POS event tag (before date attribution); the rest of the orders with an event were attributed by date. */
  taggedIds: ReadonlySet<string>;
}

export interface InsightSet {
  input: InsightsInput;
  /** Keep only these insight codes from this set (default: all). */
  codes?: InsightCode[];
}

export interface ComputeOutput {
  columns: ResultColumn[];
  rows: MetricRow[];
  /** The column that value sorts use; null = not sortable (one row, or a series). */
  sortKey: string | null;
  defaultSort: 'value_desc' | 'natural';
  /** Whether `limit` may cut rows (false for closed small sets and series). */
  limitable: boolean;
  /** Where compare_to finds the key and the measure value; null = not comparable. */
  compare: {keyColumn: string | null; valueColumn: string} | null;
  shareBasis: string | null;
  notes: string[];
  reconcile: ChecksInput['reconcile'];
  zeroValueLines: ChecksInput['zeroValueLines'];
  priceChanges: ChecksInput['priceChanges'];
  untagged: ChecksInput['untagged'];
  insights: InsightSet[];
}

export interface MetricDef {
  id: MetricId;
  label: string;
  description: string;
  dimensions: readonly DimensionDecl[];
  measures: readonly MeasureDecl[];
  defaultMeasure: string;
  defaultDimension: string;
  supportsPet: boolean;
  supportsEvent: boolean;
  supportsCompare: boolean;
  profile: AnalystProfile;
  compute: (ctx: ComputeContext) => ComputeOutput;
}

// ---- helpers ------------------------------------------------------------------------------------------------------

const col = (key: string, label: string, unit: ColumnUnit, role: ColumnRole): ResultColumn => ({key, label, unit, role});
export const r2 = (n: number): number => Math.round(n * 100) / 100;
const r1 = (n: number): number => Math.round(n * 10) / 10;
const PETS = ['dog', 'cat', 'both', 'untagged'] as const satisfies readonly PetBucket[];
const TAGGED = ['dog', 'cat', 'both'] as const;
const PET_LABEL: Record<PetBucket, string> = {dog: 'Dog', cat: 'Cat', both: 'Both', untagged: 'Untagged'};
const ratio2 = (a: number, b: number): number | null => (b === 0 ? null : r2(a / b));

/**
 * Shares in percent, to one decimal, from the unrounded values. Plain rounding, except that when the rounded shares
 * would miss 100.0 by more than 0.1 the largest rounding errors are nudged one tenth so they add up (reconciles
 * tolerance for percent is 0.1). All null when the values add to nothing (a share of zero is not defined).
 */
export function sharesOf(values: number[]): (number | null)[] {
  const total = values.reduce((s, v) => s + Math.max(v, 0), 0);
  if (!(total > 0)) return values.map(() => null);
  const exact = values.map((v) => (Math.max(v, 0) / total) * 1000);
  const tenths = exact.map(Math.round);
  let diff = 1000 - tenths.reduce((s, t) => s + t, 0);
  if (Math.abs(diff) > 1) {
    const step = diff > 0 ? 1 : -1;
    // Rounded down the most (exact - rounded largest) go up first; rounded up the most go down first.
    const order = exact.map((e, i) => ({i, err: (e - tenths[i]) * step})).sort((a, b) => b.err - a.err || a.i - b.i);
    for (let k = 0; diff !== 0 && k < order.length; k++, diff -= step) tenths[order[k].i] += step;
  }
  return tenths.map((t) => t / 10);
}

const money = (n: number): string => formatPeso(n);
const fmtOf = (measure: string): 'peso' | 'count' => (measure === 'revenue' ? 'peso' : 'count');

const NO_EXTRAS = {zeroValueLines: null, priceChanges: null, untagged: null} as const;

function empty(): ComputeOutput {
  return {
    columns: [], rows: [], sortKey: null, defaultSort: 'natural', limitable: false, compare: null, shareBasis: null,
    notes: [], reconcile: [], insights: [], ...NO_EXTRAS,
  };
}

/** Unique, readable labels: a repeated label gets its id appended. */
function uniqueLabels(items: {label: string; id: string}[]): string[] {
  const seen = new Map<string, number>();
  for (const i of items) seen.set(i.label, (seen.get(i.label) ?? 0) + 1);
  return items.map((i) => ((seen.get(i.label) ?? 0) > 1 ? `${i.label} (${i.id})` : i.label));
}

// ---- offline_revenue / offline_orders / offline_aov ---------------------------------------------------------------

interface Bucket {period: string; revenueC: number; orders: number}

/** Day or week buckets inside the covered part of the range. Empty days inside coverage are real zeros. */
function timeBuckets(ctx: ComputeContext, by: 'day' | 'week'): Bucket[] {
  const {from, to} = ctx.covered;
  if (!from || !to) return [];
  const daily = new Map(salesByDay(ctx.orders).map((d) => [d.day, d]));
  const keyOf = (day: string): string => (by === 'day' ? day : mondayOf(day));
  const buckets = new Map<string, Bucket>();
  for (const day of dayKeysBetween(from, to)) {
    const k = keyOf(day);
    const b = buckets.get(k) ?? {period: k, revenueC: 0, orders: 0};
    const d = daily.get(day);
    if (d) {
      b.revenueC += Math.round(d.revenue * 100);
      b.orders += d.orders;
    }
    buckets.set(k, b);
  }
  return [...buckets.values()];
}

function weekNote(ctx: ComputeContext): string[] {
  const {from, to} = ctx.covered;
  if (!from || !to) return [];
  const partial = mondayOf(from) !== from || addDaysKey(mondayOf(to), 6) !== to;
  return partial ? ['Weeks run Monday to Sunday; the first or last week is partial because the range does not start on a Monday or end on a Sunday.'] : [];
}

type TotalsKey = 'revenue' | 'orders' | 'aov';

function computeTotals(ctx: ComputeContext, measure: TotalsKey): ComputeOutput {
  const out = empty();
  const kpis = computeKpis(ctx.orders);
  const revenue = r2(kpis.revenue);
  const aov = kpis.orders === 0 ? null : r2(kpis.revenue / kpis.orders);
  const unit: ColumnUnit = measure === 'orders' ? 'count' : 'PHP';
  const value = measure === 'revenue' ? revenue : measure === 'orders' ? kpis.orders : aov;
  out.compare = {keyColumn: null, valueColumn: measure};

  if (ctx.dimension === 'none') {
    if (measure === 'aov') {
      out.columns = [col('period', 'Period', 'text', 'category'), col('orders', 'Orders', 'count', 'measure'), col('revenue', 'Revenue', 'PHP', 'measure'), col('aov', 'Average order value', 'PHP', 'measure')];
      out.rows = [{period: ctx.range.label, orders: kpis.orders, revenue, aov}];
    } else {
      out.columns = [col(measure, measure === 'revenue' ? 'Revenue' : 'Orders', unit, 'measure')];
      out.rows = [{[measure]: value}];
    }
    return out;
  }

  const by = ctx.dimension === 'week' ? 'week' : 'day';
  const buckets = timeBuckets(ctx, by);
  out.notes = by === 'week' ? weekNote(ctx) : [];
  const periodCol = col('period', by === 'week' ? 'Week starting (Monday)' : 'Day', 'date', 'time');
  if (measure === 'aov') {
    out.columns = [periodCol, col('orders', 'Orders', 'count', 'measure'), col('revenue', 'Revenue', 'PHP', 'measure'), col('aov', 'Average order value', 'PHP', 'measure')];
    out.rows = buckets.map((b) => ({period: b.period, orders: b.orders, revenue: b.revenueC / 100, aov: b.orders === 0 ? null : r2(b.revenueC / 100 / b.orders)}));
    out.reconcile = [
      {label: `Revenue by ${by}`, parts: buckets.map((b) => b.revenueC / 100), whole: revenue},
      {label: `Orders by ${by}`, parts: buckets.map((b) => b.orders), whole: kpis.orders, format: 'count'},
    ];
  } else {
    out.columns = [periodCol, col(measure, measure === 'revenue' ? 'Revenue' : 'Orders', unit, 'measure')];
    out.rows = buckets.map((b) => ({period: b.period, [measure]: measure === 'revenue' ? b.revenueC / 100 : b.orders}));
    out.reconcile = [
      measure === 'revenue'
        ? {label: `Revenue by ${by}`, parts: buckets.map((b) => b.revenueC / 100), whole: revenue}
        : {label: `Orders by ${by}`, parts: buckets.map((b) => b.orders), whole: kpis.orders, format: 'count'},
    ];
  }
  out.compare = null; // a day/week series is not compared with the previous period
  return out;
}

// ---- top_products ---------------------------------------------------------------------------------------------------

function computeTopProducts(ctx: ComputeContext): ComputeOutput {
  const out = empty();
  const byUnits = ctx.measure === 'units';
  // Reuse topProducts with a very large limit; sort and limit are applied by the executor after shares.
  const all = topProducts(ctx.orders, Number.MAX_SAFE_INTEGER, byUnits ? 'units' : 'revenue');
  const values = all.map((p) => (byUnits ? p.units : p.revenue));
  const shares = sharesOf(values);
  out.columns = [
    col('product', 'Product', 'text', 'category'),
    col('units', 'Units', 'units', 'measure'),
    col('revenue', 'Revenue (itemized)', 'PHP', 'measure'),
    col('share', byUnits ? 'Share of units' : 'Share of itemized revenue', 'percent', 'share'),
  ];
  out.rows = all.map((p, i) => ({product: p.name, units: p.units, revenue: r2(p.revenue), share: shares[i]}));
  out.sortKey = ctx.measure;
  out.defaultSort = 'value_desc';
  out.limitable = true;
  out.compare = {keyColumn: 'product', valueColumn: ctx.measure};
  out.shareBasis = byUnits ? 'all units sold' : 'all itemized revenue';
  if (byUnits) {
    let unitsWhole = 0;
    for (const o of ctx.orders) for (const l of o.items) if (l.product_id) unitsWhole += l.qty;
    out.reconcile = [{label: 'Units by product', parts: all.map((p) => p.units), whole: unitsWhole, format: 'count'}];
  } else {
    out.reconcile = [{label: 'Itemized revenue by product', parts: all.map((p) => r2(p.revenue)), whole: r2(bundleSalesSummary(ctx.orders).itemizedRevenue)}];
  }
  const bundled = all.reduce((s, p) => s + p.bundledUnits, 0);
  if (bundled > 0) {
    out.notes.push(`${bundled.toLocaleString('en-US')} units were sold inside bundles (₱0 lines); revenue here is itemized product lines only. Bundle money is in bundle_sales and bundle_picks.`);
  }
  out.insights = [{input: {basis: out.shareBasis, format: byUnits ? 'units' : 'peso', items: all.map((p, i) => ({label: p.name, value: values[i]}))}}];
  return out;
}

// ---- payment_mix ----------------------------------------------------------------------------------------------------

function computePaymentMix(ctx: ComputeContext): ComputeOutput {
  const out = empty();
  const byOrders = ctx.measure === 'orders';
  const slices = paymentBreakdown(ctx.orders);
  const values = slices.map((s) => (byOrders ? s.orders : r2(s.revenue)));
  const shares = sharesOf(values);
  const kpis = computeKpis(ctx.orders);
  out.columns = [
    col('method', 'Payment method', 'text', 'category'),
    col('value', byOrders ? 'Orders' : 'Revenue', byOrders ? 'count' : 'PHP', 'measure'),
    col('share', byOrders ? 'Share of orders' : 'Share of revenue', 'percent', 'share'),
  ];
  out.rows = slices.map((s, i) => ({method: s.method, value: values[i], share: shares[i]}));
  out.sortKey = 'value';
  out.defaultSort = 'value_desc';
  out.limitable = true;
  out.compare = {keyColumn: 'method', valueColumn: 'value'};
  out.shareBasis = byOrders ? 'all orders' : 'all revenue';
  out.reconcile = [{label: 'Payment methods', parts: values, whole: byOrders ? kpis.orders : r2(kpis.revenue), format: byOrders ? 'count' : 'peso'}];
  out.insights = [{input: {basis: out.shareBasis, format: byOrders ? 'count' : 'peso', items: slices.map((s, i) => ({label: s.method, value: values[i]}))}}];
  return out;
}

// ---- event_rollup ---------------------------------------------------------------------------------------------------

function computeEventRollup(ctx: ComputeContext): ComputeOutput {
  const out = empty();
  const byOrders = ctx.measure === 'orders';
  const rolls = eventRollups(ctx.events, ctx.orders).filter((r) => r.orders > 0);
  const known = new Set(ctx.events.map((e) => e.event_id));
  let unknownRevenue = 0;
  let unknownOrders = 0;
  let walkInRevenue = 0;
  let walkInOrders = 0;
  for (const o of ctx.orders) {
    if (!o.event_id) {
      walkInRevenue += o.total;
      walkInOrders += 1;
    } else if (!known.has(o.event_id)) {
      unknownRevenue += o.total;
      unknownOrders += 1;
    }
  }
  const labels = uniqueLabels(rolls.map((r) => ({label: r.event.name ?? r.event.event_id, id: r.event.event_id})));
  // Per event: how many of its orders carry the explicit POS tag, the rest were attributed by the event dates (code, never the model).
  const taggedBy = new Map<string, number>();
  for (const o of ctx.orders) if (o.event_id && ctx.taggedIds.has(o.id)) taggedBy.set(o.event_id, (taggedBy.get(o.event_id) ?? 0) + 1);
  const entries = rolls.map((r, i) => ({event: labels[i], revenue: r2(r.revenue), orders: r.orders, tagged: taggedBy.get(r.event.event_id) ?? 0}));
  if (unknownOrders > 0) {
    const unknownTagged = ctx.orders.filter((o) => o.event_id && !known.has(o.event_id) && ctx.taggedIds.has(o.id)).length;
    entries.push({event: 'Unknown event', revenue: r2(unknownRevenue), orders: unknownOrders, tagged: unknownTagged});
  }
  const values = entries.map((e) => (byOrders ? e.orders : e.revenue));
  const shares = sharesOf(values);
  out.columns = [
    col('event', 'Event', 'text', 'category'),
    col('revenue', 'Revenue', 'PHP', 'measure'),
    col('orders', 'Orders', 'count', 'measure'),
    col('share', byOrders ? 'Share of event orders' : 'Share of event revenue', 'percent', 'share'),
    col('tagged_orders', 'Tagged orders', 'count', 'measure'),
    col('date_orders', 'Orders by date', 'count', 'measure'),
  ];
  out.rows = entries.map((e, i) => ({event: e.event, revenue: e.revenue, orders: e.orders, share: shares[i], tagged_orders: e.tagged, date_orders: e.orders - e.tagged}));
  out.sortKey = ctx.measure;
  out.defaultSort = 'value_desc';
  out.limitable = true;
  out.compare = {keyColumn: 'event', valueColumn: ctx.measure};
  out.shareBasis = byOrders ? 'event orders (walk-in sales excluded)' : 'event revenue (walk-in sales excluded)';
  const kpis = computeKpis(ctx.orders);
  out.reconcile = [{
    label: 'Events plus walk-in sales',
    parts: [...values, byOrders ? walkInOrders : r2(walkInRevenue)],
    whole: byOrders ? kpis.orders : r2(kpis.revenue),
    format: byOrders ? 'count' : 'peso',
  }, {
    label: 'Event orders: tagged plus by date',
    parts: [entries.reduce((n, e) => n + e.tagged, 0), entries.reduce((n, e) => n + (e.orders - e.tagged), 0)],
    whole: entries.reduce((n, e) => n + e.orders, 0),
    format: 'count',
  }];
  if (walkInOrders > 0) {
    out.notes.push(`Walk-in sales with no event are not in these rows: ${money(r2(walkInRevenue))} across ${walkInOrders.toLocaleString('en-US')} orders.`);
  }
  out.insights = [{input: {basis: out.shareBasis, format: byOrders ? 'count' : 'peso', items: entries.map((e, i) => ({label: e.event, value: values[i]}))}}];
  return out;
}

// ---- pet_mix --------------------------------------------------------------------------------------------------------

function computePetMix(ctx: ComputeContext): ComputeOutput {
  const out = empty();
  const byOrders = ctx.measure === 'orders';
  const mix = petMix(ctx.orders);
  const value = (p: PetBucket): number => (byOrders ? mix[p].orders : r2(mix[p].revenue));
  const taggedShares = sharesOf(TAGGED.map(value));
  const kpis = computeKpis(ctx.orders);
  out.columns = [
    col('pet', 'Pet', 'text', 'category'),
    col('value', byOrders ? 'Orders' : 'Revenue', byOrders ? 'count' : 'PHP', 'measure'),
    col('share', byOrders ? 'Share of tagged orders' : 'Share of tagged revenue', 'percent', 'share'),
  ];
  out.rows = PETS.map((p) => ({pet: p, value: value(p), share: p === 'untagged' ? null : taggedShares[TAGGED.indexOf(p)]}));
  out.sortKey = 'value';
  out.defaultSort = 'natural';
  out.limitable = false;
  out.compare = {keyColumn: 'pet', valueColumn: 'value'};
  out.shareBasis = byOrders ? 'tagged orders' : 'tagged revenue';
  out.reconcile = [{label: 'Pet totals', parts: PETS.map(value), whole: byOrders ? kpis.orders : r2(kpis.revenue), format: byOrders ? 'count' : 'peso'}];
  if (taggedShares.every((s) => s !== null)) {
    out.reconcile.push({label: 'Tagged shares', parts: taggedShares as number[], whole: 100, format: 'percent'});
  }
  out.untagged = {orders: mix.untagged.orders, totalOrders: ctx.orders.length};
  out.insights = [{
    input: {
      basis: out.shareBasis,
      format: byOrders ? 'count' : 'peso',
      items: TAGGED.map((p) => ({label: PET_LABEL[p], value: value(p)})),
      untagged: {label: 'Untagged', value: value('untagged'), orders: mix.untagged.orders, totalOrders: ctx.orders.length},
    },
  }];
  return out;
}

// ---- bundle_sales ---------------------------------------------------------------------------------------------------

function bundleNotes(m: ReturnType<typeof bundleRevenueByPet>): string[] {
  const notes: string[] = [];
  if (m.unnamedRevenue > 0) notes.push(`${money(m.unnamedRevenue)} of bundle revenue has no bundle record and is shown as "Unnamed bundle (no bundle record)".`);
  if (m.negativeResidualOrders > 0) notes.push(`${m.negativeResidualOrders.toLocaleString('en-US')} discounted orders have product lines worth more than the order total; they are left out of bundle revenue.`);
  return notes;
}

/** Bundle orders per pet bucket per bundle name (an order with two bundles counts once for each). */
function bundleOrdersByPet(orders: PosOrder[]): Map<string, Record<PetBucket, number>> {
  const out = new Map<string, Record<PetBucket, number>>();
  for (const p of PETS) {
    const subset = orders.filter((o) => (o.pet_type ?? 'untagged') === p);
    for (const r of bundleRevenueByPet(subset).rows) {
      const cur = out.get(r.bundle) ?? {dog: 0, cat: 0, both: 0, untagged: 0};
      cur[p] = r.orders;
      out.set(r.bundle, cur);
    }
  }
  return out;
}

function computeBundleSales(ctx: ComputeContext): ComputeOutput {
  const out = empty();
  const byOrders = ctx.measure === 'orders';
  const m = bundleRevenueByPet(ctx.orders);
  const unit: ColumnUnit = byOrders ? 'count' : 'PHP';
  const format = byOrders ? 'count' : 'peso';
  const mLabel = byOrders ? 'Orders' : 'Revenue';
  const petValue = (p: PetBucket): number => (byOrders ? m.orders[p] : m.totals[p]);
  const bundleOrders = PETS.reduce((s, p) => s + m.orders[p], 0);
  const kpis = computeKpis(ctx.orders);
  out.notes = bundleNotes(m);
  out.untagged = {orders: m.orders.untagged, totalOrders: bundleOrders};
  out.compare = {keyColumn: null, valueColumn: byOrders ? 'bundle_orders' : 'bundle_revenue'};
  const taggedShares = sharesOf(TAGGED.map((p) => m.totals[p]));
  const petBasis = byOrders ? 'tagged bundle orders' : 'tagged bundle revenue';
  const petInsight: InsightSet = {
    input: {
      basis: petBasis,
      format,
      items: TAGGED.map((p) => ({label: PET_LABEL[p], value: petValue(p)})),
      untagged: {label: 'Untagged', value: petValue('untagged'), orders: m.orders.untagged, totalOrders: bundleOrders},
    },
  };
  const petReconcile: ChecksInput['reconcile'] = [{label: 'Bundle pet totals', parts: PETS.map((p) => m.totals[p]), whole: m.bundleRevenue}];
  if (taggedShares.every((s) => s !== null)) petReconcile.push({label: 'Tagged bundle shares', parts: taggedShares as number[], whole: 100, format: 'percent'});

  if (ctx.dimension === 'none') {
    out.columns = [
      col('bundle_revenue', 'Bundle revenue', 'PHP', 'measure'),
      col('bundle_orders', 'Bundle orders', 'count', 'measure'),
      col('share_of_all_revenue', 'Share of all revenue', 'percent', 'share'),
      col('untagged_orders', 'Untagged bundle orders', 'count', 'measure'),
      col('untagged_revenue', 'Untagged bundle revenue', 'PHP', 'measure'),
      col('dog_share', 'Dog share of tagged', 'percent', 'share'),
      col('cat_share', 'Cat share of tagged', 'percent', 'share'),
      col('both_share', 'Both share of tagged', 'percent', 'share'),
      col('dog_vs_cat_ratio', 'Dog vs cat (times)', 'ratio', 'measure'),
    ];
    out.rows = [{
      bundle_revenue: m.bundleRevenue,
      bundle_orders: bundleOrders,
      share_of_all_revenue: kpis.revenue > 0 ? Math.round((m.bundleRevenue / kpis.revenue) * 1000) / 10 : null,
      untagged_orders: m.orders.untagged,
      untagged_revenue: m.totals.untagged,
      dog_share: taggedShares[0],
      cat_share: taggedShares[1],
      both_share: taggedShares[2],
      dog_vs_cat_ratio: ratio2(m.totals.dog, m.totals.cat),
    }];
    out.shareBasis = 'tagged bundle revenue';
    out.reconcile = petReconcile;
    out.insights = [{input: {...petInsight.input, basis: 'tagged bundle revenue', format: 'peso', items: TAGGED.map((p) => ({label: PET_LABEL[p], value: m.totals[p]})), untagged: {label: 'Untagged', value: m.totals.untagged, orders: m.orders.untagged, totalOrders: bundleOrders}}}];
    return out;
  }

  if (ctx.dimension === 'pet_type') {
    const shares = taggedShares;
    out.columns = [col('pet', 'Pet', 'text', 'category'), col('value', mLabel, unit, 'measure'), col('share_of_tagged', byOrders ? 'Share of tagged orders' : 'Share of tagged revenue', 'percent', 'share')];
    const orderShares = sharesOf(TAGGED.map((p) => m.orders[p]));
    out.rows = PETS.map((p) => ({pet: p, value: petValue(p), share_of_tagged: p === 'untagged' ? null : (byOrders ? orderShares : shares)[TAGGED.indexOf(p)]}));
    out.sortKey = 'value';
    out.defaultSort = 'natural';
    out.compare = {keyColumn: 'pet', valueColumn: 'value'};
    out.shareBasis = petBasis;
    out.reconcile = byOrders ? [{label: 'Bundle orders by pet', parts: PETS.map((p) => m.orders[p]), whole: bundleOrders, format: 'count'}] : petReconcile;
    out.insights = [petInsight];
    return out;
  }

  // Named bundles only for shares; the unnamed row (no bundle record) has no name to rank.
  const ordersByPet = byOrders ? bundleOrdersByPet(ctx.orders) : null;
  const rowsOut = m.rows.map((r) => {
    const named = r.bundle_id !== null; // the unnamed row (no bundle record) has no id
    const byPet = ordersByPet?.get(r.bundle) ?? {dog: 0, cat: 0, both: 0, untagged: 0};
    return {r, named, value: byOrders ? r.orders : r.total, byPet: byOrders ? byPet : {dog: r.dog, cat: r.cat, both: r.both, untagged: r.untagged}};
  });
  const namedShares = sharesOf(rowsOut.filter((x) => x.named).map((x) => x.value));
  let ni = 0;
  const shareOf = rowsOut.map((x) => (x.named ? namedShares[ni++] : null));
  const namedBasis = byOrders ? 'named bundle orders' : 'named bundle revenue';
  const namedItems = rowsOut.filter((x) => x.named).map((x) => ({label: x.r.bundle, value: x.value}));
  out.shareBasis = namedBasis;

  if (ctx.dimension === 'bundle') {
    out.columns = [col('bundle', 'Bundle', 'text', 'category'), col('value', mLabel, unit, 'measure'), col('share_of_named', byOrders ? 'Share of named bundle orders' : 'Share of named bundle revenue', 'percent', 'share')];
    out.rows = rowsOut.map((x, i) => ({bundle: x.r.bundle, value: x.value, share_of_named: shareOf[i]}));
    out.sortKey = 'value';
    out.defaultSort = 'value_desc';
    out.limitable = true;
    out.compare = {keyColumn: 'bundle', valueColumn: 'value'};
    out.reconcile = byOrders
      ? []
      : [{label: 'Bundle rows', parts: rowsOut.map((x) => x.value), whole: m.bundleRevenue}, ...(namedShares.every((s) => s !== null) && namedShares.length > 0 ? [{label: 'Named bundle shares', parts: namedShares as number[], whole: 100, format: 'percent' as const}] : [])];
    out.insights = [{input: {basis: namedBasis, format, items: namedItems}}];
    return out;
  }

  // bundle_by_pet: wide, one row per bundle.
  out.columns = [
    col('bundle', 'Bundle', 'text', 'category'),
    col('dog', 'Dog', unit, 'measure'),
    col('cat', 'Cat', unit, 'measure'),
    col('both', 'Both', unit, 'measure'),
    col('untagged', 'Untagged', unit, 'measure'),
    col('total', byOrders ? 'Total orders' : 'Total', unit, 'measure'),
    col('share_of_named', byOrders ? 'Share of named bundle orders' : 'Share of named bundle revenue', 'percent', 'share'),
  ];
  out.rows = rowsOut.map((x, i) => ({
    bundle: x.r.bundle, dog: x.byPet.dog, cat: x.byPet.cat, both: x.byPet.both, untagged: x.byPet.untagged, total: x.value, share_of_named: shareOf[i],
  }));
  out.sortKey = 'total';
  out.defaultSort = 'value_desc';
  out.limitable = true;
  out.reconcile = byOrders
    ? []
    : [
        {label: 'Bundle rows', parts: rowsOut.map((x) => x.value), whole: m.bundleRevenue},
        {label: 'Bundle by pet cells', parts: rowsOut.flatMap((x) => PETS.map((p) => x.byPet[p])), whole: m.bundleRevenue},
      ];
  const named = rowsOut.filter((x) => x.named);
  out.insights = [
    {
      input: {
        ...petInsight.input,
        matrix: {rows: TAGGED.map((p) => PET_LABEL[p]), cols: named.map((x) => x.r.bundle), values: TAGGED.map((p) => named.map((x) => x.byPet[p]))},
      },
    },
    {input: {basis: namedBasis, format, items: namedItems}, codes: ['concentration']},
  ];
  return out;
}

// ---- bundle_picks ---------------------------------------------------------------------------------------------------

const dayStartIso = (day: string): string => `${day}T00:00:00+08:00`;
const dayEndIso = (day: string): string => `${day}T23:59:59.999+08:00`;

function computeBundlePicks(ctx: ComputeContext): ComputeOutput {
  const out = empty();
  const measure = ctx.measure as 'revenue' | 'list_value' | 'units';
  const by = ctx.dimension as PicksBy;
  const res = bundlePickRows(ctx.orders, ctx.history);
  const agg = aggregatePicks(res.rows, by, measure);
  const unit: ColumnUnit = measure === 'units' ? 'units' : 'PHP';
  const format: 'peso' | 'units' = measure === 'units' ? 'units' : 'peso';
  const mLabel = measure === 'revenue' ? 'Allocated revenue' : measure === 'list_value' ? 'List value' : 'Units';
  const basis = measure === 'revenue' ? 'allocated bundle revenue' : measure === 'list_value' ? 'list value of bundle picks' : 'units picked in bundles';
  const num = (v: unknown): number => Number(v ?? 0);
  const money2 = (v: number): number => (measure === 'units' ? v : r2(v));
  out.shareBasis = basis;
  out.defaultSort = 'value_desc';
  out.limitable = true;
  // Untagged share among the orders that actually have pick detail. Older sales without picks are reported separately
  // (the "no pick detail" note below), so counting every order here would mix two different gaps.
  const pickOrders = new Set(res.rows.map((r) => r.order_id));
  const untaggedPickOrders = new Set(res.rows.filter((r) => r.pet === 'untagged').map((r) => r.order_id));
  out.untagged = {orders: untaggedPickOrders.size, totalOrders: pickOrders.size};
  out.zeroValueLines = {count: res.zeroValueLines, allocatedMeasureUsed: measure === 'revenue'};
  out.priceChanges = priceChangesInRange(ctx.history, dayStartIso(ctx.range.from), dayEndIso(ctx.range.to));

  if (by === 'sku') {
    const values = agg.map((r) => money2(num(r.value)));
    const shares = sharesOf(values);
    out.columns = [col('sku', 'SKU', 'text', 'category'), col('value', mLabel, unit, 'measure'), col('share', `Share of ${basis}`, 'percent', 'share')];
    out.rows = agg.map((r, i) => ({sku: String(r.sku), value: values[i], share: shares[i]}));
    out.sortKey = 'value';
    out.compare = {keyColumn: 'sku', valueColumn: 'value'};
    out.insights = [{input: {basis, format, items: agg.map((r, i) => ({label: String(r.sku), value: values[i]}))}}];
    if (measure === 'revenue') out.reconcile = [{label: 'Allocated revenue by SKU', parts: values, whole: res.paidTotal}];
  } else if (by === 'sku_by_pet') {
    const totals = agg.map((r) => money2(num(r.total)));
    const shares = sharesOf(totals);
    out.columns = [
      col('sku', 'SKU', 'text', 'category'),
      col('dog', 'Dog', unit, 'measure'),
      col('cat', 'Cat', unit, 'measure'),
      col('both', 'Both', unit, 'measure'),
      col('untagged', 'Untagged', unit, 'measure'),
      col('total', 'Total', unit, 'measure'),
      col('share', `Share of ${basis}`, 'percent', 'share'),
    ];
    out.rows = agg.map((r, i) => ({sku: String(r.sku), dog: money2(num(r.dog)), cat: money2(num(r.cat)), both: money2(num(r.both)), untagged: money2(num(r.untagged)), total: totals[i], share: shares[i]}));
    out.sortKey = 'total';
    const petTotals = (p: PetBucket): number => out.rows.reduce((s, r) => s + num(r[p]), 0);
    out.insights = [{
      input: {
        basis, format,
        items: agg.map((r, i) => ({label: String(r.sku), value: totals[i]})),
        untagged: {label: 'Untagged', value: money2(petTotals('untagged'))},
        matrix: {rows: TAGGED.map((p) => PET_LABEL[p]), cols: agg.map((r) => String(r.sku)), values: TAGGED.map((p) => out.rows.map((r) => num(r[p])))},
      },
    }];
    if (measure === 'revenue') out.reconcile = [{label: 'Allocated revenue by SKU and pet', parts: out.rows.flatMap((r) => PETS.map((p) => num(r[p]))), whole: res.paidTotal}];
  } else {
    // bundle_by_sku: long form, shares within each bundle (largest remainder per bundle).
    const values = agg.map((r) => money2(num(r.value)));
    const shares: (number | null)[] = new Array(agg.length).fill(null);
    const byBundle = new Map<string, number[]>();
    agg.forEach((r, i) => byBundle.set(String(r.bundle), [...(byBundle.get(String(r.bundle)) ?? []), i]));
    for (const idx of byBundle.values()) sharesOf(idx.map((i) => values[i])).forEach((s, k) => (shares[idx[k]] = s));
    out.columns = [col('bundle', 'Bundle', 'text', 'category'), col('sku', 'SKU', 'text', 'category'), col('value', mLabel, unit, 'measure'), col('share_of_bundle', `Share of the bundle's ${basis}`, 'percent', 'share')];
    out.rows = agg.map((r, i) => ({bundle: String(r.bundle), sku: String(r.sku), value: values[i], share_of_bundle: shares[i]}));
    out.defaultSort = 'natural';
    out.sortKey = 'value';
    if (measure === 'revenue') out.reconcile = [{label: 'Allocated revenue by bundle and SKU', parts: values, whole: res.paidTotal}];
  }
  // Only the revenue measure has a whole to reconcile (the bundles' paid prices). list_value is a derived valuation at
  // list prices and units are plain counts: neither has a parent total, so no reconcile claim is made for them.

  // Coverage of this breakdown: older bundle sales were recorded without their picks, so they cannot be broken down by SKU.
  const bundleRevenue = bundleRevenueByPet(ctx.orders).bundleRevenue;
  const noPickDetail = r2(bundleRevenue - res.paidTotal - res.unallocatedPaid);
  if (noPickDetail >= 1) {
    out.notes.push(`${money(noPickDetail)} of bundle revenue (${r1((noPickDetail / bundleRevenue) * 100)}%) has no pick detail (older sales), so these SKU figures cover ${money(res.paidTotal)} of ${money(bundleRevenue)}.`);
  }

  if (res.groupsWithoutPicks > 0) out.notes.push(`${res.groupsWithoutPicks.toLocaleString('en-US')} bundle sales have no pick lines, so ${money(res.unallocatedPaid)} of their paid price is not allocated to any SKU.`);
  if (res.groupsWithoutHeader > 0) out.notes.push(`${res.groupsWithoutHeader.toLocaleString('en-US')} pick groups have no bundle header line (older sales) and are left out.`);
  if (res.equalSplitGroups > 0) out.notes.push(`${res.equalSplitGroups.toLocaleString('en-US')} bundle sales had no known list price for any pick, so their paid price was split equally.`);
  return out;
}

// ---- definitions ----------------------------------------------------------------------------------------------------

const NONE_DAY_WEEK: DimensionDecl[] = [
  {key: 'none', label: 'Total for the range', shape: 'aggregate'},
  {key: 'day', label: 'By day (Philippine time)', shape: 'series'},
  {key: 'week', label: 'By week (Monday start)', shape: 'series'},
];
const NONE_ONLY: DimensionDecl[] = [{key: 'none', label: 'Ranked list', shape: 'category'}];

const REVENUE: MeasureDecl = {key: 'revenue', label: 'Revenue', kind: 'measured', unit: 'PHP', method: 'Sum of order totals, completed (not voided) orders only'};
const ORDERS: MeasureDecl = {key: 'orders', label: 'Orders', kind: 'measured', unit: 'count', method: 'Number of completed (not voided) orders'};
const AOV: MeasureDecl = {key: 'aov', label: 'Average order value', kind: 'derived', unit: 'PHP', method: 'Revenue divided by number of orders, derived; empty when there are no orders'};

/** Stock metrics run through stock-metrics.ts (runMetric branches before any orders work); reaching this means a wiring bug. */
const notAnOrdersMetric = (): ComputeOutput => {
  throw new Error('stock metrics are computed by runStockMetric, never by an orders compute');
};

const DEFS: MetricDef[] = [
  {
    id: 'offline_revenue',
    label: 'Offline revenue',
    description: 'Revenue from offline POS sales (bazaars, events and walk-ins), in total or by day or week.',
    dimensions: NONE_DAY_WEEK,
    measures: [REVENUE],
    defaultMeasure: 'revenue',
    defaultDimension: 'none',
    supportsPet: true, supportsEvent: true, supportsCompare: true,
    profile: {job: 'trend', headlineColumns: ['revenue'], shareBasis: null},
    compute: (ctx) => computeTotals(ctx, 'revenue'),
  },
  {
    id: 'offline_orders',
    label: 'Offline orders',
    description: 'Number of offline POS orders, in total or by day or week.',
    dimensions: NONE_DAY_WEEK,
    measures: [ORDERS],
    defaultMeasure: 'orders',
    defaultDimension: 'none',
    supportsPet: true, supportsEvent: true, supportsCompare: true,
    profile: {job: 'trend', headlineColumns: ['orders'], shareBasis: null},
    compute: (ctx) => computeTotals(ctx, 'orders'),
  },
  {
    id: 'offline_aov',
    label: 'Offline average order value',
    description: 'Average spend per offline POS order, in total or by day or week.',
    dimensions: NONE_DAY_WEEK,
    measures: [AOV],
    defaultMeasure: 'aov',
    defaultDimension: 'none',
    supportsPet: true, supportsEvent: true, supportsCompare: true,
    profile: {job: 'trend', headlineColumns: ['aov', 'orders', 'revenue'], shareBasis: null},
    compute: (ctx) => computeTotals(ctx, 'aov'),
  },
  {
    id: 'top_products',
    label: 'Top products',
    description: 'Products ranked by itemized revenue or units sold (bundle picks count as units with no revenue).',
    dimensions: NONE_ONLY,
    measures: [
      {...REVENUE, label: 'Itemized revenue', method: 'Sum of product line totals on completed orders; bundle pick lines carry ₱0, so bundle money is not in this figure'},
      {key: 'units', label: 'Units', kind: 'measured', unit: 'units', method: 'Sum of quantities on product lines, including units picked inside bundles'},
    ],
    defaultMeasure: 'revenue',
    defaultDimension: 'none',
    supportsPet: true, supportsEvent: true, supportsCompare: true,
    profile: {job: 'compare', headlineColumns: ['revenue', 'units'], shareBasis: 'all itemized revenue'},
    compute: computeTopProducts,
  },
  {
    id: 'payment_mix',
    label: 'Payment mix',
    description: 'How sales split across payment methods (cash, GCash and so on).',
    dimensions: NONE_ONLY,
    measures: [REVENUE, ORDERS],
    defaultMeasure: 'revenue',
    defaultDimension: 'none',
    supportsPet: true, supportsEvent: true, supportsCompare: true,
    profile: {job: 'composition', headlineColumns: ['value', 'share'], shareBasis: 'all revenue'},
    compute: computePaymentMix,
  },
  {
    id: 'event_rollup',
    label: 'Event rollup',
    description: 'Sales per event (bazaar, market) that had orders in the range; walk-in sales are excluded. Each row also splits its orders: tagged_orders (explicit POS event tag) and date_orders (untagged sales attributed by the event dates); they add up to orders.',
    dimensions: NONE_ONLY,
    measures: [REVENUE, ORDERS],
    defaultMeasure: 'revenue',
    defaultDimension: 'none',
    supportsPet: true, supportsEvent: true, supportsCompare: true,
    profile: {job: 'compare', headlineColumns: ['revenue', 'orders'], shareBasis: 'event revenue'},
    compute: computeEventRollup,
  },
  {
    id: 'pet_mix',
    label: 'Pet mix',
    description: 'How sales split by the pet each sale was tagged for (dog, cat, both, untagged).',
    dimensions: [{key: 'none', label: 'Dog, cat, both, untagged', shape: 'category'}],
    measures: [REVENUE, ORDERS],
    defaultMeasure: 'revenue',
    defaultDimension: 'none',
    supportsPet: false, supportsEvent: true, supportsCompare: true,
    profile: {job: 'composition', headlineColumns: ['value', 'share'], shareBasis: 'tagged revenue'},
    compute: computePetMix,
  },
  {
    id: 'bundle_sales',
    label: 'Bundle sales',
    description: 'Bundle deal revenue and orders: in total, by pet, by bundle, or by bundle and pet.',
    dimensions: [
      {key: 'none', label: 'One summary row', shape: 'aggregate'},
      {key: 'pet_type', label: 'By pet', shape: 'category'},
      {key: 'bundle', label: 'By bundle', shape: 'category'},
      {key: 'bundle_by_pet', label: 'By bundle and pet', shape: 'matrix'},
    ],
    measures: [
      {key: 'revenue', label: 'Bundle revenue', kind: 'measured', unit: 'PHP', method: 'Order total minus its product lines, on completed orders; this is the bundle price the customer paid'},
      {key: 'orders', label: 'Bundle orders', kind: 'measured', unit: 'count', method: 'Number of completed orders that carry a bundle deal'},
    ],
    defaultMeasure: 'revenue',
    defaultDimension: 'none',
    supportsPet: true, supportsEvent: true, supportsCompare: true,
    profile: {job: 'composition', headlineColumns: ['bundle_revenue', 'dog_share', 'cat_share'], shareBasis: 'tagged bundle revenue'},
    compute: computeBundleSales,
  },
  {
    id: 'bundle_picks',
    label: 'Bundle picks',
    description: 'What customers picked inside bundles, per SKU: allocated pesos, list value and units.',
    dimensions: [
      {key: 'sku', label: 'By SKU', shape: 'category'},
      {key: 'sku_by_pet', label: 'By SKU and pet', shape: 'matrix'},
      {key: 'bundle_by_sku', label: 'By bundle and SKU', shape: 'matrix'},
    ],
    measures: [
      {key: 'revenue', label: 'Allocated revenue', kind: 'allocated', unit: 'PHP', method: "Each bundle's paid price is split across its picks in proportion to each pick's list price on the day it sold (an allocation, not a receipt)"},
      {key: 'list_value', label: 'List value', kind: 'derived', unit: 'PHP', method: 'The picks valued at their list price on the day they sold'},
      {key: 'units', label: 'Units', kind: 'measured', unit: 'units', method: 'Sum of pick quantities on completed bundle sales'},
    ],
    defaultMeasure: 'revenue',
    defaultDimension: 'sku',
    supportsPet: true, supportsEvent: true, supportsCompare: true,
    profile: {job: 'detail', headlineColumns: ['value', 'share'], shareBasis: 'allocated bundle revenue'},
    compute: computeBundlePicks,
  },
  {
    id: 'stock_on_hand',
    label: 'Stock on hand',
    description: 'Units on hand per product, as of now (no date range). Default basis: Event (sellable) stock; also office, all locations, or per location.',
    dimensions: [
      {key: 'sellable', label: 'Per product, Event (sellable) stock', shape: 'category'},
      {key: 'office', label: 'Per product, Office (back) stock', shape: 'category'},
      {key: 'all_locations', label: 'Per product, all locations', shape: 'category'},
      {key: 'by_location', label: 'Per product and location', shape: 'matrix'},
    ],
    measures: [{key: 'units', label: 'Stock', kind: 'measured', unit: 'units', method: 'Units on hand in the stock lots, per location, as of now'}],
    defaultMeasure: 'units',
    defaultDimension: 'sellable',
    supportsPet: false, supportsEvent: false, supportsCompare: false,
    profile: {job: 'compare', headlineColumns: ['stock_units'], shareBasis: null},
    compute: notAnOrdersMetric,
  },
  {
    id: 'stock_cover',
    label: 'Stock cover',
    description: 'How many selling days the Event (sellable) stock lasts per product, with status (out, low, healthy): the Inventory page forecast, as of now.',
    dimensions: [{key: 'sku', label: 'Per product', shape: 'category'}],
    measures: [{key: 'cover', label: 'Cover (selling days)', kind: 'derived', unit: 'ratio', method: 'Event stock divided by units sold per selling day over the last 60 days (the Inventory forecast), as of now'}],
    defaultMeasure: 'cover',
    defaultDimension: 'sku',
    supportsPet: false, supportsEvent: false, supportsCompare: false,
    profile: {job: 'detail', headlineColumns: ['cover_days', 'stock_units'], shareBasis: null},
    compute: notAnOrdersMetric,
  },
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export const METRIC_IDS: readonly MetricId[] = Object.freeze(DEFS.map((d) => d.id));

export const METRICS: Readonly<Record<MetricId, MetricDef>> = deepFreeze(
  Object.fromEntries(DEFS.map((d) => [d.id, d])) as Record<MetricId, MetricDef>,
);

