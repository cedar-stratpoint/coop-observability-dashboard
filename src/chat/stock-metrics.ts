// The registry stock metrics (spec F.3, Train 3 Task 8): stock_on_hand and stock_cover. Pure. Stock is "as of now", so no date range,
// event or pet filter applies; the result says its basis. stock_cover reuses the Inventory page's forecast engine (computeForecast).
import {computeForecast, type ForecastStatus} from '../pos-forecast-compute';
import {DEFAULT_EXPIRY_WINDOW_DAYS} from '../boxme-inventory-compute';
import {onlineStock, SPEED_BASIS} from './boxme-metrics';
import {METRICS} from './metrics-registry';
import type {MetricData, MetricError, MetricRequest, MetricResult, MetricRow, ResultColumn} from './result-types';

export const STOCK_METRIC_IDS = ['stock_on_hand', 'stock_cover'] as const;
export const isStockMetric = (id: string): boolean => (STOCK_METRIC_IDS as readonly string[]).includes(id);

const BASIS: Record<string, string> = {
  sellable: 'Event (sellable) stock',
  office: 'Office (back) stock',
  all_locations: 'All locations (event + office)',
  by_location: 'Stock per location',
  sku: 'Event (sellable) stock with the Inventory forecast (last 60 days of sales)',
};
const STATUS_RANK: Record<ForecastStatus, number> = {out: 0, low: 1, healthy: 2};
const r2 = (n: number): number => Math.round(n * 100) / 100;
const PRODUCT: ResultColumn = {key: 'product', label: 'Product', unit: 'text', role: 'category'};
/** "2026-09-28 12:00 PHT": the caveat clock is Philippine time, like every date the owner sees. */
const phtStamp = (iso: string): string => `${new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')} PHT`;

const UNITS: ResultColumn = {key: 'stock_units', label: 'Stock', unit: 'units', role: 'measure'};

/** B3: dimensions answered from the BoxMe (online warehouse) feed. */
const ONLINE_DIMENSIONS = new Set(['online', 'all_channels', 'expiring_online']);

export function runStockMetric(req: MetricRequest, data: MetricData, now: Date): MetricResult | MetricError {
  if (ONLINE_DIMENSIONS.has(req.dimension)) return runOnlineStock(req, data, now);
  const s = data.stock;
  if (!s) return {error: 'Stock data is not available right now. Say so, and point to the Inventory page.'};
  const label = (id: string): string => `${s.names[id] ?? id} (${id})`;
  const ids = [...new Set(s.byLocation.map((r) => r.product_id))].sort();
  const at = (loc: string): Map<string, number> => new Map(s.byLocation.filter((r) => r.location === loc).map((r) => [r.product_id, r.stock]));
  let columns: ResultColumn[];
  let rows: MetricRow[];
  if (req.metric === 'stock_cover') {
    const event = at('event');
    const products = ids.map((id) => ({product_id: id, name: label(id), product_line: null, category: null, subcategory: null, emoji: null, stock: event.get(id) ?? 0}));
    const f = computeForecast(products, s.sales, now, s.config).rows
      .slice()
      .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || (a.coverEventDays ?? Infinity) - (b.coverEventDays ?? Infinity) || a.name.localeCompare(b.name));
    columns = [PRODUCT, {key: 'status', label: 'Status', unit: 'text', role: 'category'}, UNITS, {key: 'sold_per_day_units', label: 'Sold per selling day', unit: 'units', role: 'measure'}, {key: 'cover_days', label: 'Cover (selling days)', unit: 'ratio', role: 'measure'}];
    rows = f.map((x) => ({product: x.name, status: x.status, stock_units: x.stock, sold_per_day_units: r2(x.soldPerEventDay), cover_days: x.coverEventDays === null ? null : r2(x.coverEventDays)}));
  } else if (req.dimension === 'by_location') {
    columns = [PRODUCT, {key: 'location', label: 'Location', unit: 'text', role: 'category'}, UNITS];
    rows = s.byLocation.map((r) => ({product: label(r.product_id), location: r.location, stock_units: r.stock}));
  } else {
    const pick = req.dimension === 'office' ? at('office') : req.dimension === 'sellable' ? at('event') : null;
    columns = [PRODUCT, UNITS];
    rows = ids.map((id) => ({
      product: label(id),
      stock_units: pick ? pick.get(id) ?? 0 : s.byLocation.filter((r) => r.product_id === id).reduce((n, r) => n + r.stock, 0),
    }));
    rows.sort((a, b) => (req.sort === 'value_asc' ? 1 : -1) * (Number(a.stock_units) - Number(b.stock_units)) || String(a.product).localeCompare(String(b.product)));
  }
  const caveats = [`Basis: ${BASIS[req.dimension] ?? BASIS.sellable}, as of now (${phtStamp(s.asOf)}); stock has no date range.`];
  return finish(req, data, now, columns, rows, caveats);
}

/** Shared tail: the row limit, then the "as of now" result shape. */
function finish(req: MetricRequest, data: MetricData, now: Date, columns: ResultColumn[], rows: MetricRow[], caveats: string[]): MetricResult {
  if (rows.length > req.limit) {
    caveats.push(`Showing the first ${req.limit} of ${rows.length} rows.`);
    rows = rows.slice(0, req.limit);
  }
  const def = METRICS[req.metric];
  const today = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  return {
    id: '',
    metric: req.metric,
    dimension: req.dimension,
    columns,
    rows,
    meta: {
      source: data.source, range: {from: today, to: today, label: 'as of now'}, dataFrom: null, dataTo: null, rowCount: rows.length,
      coverage: 'full', coveredFrom: today, coveredTo: today, caveats, share_basis: null,
      measure: req.measure === 'default' ? def.defaultMeasure : req.measure, measures: def.measures.map((m) => ({...m})),
      insights: [], checks: [], reliable: true,
    },
  };
}

const col = (key: string, label: string, unit: ResultColumn['unit'], role: ResultColumn['role'] = 'measure'): ResultColumn => ({key, label, unit, role});

/**
 * B3: BoxMe stock through the Inventory page's own compute (boxme-metrics.ts). Online: available per product. All channels: Event,
 * Office, BoxMe available and their total per product, plus the products only one side stocks. Expiring: BoxMe lots inside each
 * product's expiry window. Cover (online): status and days left from estimated BoxMe sales speed.
 */
function runOnlineStock(req: MetricRequest, data: MetricData, now: Date): MetricResult | MetricError {
  const view = onlineStock(data, now);
  if ('error' in view) return {error: `${view.error} Say so. Offline (POS) stock is still available: use dimension sellable, office or all_locations.`};
  const {result} = view;
  const caveats = [...view.warnings];
  let columns: ResultColumn[];
  let rows: MetricRow[];
  const dir = req.sort === 'value_asc' ? 1 : -1;
  if (req.metric === 'stock_cover') {
    columns = [PRODUCT, {key: 'status', label: 'Status', unit: 'text', role: 'category'}, col('stock_units', 'BoxMe available', 'units'), col('sold_per_day_units', 'Sold per day (estimated)', 'units'), col('cover_days', 'Days left', 'ratio')];
    rows = result.rows
      .slice()
      .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || (a.lastsDays ?? Infinity) - (b.lastsDays ?? Infinity) || a.name.localeCompare(b.name))
      .map((r) => ({product: `${r.name} (${r.sku})`, status: r.status, stock_units: r.available, sold_per_day_units: r.soldPerDay === null ? null : r2(r.soldPerDay), cover_days: r.lastsDays === null ? null : r2(r.lastsDays)}));
    caveats.push(SPEED_BASIS);
  } else if (req.dimension === 'expiring_online') {
    columns = [PRODUCT, {key: 'warehouse', label: 'Warehouse', unit: 'text', role: 'category'}, {key: 'batch', label: 'Batch', unit: 'text', role: 'category'}, {key: 'expires', label: 'Expires', unit: 'date', role: 'time'}, col('days_left', 'Days left', 'count'), col('stock_units', 'Units', 'units')];
    rows = result.expiring.map((l) => ({product: `${l.name} (${l.sku})`, warehouse: l.warehouse_code, batch: l.batch_lot || null, expires: l.date, days_left: l.daysLeft, stock_units: l.quantity}));
    caveats.push(`BoxMe lots that expire within each product's expiry window (${DEFAULT_EXPIRY_WINDOW_DAYS} days unless BoxMe sets one), soonest first.`);
    if (rows.length === 0) caveats.push('No BoxMe lot expires inside its window.');
  } else if (req.dimension === 'online') {
    columns = [PRODUCT, col('stock_units', 'BoxMe available', 'units'), col('reserved_units', 'Reserved', 'units'), col('incoming_units', 'Incoming', 'units')];
    rows = result.rows.map((r) => ({product: `${r.name} (${r.sku})`, stock_units: r.available, reserved_units: r.reserved, incoming_units: r.incoming}));
    rows.sort((a, b) => dir * (Number(a.stock_units) - Number(b.stock_units)) || String(a.product).localeCompare(String(b.product)));
    caveats.push('BoxMe available = sellable online now; reserved units are held for orders and incoming units are not received yet.');
  } else {
    const s = data.stock;
    if (!s) return {error: 'Offline (POS) stock is not available right now, so there is no all-channel total. Say so; BoxMe stock alone is dimension online.'};
    const offline = (id: string, loc: string) => s.byLocation.filter((r) => r.product_id === id && r.location === loc).reduce((n, r) => n + r.stock, 0);
    const online = new Map(result.rows.map((r) => [r.sku, r]));
    const ids = [...new Set([...Object.keys(s.names), ...online.keys()])];
    columns = [PRODUCT, col('event_units', 'Event (sellable)', 'units'), col('office_units', 'Office (back)', 'units'), col('online_units', 'BoxMe available', 'units'), col('stock_units', 'Total', 'units')];
    rows = ids.map((id) => {
      const event = offline(id, 'event');
      const office = offline(id, 'office');
      const onl = online.get(id)?.available ?? 0;
      return {product: `${s.names[id] ?? online.get(id)?.name ?? id} (${id})`, event_units: event, office_units: office, online_units: onl, stock_units: event + office + onl};
    });
    rows.sort((a, b) => dir * (Number(a.stock_units) - Number(b.stock_units)) || String(a.product).localeCompare(String(b.product)));
    caveats.push(`Offline (POS) stock as of now (${phtStamp(s.asOf)}); Total = Event + Office + BoxMe available.`);
    if (result.posOnly.length) caveats.push(`In the POS but not stocked at BoxMe: ${result.posOnly.map((p) => p.name).join(', ')}.`);
    if (result.boxmeOnly.length) caveats.push(`At BoxMe but not in the POS catalog: ${result.boxmeOnly.join(', ')}.`);
  }
  caveats.push(view.basis);
  return finish(req, data, now, columns, rows, caveats);
}
