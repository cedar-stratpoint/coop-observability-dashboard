import type {PosEvent, PosOrder} from '../pos-sales-types';
import {manilaDayKey, resolveOrderEvents} from '../pos-sales-compute';
import {buildPriceHistory} from '../pos-price-history';
import {isCompletedOrder} from './order-status';
import {resolveRange} from './range';
import {METRICS, METRIC_IDS, type ComputeOutput} from './metrics-registry';
import {isStockMetric, runStockMetric} from './stock-metrics';
import {runChecks} from './checks';
import {buildInsights} from './insights';
import type {Check, ChecksInput, Coverage, Insight, MetricData, MetricError, MetricId, MetricRequest, MetricResult, MetricRow, ResultColumn} from './result-types';

// The pure executor behind the `query_metric` tool (design 4, 4c). No I/O, no clock, no console: the
// data and `now` are injected. The model never types a number: nothing user-supplied except enums
// and the two dates reaches the output. Every rejection says what was wrong and what is allowed.

const REQUEST_KEYS = ['metric', 'dimension', 'measure', 'range', 'from', 'to', 'channel', 'event', 'pet', 'compare_to', 'sort', 'limit'] as const;
const RANGES = ['last_week', 'this_week', 'last_month', 'all_available', 'custom'] as const;
const CHANNELS = ['offline', 'all'] as const;
const PETS = ['all', 'dog', 'cat', 'both', 'untagged'] as const;
const COMPARES = ['none', 'previous_period'] as const;
const SORTS = ['default', 'value_desc', 'value_asc'] as const;
const LIMITS = [3, 5, 10, 25] as const;

const list = (xs: readonly (string | number)[]): string => xs.map(String).join(', ');
/** Echo a model-sent value in an error, bounded, so a long string never floods the result. */
const show = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
  return s.length > 40 ? `${s.slice(0, 40)}...` : s;
};
const fail = (error: string): MetricError => ({error});

// ---- validation -----------------------------------------------------------------------------------------------------

function validate(input: unknown, data: MetricData): MetricRequest | MetricError {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail(`The request must be an object with exactly these keys: ${list(REQUEST_KEYS)}.`);
  }
  const o = input as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !(REQUEST_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    return fail(`Unknown key(s): ${unknown.map(show).join(', ')}. Allowed keys: ${list(REQUEST_KEYS)}. There are no free-form filters, where clauses or sql; pick a metric and its declared dimension and measure.`);
  }
  const missing = REQUEST_KEYS.filter((k) => !(k in o) || o[k] === undefined);
  if (missing.length > 0) return fail(`Missing required field(s): ${list(missing)}. Every field is required. Allowed keys: ${list(REQUEST_KEYS)}.`);

  const enumError = (key: string, allowed: readonly (string | number)[]): MetricError => fail(`${key} ${show(o[key])} is not allowed. Allowed values for ${key}: ${list(allowed)}.`);
  if (typeof o.metric !== 'string' || !(METRIC_IDS as readonly string[]).includes(o.metric)) return enumError('metric', METRIC_IDS);
  const metric = o.metric as MetricId;
  const def = METRICS[metric];

  const dims = def.dimensions.map((d) => d.key);
  if (o.dimension === 'default') return fail(`dimension 'default' is not allowed; use 'none' for no breakdown. Dimensions for ${metric}: ${list(dims)}.`);
  if (typeof o.dimension !== 'string' || !dims.includes(o.dimension)) {
    return fail(`dimension ${show(o.dimension)} is not allowed for ${metric}. Allowed dimensions for ${metric}: ${list(dims)}.`);
  }

  const declared = def.measures.map((m) => m.key);
  if (typeof o.measure !== 'string') return fail(`measure must be a string: 'default' or one of ${list(declared)}.`);
  if (o.measure !== 'default' && !declared.includes(o.measure)) {
    const owners = METRIC_IDS.filter((id) => METRICS[id].measures.some((m) => m.key === o.measure));
    if (owners.length > 0) {
      return fail(`'${show(o.measure)}' is not declared by ${metric}; metrics that declare it: ${list(owners)}. ${metric} declares: ${list(declared)}.`);
    }
    const all = [...new Set(METRIC_IDS.flatMap((id) => METRICS[id].measures.map((m) => m.key)))];
    return fail(`No metric declares the measure '${show(o.measure)}'. Declared measures: ${list(all)}.`);
  }

  if (typeof o.range !== 'string' || !(RANGES as readonly string[]).includes(o.range)) return enumError('range', RANGES);
  if (typeof o.from !== 'string') return fail("from must be a string: a YYYY-MM-DD date for range 'custom', otherwise ''.");
  if (typeof o.to !== 'string') return fail("to must be a string: a YYYY-MM-DD date for range 'custom', otherwise ''.");
  if (typeof o.channel !== 'string' || !(CHANNELS as readonly string[]).includes(o.channel)) return enumError('channel', CHANNELS);
  if (typeof o.event !== 'string' || o.event.trim() === '') return fail("event must be 'all' or the name or id of a known event (not empty).");
  if (typeof o.pet !== 'string' || !(PETS as readonly string[]).includes(o.pet)) return enumError('pet', PETS);
  if (typeof o.compare_to !== 'string' || !(COMPARES as readonly string[]).includes(o.compare_to)) return enumError('compare_to', COMPARES);
  if (typeof o.sort !== 'string' || !(SORTS as readonly string[]).includes(o.sort)) return enumError('sort', SORTS);
  if (typeof o.limit !== 'number' || !(LIMITS as readonly number[]).includes(o.limit)) return enumError('limit', LIMITS);

  if (o.pet !== 'all' && !def.supportsPet) {
    const ok = METRIC_IDS.filter((id) => METRICS[id].supportsPet);
    return fail(`The pet filter is not supported by ${metric}; metrics that support it: ${list(ok)}. Use pet 'all'.`);
  }
  if (o.event !== 'all' && !def.supportsEvent) {
    const ok = METRIC_IDS.filter((id) => METRICS[id].supportsEvent);
    return fail(`The event filter is not supported by ${metric}; metrics that support it: ${list(ok)}. Use event 'all'.`);
  }
  if (o.event !== 'all' && matchEvents(data.events, o.event).length === 0) {
    const names = [...new Set(data.events.map((e) => e.name).filter((n): n is string => !!n))];
    return fail(`Unknown event ${show(o.event)}. ${names.length > 0 ? `Known events: ${list(names)}.` : 'No events are recorded yet.'} Use 'all' for no event filter.`);
  }
  if (o.compare_to === 'previous_period') {
    const shape = def.dimensions.find((d) => d.key === o.dimension)?.shape;
    if (!def.supportsCompare || shape === 'series' || shape === 'matrix') {
      const ok = def.supportsCompare ? def.dimensions.filter((d) => d.shape === 'aggregate' || d.shape === 'category').map((d) => d.key) : [];
      return fail(`compare_to 'previous_period' is not available for ${metric} by '${o.dimension}'${shape ? ` (a ${shape})` : ''}; it works on totals and category breakdowns, not day/week series or matrices.${ok.length > 0 ? ` Dimensions of ${metric} that can be compared: ${list(ok)}.` : ''} Use compare_to 'none'.`);
    }
  }
  return {
    metric, dimension: o.dimension, measure: o.measure, range: o.range as MetricRequest['range'], from: o.from, to: o.to,
    channel: o.channel as MetricRequest['channel'], event: o.event, pet: o.pet as MetricRequest['pet'],
    compare_to: o.compare_to as MetricRequest['compare_to'], sort: o.sort as MetricRequest['sort'], limit: o.limit as MetricRequest['limit'],
  };
}

/** Events whose id or name equals the text (case-insensitive, trimmed). */
function matchEvents(events: PosEvent[], text: string): PosEvent[] {
  const t = text.trim().toLowerCase();
  return events.filter((e) => e.event_id.toLowerCase() === t || (e.name ?? '').trim().toLowerCase() === t);
}

// ---- helpers --------------------------------------------------------------------------------------------------------

interface DatedOrder {
  order: PosOrder;
  day: string;
}

function coverageOf(from: string, to: string, dataFrom: string | null, dataTo: string | null): {coverage: Coverage; coveredFrom: string | null; coveredTo: string | null} {
  if (!dataFrom || !dataTo || to < dataFrom || from > dataTo) return {coverage: 'none', coveredFrom: null, coveredTo: null};
  const coveredFrom = from > dataFrom ? from : dataFrom;
  const coveredTo = to < dataTo ? to : dataTo;
  return {coverage: from >= dataFrom && to <= dataTo ? 'full' : 'partial', coveredFrom, coveredTo};
}

function sortRows(rows: MetricRow[], key: string, dir: 'value_desc' | 'value_asc'): MetricRow[] {
  const sign = dir === 'value_desc' ? -1 : 1;
  return rows
    .map((row, i) => ({row, i}))
    .sort((a, b) => {
      const x = a.row[key];
      const y = b.row[key];
      const nx = typeof x === 'number';
      const ny = typeof y === 'number';
      if (nx && ny) return (((x as number) - (y as number)) * sign) || a.i - b.i;
      if (nx !== ny) return nx ? -1 : 1; // nulls last
      return a.i - b.i;
    })
    .map((x) => x.row);
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pct1 = (n: number): number => Math.round(n * 10) / 10;

/** Add previous_<measure>, delta and delta_pct. Null (never 0) when the previous period has no orders. */
function applyCompare(cur: ComputeOutput, prev: ComputeOutput, measure: string, prevHasOrders: boolean): {columns: ResultColumn[]; rows: MetricRow[]} {
  const cmp = cur.compare as NonNullable<ComputeOutput['compare']>;
  const unit = cur.columns.find((c) => c.key === cmp.valueColumn)?.unit ?? 'count';
  const prevByKey = new Map<string, number | null>();
  for (const r of prev.rows) prevByKey.set(cmp.keyColumn === null ? '' : String(r[cmp.keyColumn]), numOrNull(r[cmp.valueColumn]));
  const rows = cur.rows.map((row) => {
    const now = numOrNull(row[cmp.valueColumn]);
    let before: number | null = null;
    if (prevHasOrders) before = prevByKey.get(cmp.keyColumn === null ? '' : String(row[cmp.keyColumn])) ?? (cmp.keyColumn === null ? null : 0);
    const delta = now !== null && before !== null ? Math.round((now - before) * 100) / 100 : null;
    const deltaPct = delta !== null && before !== null && before > 0 ? pct1((delta / before) * 100) : null;
    return {...row, [`previous_${measure}`]: before, delta, delta_pct: deltaPct};
  });
  const columns: ResultColumn[] = [
    ...cur.columns,
    {key: `previous_${measure}`, label: `Previous ${measure.replace('_', ' ')}`, unit, role: 'measure'},
    {key: 'delta', label: 'Change', unit, role: 'delta'},
    {key: 'delta_pct', label: 'Change (%)', unit: 'percent', role: 'delta'},
  ];
  return {columns, rows};
}

/** Insights from each set (with the previous period's items when comparing), duplicates dropped. */
const insightsOf = (out: ComputeOutput, prev: ComputeOutput | null): Insight[] =>
  out.insights
    .flatMap((set, i) => {
      const built = buildInsights({...set.input, previous: prev?.insights[i]?.input.items ?? null});
      return set.codes ? built.filter((x) => set.codes?.includes(x.code)) : built;
    })
    .filter((x, i, all) => all.findIndex((y) => y.text === x.text) === i);

// ---- the executor ---------------------------------------------------------------------------------------------------

export function runMetric(input: unknown, data: MetricData, now: Date): MetricResult | MetricError {
  const req = validate(input, data);
  if ('error' in req) return req;
  if (isStockMetric(req.metric)) return runStockMetric(req, data, now); // "as of now": no orders, range or checks
  const def = METRICS[req.metric];
  const measure = req.measure === 'default' ? def.defaultMeasure : req.measure;

  // Completed orders only (every status but voided, the dashboard rule, see order-status.ts), with the event each order effectively belongs to.
  const completed = data.orders.filter(isCompletedOrder);
  const taggedIds = new Set(completed.filter((o) => o.event_id !== null).map((o) => o.id)); // explicit POS tag, before date attribution
  const resolved = resolveOrderEvents(completed, data.events);
  const dated: DatedOrder[] = [];
  for (const order of resolved) {
    if (Number.isNaN(Date.parse(order.created_at))) continue;
    dated.push({order, day: manilaDayKey(order.created_at)});
  }
  let dataFrom: string | null = null;
  let dataTo: string | null = null;
  for (const {day} of dated) {
    if (dataFrom === null || day < dataFrom) dataFrom = day;
    if (dataTo === null || day > dataTo) dataTo = day;
  }

  const range = resolveRange(req, now, {dataFrom, dataTo});
  if (!range.ok) return fail(range.error);

  const eventIds = req.event === 'all' ? null : new Set(matchEvents(data.events, req.event).map((e) => e.event_id));
  const eventNames = req.event === 'all' ? [] : matchEvents(data.events, req.event).map((e) => e.name ?? e.event_id);
  const slice = (from: string, to: string): PosOrder[] =>
    dated
      .filter(({day}) => day >= from && day <= to)
      .filter(({order}) => eventIds === null || (order.event_id !== null && eventIds.has(order.event_id)))
      .filter(({order}) => req.pet === 'all' || (req.pet === 'untagged' ? order.pet_type === null : order.pet_type === req.pet))
      .map((x) => x.order);

  const history = buildPriceHistory(data.prices, data.priceChanges);
  const cov = coverageOf(range.from, range.to, dataFrom, dataTo);
  const orders = slice(range.from, range.to);
  const base = {events: data.events, history, dimension: req.dimension, measure};
  const ctx = {...base, orders, range: {from: range.from, to: range.to, label: range.label}, covered: {from: cov.coveredFrom, to: cov.coveredTo}, taggedIds};
  const out = def.compute(ctx);

  const caveats: string[] = [...out.notes];
  const dim = def.dimensions.find((d) => d.key === req.dimension);
  if (req.channel === 'all') caveats.unshift('Only the offline POS is connected; online and marketplace channels are not included.');
  if (eventNames.length > 0) caveats.push(`Filtered to ${eventNames.length === 1 ? 'event' : 'events'}: ${eventNames.join(', ')}.`);
  if (eventIds !== null || req.metric === 'event_rollup') {
    const inEvent = orders.filter((o) => o.event_id !== null);
    const tagged = inEvent.filter((o) => taggedIds.has(o.id)).length;
    const byDate = inEvent.length - tagged;
    const parts = [`${tagged.toLocaleString('en-US')} tagged to the event${eventIds === null ? 's' : ''} in the POS`];
    if (byDate > 0) parts.push(`${byDate.toLocaleString('en-US')} untagged ${byDate === 1 ? 'sale' : 'sales'} on the event dates (attributed by date)`);
    // With every event in play these are combined figures: never a claim about one event. Each event's own split is in its row.
    caveats.push(
      eventIds === null
        ? `All events combined: ${parts.join(' plus ')}; ${inEvent.length.toLocaleString('en-US')} total. The split per event is in the rows (tagged_orders, date_orders); do not apply these combined counts to a single event.`
        : `Event orders = ${parts.join(' plus ')}; ${inEvent.length.toLocaleString('en-US')} total.`,
    );
  }
  if (req.pet !== 'all') caveats.push(`Filtered to orders tagged ${req.pet}.`);

  // compare_to: the same metric over the period of equal length just before.
  let columns = out.columns;
  let rows = out.rows;
  let prevOut: ComputeOutput | null = null;
  let change: ChecksInput['change'] = null;
  if (req.compare_to === 'previous_period' && out.compare) {
    const prevOrders = slice(range.previous.from, range.previous.to);
    const prevCov = coverageOf(range.previous.from, range.previous.to, dataFrom, dataTo);
    prevOut = def.compute({...ctx, orders: prevOrders, range: {from: range.previous.from, to: range.previous.to, label: ''}, covered: {from: prevCov.coveredFrom, to: prevCov.coveredTo}});
    const merged = applyCompare(out, prevOut, measure, prevOrders.length > 0);
    columns = merged.columns;
    rows = merged.rows;
    if (prevOrders.length === 0) {
      caveats.push(`The previous period (${range.previous.from} to ${range.previous.to}) has no orders${prevCov.coverage === 'none' ? ' and is outside the data' : ''}, so the previous value, change and percent change are empty (null), not zero.`);
    } else if (prevCov.coverage === 'partial') {
      caveats.push(`The previous period (${range.previous.from} to ${range.previous.to}) is only partly covered by data (data starts ${dataFrom}), so the comparison may understate it.`);
    }
    if (measure === 'orders' && out.compare.keyColumn === null && prevOrders.length > 0) {
      change = {previous: prevOrders.length, current: orders.length};
    }
  }

  // Sort and limit apply to category rows after every share was computed over ALL rows.
  const sortable = dim?.shape !== 'aggregate' && out.sortKey !== null;
  if (sortable) {
    const dir = req.sort === 'default' ? (out.defaultSort === 'value_desc' ? 'value_desc' : null) : req.sort;
    if (dir) rows = sortRows(rows, out.sortKey as string, dir);
  }
  if (out.limitable && rows.length > req.limit) {
    caveats.push(`Showing ${req.sort === 'value_asc' ? 'the lowest' : 'the first'} ${req.limit} of ${rows.length} rows; shares are of all ${rows.length}.`);
    rows = rows.slice(0, req.limit);
  }

  const checks: Check[] = runChecks({
    mockSource: data.source === 'mock',
    bulkReads: data.bulkReads,
    reconcile: out.reconcile,
    zeroValueLines: out.zeroValueLines,
    priceChanges: out.priceChanges,
    sampleSize: orders.length,
    untagged: out.untagged,
    coverage: {from: range.from, to: range.to, dataFrom, dataTo},
    change,
  });
  for (const c of checks) if ((c.status === 'warn' || c.status === 'fail') && !caveats.includes(c.text)) caveats.push(c.text);

  return {
    id: '',
    metric: req.metric,
    dimension: req.dimension,
    columns,
    rows,
    meta: {
      source: data.source,
      range: {from: range.from, to: range.to, label: range.label},
      dataFrom,
      dataTo,
      rowCount: rows.length,
      coverage: cov.coverage,
      coveredFrom: cov.coveredFrom,
      coveredTo: cov.coveredTo,
      caveats,
      share_basis: out.shareBasis,
      measure,
      measures: def.measures.map((m) => ({...m})),
      insights: insightsOf(out, prevOut),
      checks,
      reliable: !checks.some((c) => c.status === 'fail'),
    },
  };
}

