// get_digest window "all": one product on Shopee and Lazada across every stored digest. Pure: rows are injected.
// A digest keeps only its own top 5 products per channel, so what is summed here is a LOWER BOUND (windows where the product
// was not in the top 5 add nothing). The result says so; the model must not present it as a complete total.
import {firstDigestDay} from '../sales-range';
import {spanTopProducts, type MarketChannel} from '../span-windows';
import type {DigestRow} from './read/digest';
import {rangeLabel} from './range';
import type {Check, MeasureDecl, MetricError, MetricResult, MetricRow, ResultColumn} from './result-types';

const col = (key: string, label: string, unit: ResultColumn['unit'], role: ResultColumn['role']): ResultColumn => ({key, label, unit, role});
const COLUMNS = [col('channel', 'Channel', 'text', 'category'), col('product', 'Product', 'text', 'category'), col('revenue', 'Revenue (at least)', 'PHP', 'measure'), col('units', 'Units (at least)', 'units', 'measure')];
const MEASURE: MeasureDecl = {
  key: 'revenue',
  label: 'Revenue and units seen in stored top-5 lists',
  kind: 'measured',
  unit: 'PHP',
  method: 'Summed from the top-5 product list of each stored digest window (overlapping windows never added twice). A window where the product was not in the top 5 adds nothing, so these are lower bounds, not totals.',
};
const LABEL: Record<MarketChannel, string> = {shopee: 'Shopee', lazada: 'Lazada'};

export function shapeProductHistory(input: unknown, rows: readonly DigestRow[], todayDay: string, mock: boolean): {result: MetricResult} | MetricError {
  const q = (input as {product?: unknown} | null)?.product;
  const needle = typeof q === 'string' ? q.trim().toLowerCase() : '';
  if (!needle) return {error: 'window "all" needs the product the owner named in "product" (as they typed it). Ask them which product if they gave none.'};
  const first = firstDigestDay(rows);
  if (!first) return {error: 'No stored digest is available right now. Say so plainly.'};

  const out: MetricRow[] = [];
  const checks: Check[] = [];
  let windows = 0;
  for (const channel of ['shopee', 'lazada'] as const) {
    const span = spanTopProducts(channel, '2000-01-01', todayDay, rows, 10_000);
    windows = Math.max(windows, span.windows.length);
    const hits = span.products.filter((p) => p.title.toLowerCase().includes(needle));
    for (const p of hits) out.push({channel: LABEL[channel], product: p.title, revenue: p.revenue, units: p.units});
    if (hits.length > 1) out.push({channel: LABEL[channel], product: 'All matching products together', revenue: Math.round(hits.reduce((s, p) => s + p.revenue * 100, 0)) / 100, units: hits.reduce((s, p) => s + p.units, 0)});
    checks.push({code: 'partial_coverage', status: hits.length ? 'info' : 'warn', text: hits.length ? `${LABEL[channel]}: seen in the top-5 list of the stored windows (${span.windows.length} windows used).` : `${LABEL[channel]}: not in the top-5 list of any of the ${span.windows.length} stored windows used, so no figure (it may still have sold below the top 5).`});
    checks.push(...span.warnings.slice(0, 3).map((text): Check => ({code: 'partial_coverage', status: 'warn', text})));
  }
  checks.unshift({code: 'partial_coverage', status: 'warn', text: `LOWER BOUND, not a total: each stored digest publishes only its own top 5 products per channel, so a window where this product ranked 6th or lower adds nothing. Say "at least" with every figure and name the ${rangeLabel(first, todayDay)} span and how many windows were used. Never present it as the all-time total.`});
  if (mock) checks.push({code: 'mock_source', status: 'warn', text: 'These are built-in sample digests, not real figures.'});
  return {
    result: {
      id: '',
      metric: 'digest',
      dimension: 'products',
      columns: COLUMNS,
      rows: out,
      meta: {source: mock ? 'mock' : 'digest', range: {from: first, to: todayDay, label: rangeLabel(first, todayDay)}, dataFrom: first, dataTo: todayDay, rowCount: out.length, coverage: 'partial', coveredFrom: first, coveredTo: todayDay, caveats: checks.map((c) => c.text), share_basis: null, measure: MEASURE.key, measures: [MEASURE], insights: [], checks, reliable: true},
    },
  };
}
