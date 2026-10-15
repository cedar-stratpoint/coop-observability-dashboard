// The registry stock metrics (spec F.3, Train 3 Task 8): stock_on_hand and stock_cover. Pure. Stock is "as of now", so no date range,
// event or pet filter applies; the result says its basis. stock_cover reuses the Inventory page's forecast engine (computeForecast).
import {computeForecast, type ForecastStatus} from '../pos-forecast-compute';
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

export function runStockMetric(req: MetricRequest, data: MetricData, now: Date): MetricResult | MetricError {
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
  if (rows.length > req.limit) {
    caveats.push(`Showing the first ${req.limit} of ${rows.length} products.`);
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
