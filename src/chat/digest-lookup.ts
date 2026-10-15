// F10: the shaping behind get_digest and lookup_product. Pure: rows and data are injected, nothing is read here.
// Both return a MetricResult (so the render tools can draw it) or a steering {error}. The model never computes a figure:
// digest values are passed through as published (money and percents pre-formatted by label), product figures are counted here.
// Design: knowledge/architecture/2026-10-01-talk-to-data-design.md Slice 5.
import {formatPeso} from '../pos-format';
import {manilaDayKey} from '../pos-sales-compute';
import {isCompletedOrder} from './order-status';
import type {DigestFigure} from '../types';
import {dedupeReruns, nearestWindows, pickCovering, sameWindow, windowDays, windowLabel, windowOf, type CoverPick, type DigestWindow} from '../digest-windows';
import {phtDate} from './coverage';
import {isRealDay, rangeLabel} from './range';
import type {DigestRow} from './read/digest';
import type {Check, MeasureDecl, MetricData, MetricError, MetricResult, MetricRow, ResultColumn} from './result-types';

// ---- shared ---------------------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (items: readonly string[]): string => items.join(', ');
const fail = (error: string): MetricError => ({error});
const dayOf = (iso: string): string => iso.slice(0, 10);
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

const col = (key: string, label: string, unit: ResultColumn['unit'], role: ResultColumn['role']): ResultColumn => ({key, label, unit, role});

// ---- get_digest -----------------------------------------------------------------------------------------------------

export const DIGEST_WINDOWS = ['latest', 'previous', 'covering'] as const;
export const DIGEST_SECTIONS = ['comparison', 'figures', 'sales', 'customers', 'shopee', 'lazada', 'products'] as const;
export type DigestSection = (typeof DIGEST_SECTIONS)[number];
/** A stored digest this old or older (days since its window ended) is flagged as stale. The newest PROD digests are weekly (2026-10-07): a week plus two days of grace. */
export const DIGEST_STALE_DAYS = 9;

export interface DigestSource {
  source: 'live' | 'mock';
  /** The newest DIGEST_ROW_LIMIT digests with their documents, newest first. */
  rows: DigestRow[];
  /** Every stored window (a narrow read), newest first. Absent: the windows of `rows`. */
  index?: DigestWindow[];
  /** Loads one full digest that is not in `rows` (an older one). Absent: only `rows` can be read. */
  rowAt?: (w: DigestWindow) => Promise<DigestRow | null>;
}

const FIGURE_COLUMNS: ResultColumn[] = [
  col('area', 'Area', 'text', 'category'),
  col('figure', 'Figure', 'text', 'category'),
  col('value', 'Value', 'text', 'category'), // pre-formatted: the digest mixes pesos, counts and percents in one list
  col('basis', 'Time basis', 'text', 'category'),
];
const COMPARISON_COLUMNS: ResultColumn[] = [
  col('channel', 'Channel', 'text', 'category'),
  col('revenue', 'Revenue', 'PHP', 'measure'),
  col('orders', 'Orders', 'count', 'measure'),
  col('aov', 'Average order value', 'PHP', 'measure'),
  col('units', 'Units', 'units', 'measure'),
  col('ad_spend', 'Ad spend', 'PHP', 'measure'),
  col('roas', 'ROAS', 'ratio', 'measure'),
];
const PRODUCT_COLUMNS: ResultColumn[] = [
  col('source', 'Channel', 'text', 'category'),
  col('product', 'Product', 'text', 'category'),
  col('revenue', 'Revenue', 'PHP', 'measure'),
  col('units', 'Units', 'units', 'measure'),
];

function formatFigure(f: DigestFigure): string {
  if (/\(PHP\)|₱/i.test(f.label)) return formatPeso(f.value);
  if (/%/.test(f.label)) return `${Math.round(f.value * 100) / 100}%`;
  return f.value.toLocaleString('en-PH', {maximumFractionDigits: 2});
}

function basisOf(f: DigestFigure, facetWindow: string): string {
  if (f.timeBasis === 'allTime') return 'all time';
  if (f.timeBasis === 'recurring') return 'recurring (ongoing)';
  return facetWindow ? `window ${facetWindow}` : 'this digest window';
}

/** Valid figures only; an unusable entry is dropped. `area` names the part of the digest they came from. */
function figureRows(area: string, figures: unknown, facetWindow = ''): MetricRow[] {
  if (!Array.isArray(figures)) return [];
  const out: MetricRow[] = [];
  for (const raw of figures) {
    if (!isRec(raw) || typeof raw.label !== 'string' || num(raw.value) === null) continue;
    const f = {label: raw.label, value: raw.value as number, timeBasis: raw.timeBasis === 'allTime' || raw.timeBasis === 'recurring' ? raw.timeBasis : 'window'} as DigestFigure;
    out.push({area, figure: f.label, value: formatFigure(f), basis: basisOf(f, facetWindow)});
  }
  return out;
}

const FACETS: Record<'shopee' | 'lazada', readonly string[]> = {shopee: ['sales', 'ads', 'traffic', 'products'], lazada: ['sales', 'finance', 'inventory', 'ads']};

function facetRows(channel: 'shopee' | 'lazada', block: unknown): MetricRow[] {
  if (!isRec(block)) return [];
  return FACETS[channel].flatMap((name) => {
    const facet = block[name];
    if (!isRec(facet)) return [];
    const w = isRec(facet.window) ? text(facet.window.label) : '';
    return figureRows(name, facet.figures, w);
  });
}

function productRows(doc: Rec): MetricRow[] {
  const rows: MetricRow[] = [];
  const add = (source: string, products: unknown, withUnits: boolean): void => {
    if (!Array.isArray(products)) return;
    for (const p of products) {
      if (!isRec(p) || typeof p.title !== 'string') continue;
      rows.push({source, product: p.title, revenue: num(p.revenue), units: withUnits ? num(p.units) : null});
    }
  };
  if (isRec(doc.sales)) add('Website', doc.sales.topProducts, false);
  for (const channel of ['shopee', 'lazada'] as const) {
    const block = doc[channel];
    if (!isRec(block)) continue;
    for (const name of FACETS[channel]) {
      const facet = block[name];
      if (isRec(facet)) add(channel === 'shopee' ? 'Shopee' : 'Lazada', facet.topProducts, true);
    }
  }
  return rows;
}

function comparisonRows(doc: Rec): MetricRow[] {
  if (!isRec(doc.comparison)) return [];
  const out: MetricRow[] = [];
  for (const [key, label] of [['shopee', 'Shopee'], ['lazada', 'Lazada'], ['website', 'Website']] as const) {
    const c = doc.comparison[key];
    if (!isRec(c)) continue;
    out.push({channel: label, revenue: num(c.revenue), orders: num(c.orders), aov: num(c.aov), units: num(c.units), ad_spend: num(c.adSpend), roas: num(c.roas)});
  }
  return out;
}

/** The rows and columns of each section, or null when this digest has nothing for it. */
function sectionOf(doc: Rec, section: DigestSection): {columns: ResultColumn[]; rows: MetricRow[]} | null {
  let built: {columns: ResultColumn[]; rows: MetricRow[]};
  switch (section) {
    case 'comparison': built = {columns: COMPARISON_COLUMNS, rows: comparisonRows(doc)}; break;
    case 'figures': built = {columns: FIGURE_COLUMNS, rows: figureRows('digest', doc.figures)}; break;
    case 'sales': built = {columns: FIGURE_COLUMNS, rows: isRec(doc.sales) ? figureRows('website sales', doc.sales.figures) : []}; break;
    case 'customers': built = {columns: FIGURE_COLUMNS, rows: isRec(doc.customers) ? figureRows('customers', doc.customers.figures) : []}; break; // names and outreach notes are never returned
    case 'shopee': built = {columns: FIGURE_COLUMNS, rows: facetRows('shopee', doc.shopee)}; break;
    case 'lazada': built = {columns: FIGURE_COLUMNS, rows: facetRows('lazada', doc.lazada)}; break;
    case 'products': built = {columns: PRODUCT_COLUMNS, rows: productRows(doc)}; break;
  }
  return built.rows.length > 0 ? built : null;
}

const PUBLISHED: MeasureDecl = {
  key: 'published',
  label: 'Published figure',
  kind: 'measured',
  unit: 'text',
  method: 'Figures exactly as published in the stored digest for its window; nothing is recomputed. A figure with a time basis of all time is not for this window.',
};

export interface DigestResult {
  result: MetricResult;
  headline: string;
  window: {label: string; from: string; to: string; which: 'latest' | 'previous' | 'covering'};
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const NOT_STORED = 'No stored digest is available right now (not connected, or none has been stored yet). Say so plainly. Offline POS figures still come from query_metric; Shopee and Lazada figures cannot be answered without it; Website totals come from get_channel_report only when the website CRM is connected (and from the CRM tools when available); otherwise Website figures cannot be answered either.';

/** Newest first with re-runs removed, so "previous" is never a re-run of "latest". */
const ordered = (src: DigestSource): DigestRow[] => dedupeReruns(src.rows, windowOf);
const indexOf = (src: DigestSource): DigestWindow[] => src.index ?? ordered(src).map(windowOf);

/** The owner's day or range for window "covering", or an error. `to` may be "" for one day. */
function coveringDays(o: Rec): {fromDay: string; toDay: string} | MetricError {
  const from = text(o.from);
  const to = text(o.to) || from;
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to)) {
    return fail('window "covering" needs the owner\'s date or dates: from (and to for a range, or "" for one day) as YYYY-MM-DD in Philippine time. Ask the owner if they gave none; do not pick dates yourself.');
  }
  for (const d of [from, to]) if (!isRealDay(d)) return fail(`${d} is not a real date; ask the owner for the dates again.`);
  if (from > to) return fail('from is after to. Ask the owner for the dates again.');
  return {fromDay: from, toDay: to};
}

/** The window a "covering" request picks, or null. The executor uses it to load an older row before shaping. */
export function coveringWindow(input: unknown, src: DigestSource): DigestWindow | null {
  const o = isRec(input) ? input : {};
  if (o.window !== 'covering') return null;
  const days = coveringDays(o);
  return 'error' in days ? null : (pickCovering(indexOf(src), days.fromDay, days.toDay)?.window ?? null);
}

export function shapeDigest(input: unknown, src: DigestSource | null, now: Date): DigestResult | MetricError {
  const o = isRec(input) ? input : {};
  if (typeof o.window !== 'string' || !(DIGEST_WINDOWS as readonly string[]).includes(o.window)) return fail(`window ${JSON.stringify(o.window ?? null)} is not allowed. Allowed values for window: ${list(DIGEST_WINDOWS)}.`);
  if (typeof o.section !== 'string' || !(DIGEST_SECTIONS as readonly string[]).includes(o.section)) return fail(`section ${JSON.stringify(o.section ?? null)} is not allowed. Allowed values for section: ${list(DIGEST_SECTIONS)}.`);
  const section = o.section as DigestSection;
  const which = o.window as DigestResult['window']['which'];
  if (!src || src.rows.length === 0) return fail(NOT_STORED);
  const rows = ordered(src);

  let row: DigestRow | undefined;
  let pick: CoverPick | null = null;
  let asked: {fromDay: string; toDay: string} | null = null;
  if (which === 'covering') {
    const days = coveringDays(o);
    if ('error' in days) return days;
    asked = days;
    const index = indexOf(src);
    pick = pickCovering(index, days.fromDay, days.toDay);
    if (!pick) {
      const near = nearestWindows(index, days.fromDay, days.toDay).map(windowLabel);
      return fail(`No stored digest covers ${rangeLabel(days.fromDay, days.toDay)}. The nearest stored windows are: ${near.join('; ')}. Say so plainly and offer one of them.`);
    }
    const want = pick.window;
    row = rows.find((r) => sameWindow(windowOf(r), want)) ?? src.rows.find((r) => sameWindow(windowOf(r), want));
    if (!row) return fail(`The digest for ${windowLabel(want)} could not be loaded. Say so plainly and try again in a moment.`);
  } else {
    row = which === 'latest' ? rows[0] : rows[1];
    if (!row) return fail('Only one digest is stored, so there is no previous window. Use window "latest".');
  }

  const doc = row.digest as unknown as Rec;
  const built = sectionOf(doc, section);
  if (!built) {
    const have = DIGEST_SECTIONS.filter((s) => sectionOf(doc, s) !== null);
    return fail(`The ${which} digest has no ${section} section. Sections it has: ${have.length ? list(have) : 'none'}.`);
  }

  const days = windowDays(windowOf(row));
  const from = days.min;
  const to = days.max;
  const label = windowLabel(windowOf(row));

  // Staleness is judged on the NEWEST stored digest: if even that is old, every window here is old.
  const newestTo = windowDays(windowOf(rows[0])).max;
  const age = daysBetween(newestTo, phtDate(now));

  const checks: Check[] = [];
  if (src.source === 'mock') checks.push({code: 'mock_source', status: 'warn', text: 'These are built-in sample digests, not real figures.'});
  if (age >= DIGEST_STALE_DAYS) checks.push({code: 'partial_coverage', status: 'warn', text: `The newest stored digest ended ${newestTo}, ${age} days ago, so anything since is not in it. For recent offline sales use query_metric.`, values: {newest_ended: newestTo, days_ago: age}});
  if (doc.degraded === true) checks.push({code: 'partial_coverage', status: 'warn', text: 'This digest is marked degraded: some sources were missing when it was built.'});
  if (pick && asked && !pick.full) {
    checks.push({code: 'partial_coverage', status: 'warn', text: `You asked about ${rangeLabel(asked.fromDay, asked.toDay)}; this digest covers ${rangeLabel(pick.covered.fromDay, pick.covered.toDay)} of it (its window is ${label}). Say so before any figure.`, values: {from: pick.covered.fromDay, to: pick.covered.toDay}});
  }
  checks.push({code: 'partial_coverage', status: 'info', text: `This is the digest for ${label} as published. Digests vary in length (weekly or about a month); this one is a single stored window, not a full month or a custom range, and nothing is recomputed. Name this window in the answer.`, values: {from, to}});

  const result: MetricResult = {
    id: '',
    metric: 'digest',
    dimension: section,
    columns: built.columns,
    rows: built.rows,
    meta: {
      source: 'digest',
      range: {from, to, label},
      dataFrom: from,
      dataTo: to,
      rowCount: built.rows.length,
      coverage: 'full',
      coveredFrom: from,
      coveredTo: to,
      caveats: checks.map((c) => c.text),
      share_basis: null,
      measure: PUBLISHED.key,
      measures: [PUBLISHED],
      insights: [],
      checks,
      reliable: !checks.some((c) => c.status === 'fail'),
    },
  };
  return {result, headline: text(doc.headline), window: {label, from, to, which}};
}

// ---- lookup_product -------------------------------------------------------------------------------------------------

export const PRODUCT_SHOWS = ['details', 'price_history'] as const;
export const MAX_QUERY = 80;
const MAX_LISTED = 5;

const DETAIL_COLUMNS: ResultColumn[] = [
  col('sku', 'SKU', 'text', 'category'),
  col('name', 'Product', 'text', 'category'),
  col('price', 'Current price', 'PHP', 'measure'),
  col('units_direct', 'Units sold directly', 'units', 'measure'),
  col('units_in_bundles', 'Units picked inside bundles', 'units', 'measure'),
  col('revenue_direct', 'Revenue from direct sales', 'PHP', 'measure'),
  col('orders', 'Orders with this product', 'count', 'measure'),
  col('first_sold', 'First sold', 'date', 'time'),
  col('last_sold', 'Last sold', 'date', 'time'),
];
const HISTORY_COLUMNS: ResultColumn[] = [
  col('changed_on', 'Changed on', 'date', 'time'),
  col('old_price', 'Old price', 'PHP', 'measure'),
  col('new_price', 'New price', 'PHP', 'measure'),
];

const LOOKUP_MEASURE: MeasureDecl = {
  key: 'details',
  label: 'Product details',
  kind: 'measured',
  unit: 'text',
  method: 'Counted from completed (not voided) POS orders. Revenue is direct sales only: units picked inside a bundle carry no revenue of their own (see query_metric bundle_picks for allocated revenue).',
};

interface Known {
  sku: string;
  name: string;
}

function knownProducts(data: MetricData): Known[] {
  const seen = new Map<string, Known>();
  for (const order of data.orders) {
    for (const line of order.items) {
      if (line.product_id && !seen.has(line.product_id)) seen.set(line.product_id, {sku: line.product_id, name: line.name || line.product_id});
    }
  }
  return [...seen.values()].sort((a, b) => a.sku.localeCompare(b.sku));
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({length: b.length + 1}, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

const label = (p: Known): string => (p.name === p.sku ? p.sku : `${p.sku} (${p.name})`);

/** Close matches for a query that found nothing: a shared word, or a small edit distance to the SKU or name. */
function closeMatches(q: string, products: Known[]): Known[] {
  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  return products
    .map((p) => {
      const name = p.name.toLowerCase();
      const sku = p.sku.toLowerCase();
      const shared = words.filter((w) => name.includes(w) || sku.includes(w)).length;
      const dist = Math.min(levenshtein(q, sku), levenshtein(q, name));
      return {p, score: shared > 0 ? shared * 10 - dist : dist <= 2 ? 5 - dist : 0};
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.p.sku.localeCompare(b.p.sku))
    .slice(0, 3)
    .map((x) => x.p);
}

export function lookupProduct(input: unknown, data: MetricData): MetricResult | MetricError {
  const o = isRec(input) ? input : {};
  if (typeof o.show !== 'string' || !(PRODUCT_SHOWS as readonly string[]).includes(o.show)) return fail(`show ${JSON.stringify(o.show ?? null)} is not allowed. Allowed values for show: ${list(PRODUCT_SHOWS)}.`);
  const query = typeof o.query === 'string' ? o.query.trim() : '';
  if (query === '') return fail('query must be a product name or SKU (not empty). To list the products that sold, use query_metric with top_products.');
  if (query.length > MAX_QUERY) return fail(`query is too long (at most ${MAX_QUERY} characters): give a product name or a SKU.`);

  const products = knownProducts(data);
  if (products.length === 0) return fail('No products are known yet (there are no sold lines in the data). Use describe_data to see what is available.');

  const q = query.toLowerCase();
  const bySku = products.find((p) => p.sku.toLowerCase() === q);
  const byName = products.filter((p) => p.name.toLowerCase() === q);
  const partial = products.filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q));
  const exact = bySku ?? (byName.length === 1 ? byName[0] : undefined);
  const found = exact ?? (partial.length === 1 ? partial[0] : undefined);

  if (!found) {
    if (partial.length > 1 || byName.length > 1) {
      const some = (byName.length > 1 ? byName : partial).slice(0, MAX_LISTED).map(label);
      return fail(`More than one product matches "${query}": ${list(some)}. Call lookup_product again with the exact SKU.`);
    }
    const close = closeMatches(q, products);
    return fail(
      close.length
        ? `No product has the SKU or name "${query}". Close matches: ${list(close.map(label))}. Call lookup_product again with one of these SKUs, or use query_metric with top_products to see what sold.`
        : `No product has the SKU or name "${query}". Use query_metric with top_products to see the products that sold, then call lookup_product with an exact SKU.`,
    );
  }

  const completed = data.orders.filter((o2) => isCompletedOrder(o2) && !Number.isNaN(Date.parse(o2.created_at)));
  let dataFrom: string | null = null;
  let dataTo: string | null = null;
  for (const o2 of completed) {
    const d = manilaDayKey(o2.created_at);
    if (dataFrom === null || d < dataFrom) dataFrom = d;
    if (dataTo === null || d > dataTo) dataTo = d;
  }

  const caveats: string[] = ['This lookup has no stock levels. Stock by location is on the Inventory page.'];
  const checks: Check[] = [];
  if (data.source === 'mock') checks.push({code: 'mock_source', status: 'warn', text: 'This is sample data, not real sales.'});

  let columns: ResultColumn[];
  let rows: MetricRow[];
  if (o.show === 'price_history') {
    columns = HISTORY_COLUMNS;
    rows = data.priceChanges
      .filter((c) => c.product_id === found.sku)
      .sort((a, b) => a.changed_at.localeCompare(b.changed_at))
      .map((c) => ({changed_on: manilaDayKey(c.changed_at), old_price: c.old_price, new_price: c.new_price}));
    if (rows.length === 0) caveats.push('No price change is recorded for this product.');
  } else {
    columns = DETAIL_COLUMNS;
    let direct = 0;
    let bundled = 0;
    let revenue = 0; // whole centavos
    let orders = 0;
    let first: string | null = null;
    let last: string | null = null;
    for (const order of completed) {
      const lines = order.items.filter((l) => l.product_id === found.sku);
      if (lines.length === 0) continue;
      orders += 1;
      const d = manilaDayKey(order.created_at);
      if (first === null || d < first) first = d;
      if (last === null || d > last) last = d;
      for (const l of lines) {
        if (l.bundle_group) bundled += l.qty;
        else {
          direct += l.qty;
          revenue += Math.round(l.line_total * 100);
        }
      }
    }
    const price = data.prices.find((p) => p.product_id === found.sku)?.price ?? null;
    if (price === null) caveats.push('No current price is recorded for this product.');
    rows = [{sku: found.sku, name: found.name, price, units_direct: direct, units_in_bundles: bundled, revenue_direct: revenue / 100, orders, first_sold: first, last_sold: last}];
  }
  for (const c of checks) caveats.push(c.text);

  const from = dataFrom ?? '';
  const to = dataTo ?? '';
  return {
    id: '',
    metric: 'product_lookup',
    dimension: o.show,
    columns,
    rows,
    meta: {
      source: data.source,
      range: {from, to, label: from && to ? `all available orders, ${from} to ${to}` : 'no orders'},
      dataFrom,
      dataTo,
      rowCount: rows.length,
      coverage: 'full',
      coveredFrom: dataFrom,
      coveredTo: dataTo,
      caveats,
      share_basis: null,
      measure: LOOKUP_MEASURE.key,
      measures: [LOOKUP_MEASURE],
      insights: [],
      checks,
      reliable: true,
    },
  };
}
