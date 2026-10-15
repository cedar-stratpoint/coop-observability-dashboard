// F7: which block and which chart form to draw, decided by CODE from the shape of a stored result. The model only
// names a result id and (optionally) a style preference; it never types a value. Pure, no server-only.
// Design: knowledge/architecture/2026-10-01-talk-to-data-design.md § 4b. Chart rules: the dataviz reference
// (choosing-a-form.md, anti-patterns.md). Every number drawn is a stored row value (or a sum of stored values for an
// "Other" fold); every chart decision carries a table twin with ALL rows and columns.
import type {BlockFormat, ChartBlock, ChartForm, ChosenView, Orientation, Series, ViewRequest} from './block-types';
import {assignSeriesColors, isNeutral} from './entity-colors';
import type {ColumnUnit, MetricResult, MetricRow, ResultColumn} from './result-types';

// Thresholds. All are UNTUNED ESTIMATES taken from the dataviz reference and the design table; calibrate them against
// real answers (live eval) and change them here only: the skill text reads them through rules.ts.
export const KPI_MAX = 4; // most stat tiles in one row; more numbers become a table
export const PIE_MAX_SEGMENTS = 6; // most slices of an explicitly requested pie; past it the tail folds into "Other"
export const TABLE_MIN_CLASSES = 7; // more categories than this (all mattering) get a table plus a chart of the top 7
export const SERIES_FOLD_AT = 7; // more series than this fold the tail into "Other" (top SERIES_FOLD_AT - 1 stay)
export const STANDOUT_SHARE = 0.4; // emphasis needs the top category to hold at least this share of the total...
export const STANDOUT_RATIO = 1.5; // ...and be at least this many times the runner-up
export const PIE_CLOSE_RATIO = 0.9; // two neighbouring slices this close (smaller / larger) are hard to tell apart
export const LONG_LABEL = 18; // a category label longer than this goes horizontal
export const MANY_CATEGORIES = 5; // more categories than this go horizontal
/** One series over time is an area (the dataviz reference). Flip this one constant to 'line' to change it. */
export const TIME_SINGLE_FORM: 'area' | 'line' = 'area';

export interface KpiTile {
  key: string;
  label: string;
  value: number | null;
  format: BlockFormat;
}
export interface Twin {
  columns: ResultColumn[];
  rows: MetricRow[];
}
export type BlockDecision =
  | {block: 'kpi'; tiles: KpiTile[]; chosen: ChosenView; twin: Twin}
  | {block: 'chart'; chart: ChartBlock['chart']; chosen: ChosenView; twin: Twin; /** the standout category (bar only), or null */ emphasis: string | null}
  | {block: 'table'; columns: ResultColumn[]; rows: MetricRow[]; chosen: ChosenView; twin: Twin};
/** One or more blocks to draw: a mixed-units result is two charts, a long category list is a table plus a chart. */
export interface ViewDecision {
  decisions: BlockDecision[];
}

const ADDITIVE = new Set<ColumnUnit>(['PHP', 'count', 'units']);
const FORMAT: Partial<Record<ColumnUnit, BlockFormat>> = {PHP: 'peso', count: 'count', units: 'count', percent: 'percent'};
const NUMERIC_ROLES = new Set(['measure', 'share', 'delta']);

export const formatOf = (unit: ColumnUnit): BlockFormat | null => FORMAT[unit] ?? null;
export const isNumericColumn = (c: ResultColumn): boolean => NUMERIC_ROLES.has(c.role);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Sum in integer centavos for pesos, so 0.1 + 0.2 style float noise never shows. */
export function sumOf(values: number[], unit: ColumnUnit): number {
  if (unit === 'PHP') return values.reduce((s, v) => s + Math.round(v * 100), 0) / 100;
  return Math.round(values.reduce((s, v) => s + v, 0) * 1e6) / 1e6;
}

function totalColumn(cols: ResultColumn[], rows: MetricRow[]): ResultColumn | null {
  if (cols.length < 3) return null;
  const hit = cols.find((c) => {
    const others = cols.filter((o) => o !== c);
    let nonZero = false;
    for (const r of rows) {
      const t = num(r[c.key]);
      if (t === null) return false;
      const s = others.reduce((a, o) => a + (num(r[o.key]) ?? 0), 0);
      if (Math.abs(s - t) > 0.005) return false;
      if (t !== 0) nonZero = true;
    }
    return nonZero;
  });
  return hit ?? null;
}

/** A share column whose values add to about 100 means the rows are the parts of one whole. */
function rowsAreWhole(result: MetricResult): boolean {
  // An Explore result with several measures (weekday + orders + revenue + share): the share belongs to one of them, so the rows are not "the parts of the plotted measure".
  if (result.meta.exploratory && result.columns.filter((c) => c.role === 'measure').length >= 2) return false;
  const share = result.columns.find((c) => c.role === 'share' && c.unit === 'percent');
  if (!share) return false;
  const values = result.rows.map((r) => num(r[share.key])).filter((v): v is number => v !== null);
  return values.length >= 2 && Math.abs(values.reduce((a, b) => a + b, 0) - 100) <= 0.6;
}

const cell = (r: MetricRow, key: string): string => String(r[key] ?? '');
const longName = (labels: string[]): boolean => labels.some((l) => l.length > LONG_LABEL);

function sortDesc(rows: MetricRow[], key: string): MetricRow[] {
  return [...rows].sort((a, b) => (num(b[key]) ?? -Infinity) - (num(a[key]) ?? -Infinity));
}
function sortAsc(rows: MetricRow[], key: string): MetricRow[] {
  return [...rows].sort((a, b) => cell(a, key).localeCompare(cell(b, key)));
}

function orientationFor(request: ViewRequest, labels: string[], adj: string[], applies = true): Orientation {
  if (!applies) {
    if (request.orientation === 'horizontal') adj.push('Horizontal does not apply to this form, so it is drawn left to right.');
    return 'vertical';
  }
  if (request.orientation !== 'auto') return request.orientation;
  return labels.length > MANY_CATEGORIES || longName(labels) ? 'horizontal' : 'vertical';
}

const colorMap = (entities: string[]) => assignSeriesColors(entities);

function seriesFor(cols: ResultColumn[], entityOf: (c: ResultColumn) => string): Series[] {
  const colors = colorMap(cols.map(entityOf));
  return cols.map((c) => ({key: c.key, label: c.label, unit: c.unit, entity: entityOf(c), color: colors[entityOf(c)]}));
}

const twinOf = (result: MetricResult): Twin => ({columns: result.columns, rows: result.rows});

interface Facts {
  result: MetricResult;
  request: ViewRequest;
  x: ResultColumn;
  ys: ResultColumn[];
}

function chosen(form: ChosenView['form'], orientation: Orientation | null, reason: string, adjustments: string[], request: ViewRequest): ChosenView {
  return {form, orientation, reason, adjustments, mode: request.kind === 'auto' ? 'auto' : 'user'};
}

function tableDecision(result: MetricResult, request: ViewRequest, reason: string, adjustments: string[] = []): BlockDecision {
  return {block: 'table', columns: result.columns, rows: result.rows, chosen: chosen('table', null, reason, adjustments, request), twin: twinOf(result)};
}

/** Top `keep` rows plus an "Other" row summing the tail (additive measures only; otherwise the tail is just left out). */
function foldTail(rows: MetricRow[], xKey: string, ys: ResultColumn[], keep: number, additive: boolean): {rows: MetricRow[]; folded: {count: number; into: string} | null} {
  if (rows.length <= keep) return {rows, folded: null};
  const head = rows.slice(0, keep);
  const tail = rows.slice(keep);
  if (!additive) return {rows: head, folded: null};
  const other: MetricRow = {[xKey]: 'Other'};
  for (const y of ys) {
    const values = tail.map((r) => num(r[y.key])).filter((v): v is number => v !== null);
    other[y.key] = values.length ? sumOf(values, y.unit) : null;
  }
  return {rows: [...head, other], folded: {count: tail.length, into: 'Other'}};
}

/** Categories-as-series: one stacked bar (or one pie) whose segments are the stored rows. */
function pivot(f: Facts, y: ResultColumn, rows: MetricRow[], separateNeutral: boolean): {x: ChartBlock['chart']['x']; series: Series[]; rows: MetricRow[]} {
  const x = {key: 'part', label: y.label, unit: 'text' as const};
  const cats = rows.map((r) => ({name: cell(r, f.x.key), value: num(r[y.key])})).filter((c): c is {name: string; value: number} => c.value !== null);
  const colors = colorMap(cats.map((c) => c.name));
  const series: Series[] = cats.map((c) => ({key: c.name, label: c.name, unit: y.unit, entity: c.name, color: colors[c.name]}));
  const apart = (n: string): boolean => separateNeutral && isNeutral(n) && n.trim().toLowerCase() !== 'other';
  const main: MetricRow = {part: y.label};
  for (const c of cats) if (!apart(c.name)) main[c.name] = c.value;
  const out: MetricRow[] = [main];
  for (const c of cats) if (apart(c.name)) out.push({part: c.name, [c.name]: c.value});
  return {x, series, rows: out};
}

function emphasisOf(rows: MetricRow[], xKey: string, yKey: string): string | null {
  const values = rows.map((r) => num(r[yKey])).filter((v): v is number => v !== null && v > 0);
  if (values.length < 2) return null;
  const total = values.reduce((a, b) => a + b, 0);
  const [top, second] = [...values].sort((a, b) => b - a);
  if (top / total < STANDOUT_SHARE || top < STANDOUT_RATIO * second) return null;
  const row = rows.find((r) => num(r[yKey]) === top);
  return row ? cell(row, xKey) : null;
}

type Job = 'time' | 'delta' | 'composition' | 'grouped' | 'whole' | 'magnitude';

function autoForm(job: Job, seriesCount: number): ChartForm {
  if (job === 'time') return seriesCount === 1 ? TIME_SINGLE_FORM : 'line';
  if (job === 'delta') return 'diverging_bar';
  if (job === 'composition' || job === 'whole') return 'stacked_bar';
  if (job === 'grouped') return seriesCount <= 3 ? 'grouped_bar' : 'stacked_bar';
  return 'bar';
}

const AUTO_REASON: Record<Job, string> = {
  time: 'A measure over time reads best as an area (one) or lines (several).',
  delta: 'Change against the previous period reads best as bars above and below zero.',
  composition: 'The measures add up to a total per row, so stacked bars show the mix in absolute values.',
  grouped: 'Two or three measures per category read best side by side.',
  whole: 'The rows are parts of one total, so one stacked bar shows how it splits.',
  magnitude: 'Comparing size across categories reads best as bars, largest first.',
};

const SUBSTITUTE = (kind: ChartForm, why: string, used: ChartForm): string => `You asked for ${kind.replace(/_/g, ' ')}, but ${why}, so I used ${used.replace(/_/g, ' ')}.`;

/** The decision for one single-unit group of measures over one x. First match wins; see the file header. */
function decideChart(f: Facts, mixed: boolean): BlockDecision[] {
  const {result, request, x, ys} = f;
  const rows = result.rows;
  const adj: string[] = [];
  if (mixed) adj.push('These measures are on different scales, so each gets its own chart: no shared axis.');
  const isTime = x.role === 'time';
  const total = ys.length >= 3 && !isTime ? totalColumn(ys, rows) : null;
  const parts = total ? ys.filter((y) => y !== total) : ys;
  const additive = ADDITIVE.has(ys[0].unit) && ys[0].role !== 'delta' && !result.meta.measures.some((m) => m.key === ys[0].key && m.kind === 'derived');
  const hasNeg = rows.some((r) => ys.some((y) => (num(r[y.key]) ?? 0) < 0));
  const job: Job = isTime
    ? 'time'
    : ys.some((y) => y.role === 'delta')
      ? 'delta'
      : parts.length >= 2
        ? total
          ? 'composition'
          : 'grouped'
        : additive && rowsAreWhole(result) && rows.length <= TABLE_MIN_CLASSES // a split into many parts is a ranking: table plus top chart
          ? 'whole'
          : 'magnitude';
  // A single additive measure over categories can also be drawn as parts of a whole when the user asks for it.
  const pivotable = parts.length === 1 && !isTime && additive && !hasNeg;

  let form = autoForm(job, parts.length);
  let reason = AUTO_REASON[job];
  const autoChoice = request.kind === 'auto';
  if (request.kind !== 'auto') {
    const k = request.kind;
    reason = `Drawn as you asked: ${k.replace(/_/g, ' ')}.`;
    // Tier C: the nearest valid form, and a reason the owner can read.
    const substitute = (why: string, used: ChartForm = parts.length === 1 && !isTime ? 'bar' : autoForm(job, parts.length)): void => {
      form = used;
      reason = SUBSTITUTE(k, why, used);
      adj.push(reason);
    };
    if (k === 'bar') form = parts.length >= 2 ? 'grouped_bar' : 'bar';
    else if (k === 'grouped_bar') {
      if (parts.length >= 2) form = 'grouped_bar';
      else substitute('side-by-side bars need two or more measures per category', 'bar');
    } else if (k === 'stacked_bar' || k === 'stacked_bar_100') {
      if (parts.length >= 2 || pivotable) form = k;
      else substitute('stacking needs parts that add up to a whole');
    } else if (k === 'line') {
      if (isTime) form = 'line';
      else substitute('a line implies an order and these categories have none');
    } else if (k === 'area') {
      if (isTime && parts.length === 1) form = 'area';
      else if (isTime) substitute('an area of several measures hides the lower ones', 'line');
      else substitute('an area implies an order and these categories have none');
    } else if (k === 'diverging_bar') {
      if (job === 'delta' || hasNeg) form = 'diverging_bar';
      else substitute('a diverging bar needs values above and below a baseline');
    } else if (k === 'small_multiples') {
      substitute('small multiples need a second category to split each chart by', parts.length >= 2 ? 'grouped_bar' : 'bar');
    } else if (k === 'pie') {
      if (parts.length !== 1) substitute('a pie shows one measure');
      else if (isTime) substitute('a pie of dates is not a whole');
      else if (hasNeg) substitute('a pie cannot show negative values');
      else if (!additive) substitute('these values do not add up to a whole');
      else form = 'pie';
    }
  }

  const orient = (labels: string[], applies = true): Orientation => orientationFor(request, labels, adj, applies);
  const twin = twinOf(result);
  const done = (chart: ChartBlock['chart'], emphasis: string | null = null): BlockDecision => ({
    block: 'chart',
    chart,
    chosen: chosen(chart.form, chart.orientation, reason, adj, request),
    twin,
    emphasis,
  });

  // Pie and the single-bar part-to-whole stack: categories become the series.
  if (form === 'pie' || ((form === 'stacked_bar' || form === 'stacked_bar_100') && parts.length === 1)) {
    const y = parts[0];
    const sorted = sortDesc(rows.filter((r) => num(r[y.key]) !== null), y.key);
    let use = sorted;
    let folded: {count: number; into: string} | null = null;
    if (form === 'pie' && sorted.length > PIE_MAX_SEGMENTS) {
      const keep = PIE_MAX_SEGMENTS - 1;
      const f3 = foldTail(sorted, x.key, [y], keep, true);
      use = f3.rows;
      folded = f3.folded;
      adj.push(`Folded the ${sorted.length - keep} smallest of ${sorted.length} categories into "Other" so the pie stays readable (max ${PIE_MAX_SEGMENTS} slices). The table has every row.`);
    } else if (form !== 'pie' && sorted.length > SERIES_FOLD_AT) {
      const f3 = foldTail(sorted, x.key, [y], SERIES_FOLD_AT - 1, true);
      use = f3.rows;
      folded = f3.folded;
      adj.push(`Folded the ${sorted.length - (SERIES_FOLD_AT - 1)} smallest of ${sorted.length} categories into "Other". The table has every row.`);
    }
    if (form === 'pie') {
      const vals = use.map((r) => num(r[y.key]) ?? 0);
      if (vals.length === 2) adj.push('A pie of two slices is better as a bar: say "as a bar" if you prefer.');
      else if (vals.some((v, i) => i > 0 && vals[i - 1] > 0 && v / vals[i - 1] >= PIE_CLOSE_RATIO && !isNeutral(cell(use[i], x.key)))) {
        adj.push('Some slices are close in size and hard to tell apart in a pie: a bar compares them more clearly.');
      }
    }
    const p = pivot(f, y, use, form !== 'pie');
    const orientation = form === 'pie' ? orient([], false) : request.orientation === 'auto' ? 'horizontal' : request.orientation;
    return [done({form, orientation, x: p.x, series: p.series, rows: p.rows, folded})];
  }

  // Time: chronological, lines or an area.
  if (form === 'line' || form === 'area') {
    const ordered = sortAsc(rows, x.key);
    let cols = parts;
    let outRows = ordered;
    let folded: {count: number; into: string} | null = null;
    if (cols.length > SERIES_FOLD_AT) {
      const ranked = [...cols].sort((a, b) => sumOf(ordered.map((r) => num(r[b.key]) ?? 0), b.unit) - sumOf(ordered.map((r) => num(r[a.key]) ?? 0), a.unit));
      const head = ranked.slice(0, SERIES_FOLD_AT - 1);
      const tail = ranked.slice(SERIES_FOLD_AT - 1);
      const unit = cols[0].unit;
      const other: ResultColumn = {key: 'other', label: 'Other', unit, role: 'measure'};
      outRows = ordered.map((r) => {
        const vals = tail.map((c) => num(r[c.key])).filter((v): v is number => v !== null);
        return {...r, other: vals.length ? sumOf(vals, unit) : null};
      });
      cols = [...head, other];
      folded = {count: tail.length, into: 'Other'};
      adj.push(`Showing the top ${SERIES_FOLD_AT - 1} of ${ranked.length} series and the rest as "Other". The table has every column.`);
    }
    const single = cols.length === 1;
    const series = single ? cols.map((c) => ({key: c.key, label: c.label, unit: c.unit, entity: c.label, color: 'chart-1' as const})) : seriesFor(cols, (c) => (c.key === 'other' ? 'Other' : c.label));
    const keep = new Set([x.key, ...cols.map((c) => c.key)]);
    const chartRows = outRows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k))));
    return [done({form, orientation: orient([], false), x: {key: x.key, label: x.label, unit: x.unit}, series, rows: chartRows, folded})];
  }

  // Bars over categories (or over time, drawn as columns).
  const keys = [x.key, ...parts.map((p) => p.key)];
  const slim = (r: MetricRow): MetricRow => Object.fromEntries(keys.map((k) => [k, r[k] ?? null]));
  const primary = parts[0];
  // One category column, several measures, a short list (an Explore weekday + orders + revenue result): the SQL chose the order (a calendar order), so it is kept.
  const keepOrder = result.meta.exploratory !== undefined && !isTime && parts.length === 1 && rows.length <= TABLE_MIN_CLASSES && result.columns.filter((c) => c.role === 'measure').length >= 2 && result.columns.filter((c) => c.role === 'category').length === 1;
  const ordered = isTime ? sortAsc(rows, x.key) : keepOrder ? rows : form === 'diverging_bar' || parts.length === 1 ? sortDesc(rows, primary.key) : [...rows].sort((a, b) => parts.reduce((s, p) => s + (num(b[p.key]) ?? 0), 0) - parts.reduce((s, p) => s + (num(a[p.key]) ?? 0), 0));

  const out: BlockDecision[] = [];
  let drawn = ordered;
  let folded: {count: number; into: string} | null = null;
  if (autoChoice && job === 'magnitude' && ordered.length > TABLE_MIN_CLASSES) {
    const f2 = foldTail(ordered, x.key, parts, TABLE_MIN_CLASSES, additive);
    drawn = f2.rows;
    folded = f2.folded;
    adj.push(
      `More than ${TABLE_MIN_CLASSES} categories: the table has all ${ordered.length} rows and the chart shows the top ${TABLE_MIN_CLASSES}${folded ? ` plus "Other" (the other ${folded.count})` : ''}.`,
    );
    reason = `${ordered.length} categories are too many to compare in one chart, so the full list is a table and the chart shows the largest ${TABLE_MIN_CLASSES}.`;
  }
  const labels = drawn.map((r) => cell(r, x.key));
  const wide = parts.length >= 2;
  const series: Series[] = wide
    ? seriesFor(parts, (c) => c.key)
    : [{key: primary.key, label: primary.label, unit: primary.unit, entity: primary.label, color: 'chart-1'}];
  const orientation = orient(isTime ? [] : labels);
  const emphasis = form === 'bar' && !isTime && !wide ? emphasisOf(drawn, x.key, primary.key) : null;
  out.push(done({form, orientation, x: {key: x.key, label: x.label, unit: x.unit}, series, rows: drawn.map(slim), folded}, emphasis));
  if (autoChoice && job === 'magnitude' && ordered.length > TABLE_MIN_CLASSES) {
    out.push(tableDecision(result, request, `The full list of ${ordered.length} rows, so no value lives only in the chart.`));
  }
  return out;
}

/** The measure an auto chart plots when a result has several: the one the title names, else the first peso measure, else the first. */
function pickMeasure(measures: ResultColumn[], title: string): ResultColumn {
  const t = title.toLowerCase();
  const named = measures.find((m) => {
    const word = m.label.toLowerCase();
    return word !== '' && t.includes(word);
  });
  return named ?? measures.find((m) => m.unit === 'PHP') ?? measures[0];
}

// Two category columns and one measure (spec 2c). UNTUNED estimates like the constants above.
export const GROUPED_MAX_SERIES = 6; // side-by-side bars up to this many series values; stacked past it
export const UNTAGGED_NOTE_SHARE = 0.1; // a group whose untagged share of the measure is OVER this gets a Notes line

const TWO_DIM_KINDS = new Set<ViewRequest['kind']>(['auto', 'grouped_bar', 'stacked_bar', 'stacked_bar_100', 'small_multiples']);
const NO_VALUE = 'No tag';

/** A cell as a category name: trimmed, and "No tag" for an empty one. */
const rawName = (r: MetricRow, c: ResultColumn): string => {
  const v = r[c.key];
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s === '' ? NO_VALUE : s;
};

/**
 * Case-insensitive groups of a column's names (spec 2c.4): the label is the most frequent original spelling; a tie prefers one with a
 * capital letter, then sort order. `variants` lists every spelling seen, most frequent first.
 */
export function displaySpellings(names: readonly string[]): Map<string, {label: string; variants: string[]}> {
  const counts = new Map<string, Map<string, number>>();
  for (const n of names) {
    const k = n.toLowerCase();
    const m = counts.get(k) ?? new Map<string, number>();
    m.set(n, (m.get(n) ?? 0) + 1);
    counts.set(k, m);
  }
  const capital = (s: string): number => (/[A-Z]/.test(s) ? 1 : 0);
  const out = new Map<string, {label: string; variants: string[]}>();
  for (const [k, m] of counts) {
    const ranked = [...m].sort((a, b) => b[1] - a[1] || capital(b[0]) - capital(a[0]) || a[0].localeCompare(b[0])).map(([s]) => s);
    out.set(k, {label: ranked[0], variants: ranked});
  }
  return out;
}

/** With three category columns, one whose value another fixes (venue, fixed by event) adds no split: it is set aside for the notes. */
function splitParent(cats: ResultColumn[], rows: MetricRow[]): {pair: ResultColumn[]; parent: ResultColumn | null} {
  if (cats.length !== 3) return {pair: cats, parent: null};
  const key = (r: MetricRow, c: ResultColumn): string => rawName(r, c).toLowerCase();
  for (const a of cats) {
    for (const b of cats) {
      if (a === b) continue;
      const parentOf = new Map<string, string>();
      const fixed = rows.every((r) => {
        const prev = parentOf.get(key(r, b));
        parentOf.set(key(r, b), key(r, a));
        return prev === undefined || prev === key(r, a);
      });
      if (fixed && new Set(parentOf.values()).size < parentOf.size) return {pair: cats.filter((c) => c !== a), parent: a};
    }
  }
  return {pair: cats, parent: null};
}

const isUntagged = (name: string): boolean => isNeutral(name) && name.trim().toLowerCase() !== 'other';

/** One Notes line per group whose untagged share of the measure is over UNTAGGED_NOTE_SHARE (spec 2c.2). Written by code, never by the model. */
function untaggedNotes(totals: Map<string, {all: number; untagged: number}>, measure: string, dim: string): string[] {
  const out: string[] = [];
  for (const [group, t] of totals) {
    if (!(t.all > 0) || t.untagged / t.all <= UNTAGGED_NOTE_SHARE) continue;
    out.push(`${group}: ${Math.round((t.untagged / t.all) * 100)}% of ${measure} has no ${dim} tag.`);
  }
  return out;
}

/**
 * Two category columns and one measure (an Explore result such as event by pet), plus at most one parent column (venue): the first
 * dimension is the groups, the second the series (one color per value), ONE measure is drawn. Grouped bars up to GROUPED_MAX_SERIES
 * series, stacked past it; "stacked_bar_100" for shares and "small_multiples" (one panel per group) when asked. Names that differ only
 * in case are drawn as one group with the most frequent spelling. Returns null when the shape does not fit, and the caller falls back
 * to the one-dimension path. Only the x tail past TABLE_MIN_CLASSES and the series tail past SERIES_FOLD_AT fold into "Other"; the
 * table twin always has every row.
 */
function decideTwoDim(result: MetricResult, request: ViewRequest, pick: {x?: string; y?: string[]; title?: string}): BlockDecision | null {
  const cats = result.columns.filter((c) => c.role === 'category');
  if (cats.length < 2 || cats.length > 3 || result.columns.some((c) => c.role === 'time') || !TWO_DIM_KINDS.has(request.kind)) return null;
  const {pair, parent} = splitParent(cats, result.rows);
  if (pair.length !== 2) return null;
  const numeric = result.columns.filter(isNumericColumn);
  const wanted = pick.y?.length ? pick.y.map((k) => numeric.find((c) => c.key === k)).filter((c): c is ResultColumn => c !== undefined) : [];
  if (pick.y?.length && wanted.length !== 1) return null;
  const measures = numeric.filter((c) => c.role === 'measure');
  const m = wanted[0] ?? (measures.length ? pickMeasure(measures, pick.title ?? '') : undefined);
  if (!m || m.role !== 'measure' || !ADDITIVE.has(m.unit) || result.meta.measures.some((d) => d.key === m.key && d.kind === 'derived')) return null;
  const [xc, sc] = pick.x !== undefined && pair[1].key === pick.x ? [pair[1], pair[0]] : pair; // an explicit x picks the groups
  const spell = new Map(cats.map((c) => [c.key, displaySpellings(result.rows.map((r) => rawName(r, c)))] as const));
  const name = (r: MetricRow, c: ResultColumn): string => {
    const raw = rawName(r, c);
    return spell.get(c.key)?.get(raw.toLowerCase())?.label ?? raw;
  };

  const cells = new Map<string, Map<string, number[]>>();
  for (const r of result.rows) {
    const v = num(r[m.key]);
    if (v === null) continue;
    const row = cells.get(name(r, xc)) ?? new Map<string, number[]>();
    row.set(name(r, sc), [...(row.get(name(r, sc)) ?? []), v]);
    cells.set(name(r, xc), row);
  }
  if (cells.size === 0) return null;
  const total = (vs: number[]): number => sumOf(vs, m.unit);
  const seriesTotals = new Map<string, number>();
  for (const row of cells.values()) for (const [s, vs] of row) seriesTotals.set(s, sumOf([seriesTotals.get(s) ?? 0, total(vs)], m.unit));
  const seriesNames = [...seriesTotals.keys()].sort((a, b) => (seriesTotals.get(b) ?? 0) - (seriesTotals.get(a) ?? 0));
  if (seriesNames.length < 2) return null;

  const adj: string[] = [];
  if (parent) adj.push(`Each ${xc.label.toLowerCase()} has one ${parent.label.toLowerCase()}, so the chart groups by ${xc.label.toLowerCase()}; the table keeps the ${parent.label.toLowerCase()} column.`);
  for (const c of pair) {
    for (const {label, variants} of spell.get(c.key)?.values() ?? []) {
      if (variants.length > 1) adj.push(`${variants.map((v) => `"${v}"`).join(' and ')} differ only in capitalisation, so the chart draws them as one ${c.label.toLowerCase()}, "${label}"; the table keeps each row.`);
    }
  }
  const keep = seriesNames.length > SERIES_FOLD_AT ? seriesNames.slice(0, SERIES_FOLD_AT - 1) : seriesNames;
  const foldedSeries = keep.length < seriesNames.length;
  const shown = foldedSeries ? [...keep, 'Other'] : keep;
  const keyOf = (s: string): string => (s === xc.key ? `${s} ` : s); // a value named like the axis field must not overwrite it
  let wide: MetricRow[] = [...cells].map(([xName, row]) => {
    const out: MetricRow = {[xc.key]: xName};
    for (const s of shown) {
      const vs = s === 'Other' && foldedSeries ? seriesNames.filter((n) => !keep.includes(n)).flatMap((n) => row.get(n) ?? []) : (row.get(s) ?? []);
      out[keyOf(s)] = vs.length ? total(vs) : null;
    }
    return out;
  });
  const sum = (r: MetricRow): number => sumOf(shown.map((s) => num(r[keyOf(s)]) ?? 0), m.unit);
  wide = wide.sort((a, b) => sum(b) - sum(a));
  let folded: {count: number; into: string} | null = null;
  if (wide.length > TABLE_MIN_CLASSES) {
    const f2 = foldTail(wide, xc.key, shown.map((s) => ({key: keyOf(s), label: s, unit: m.unit, role: 'measure' as const})), TABLE_MIN_CLASSES, true);
    wide = f2.rows;
    folded = f2.folded;
    adj.push(`More than ${TABLE_MIN_CLASSES} ${xc.label.toLowerCase()} values: the table has all ${cells.size} and the chart shows the top ${TABLE_MIN_CLASSES} plus "Other" (the other ${f2.folded?.count}).`);
  }
  if (foldedSeries) adj.push(`Showing the top ${SERIES_FOLD_AT - 1} of ${seriesNames.length} ${sc.label.toLowerCase()} values and the rest as "Other". The table has every row.`);
  const colors = colorMap(shown);
  const series: Series[] = shown.map((s) => ({key: keyOf(s), label: s, unit: m.unit, entity: s, color: colors[s]}));
  const form: ChartForm = request.kind === 'auto' ? (series.length <= GROUPED_MAX_SERIES ? 'grouped_bar' : 'stacked_bar') : (request.kind as ChartForm);
  const orientation: Orientation = form === 'small_multiples' ? 'horizontal' : orientationFor(request, wide.map((r) => cell(r, xc.key)), adj);
  const dim = sc.label.toLowerCase();
  const measureWord = m.label.toLowerCase();
  const how = form === 'small_multiples'
    ? `one small chart per ${xc.label.toLowerCase()} on one shared scale`
    : `${measureWord} as ${form === 'grouped_bar' ? 'side-by-side' : form === 'stacked_bar_100' ? '100% stacked' : 'stacked'} bars`;
  const reason = `${xc.label} by ${dim}: ${how}, one series per ${dim} value.`;

  const totalsBy = (c: ResultColumn): Map<string, {all: number; untagged: number}> => {
    const out = new Map<string, {all: number; untagged: number}>();
    for (const r of result.rows) {
      const v = num(r[m.key]);
      if (v === null) continue;
      const t = out.get(name(r, c)) ?? {all: 0, untagged: 0};
      t.all += v;
      if (isUntagged(name(r, sc))) t.untagged += v;
      out.set(name(r, c), t);
    }
    return out;
  };
  const notes = [...(parent ? untaggedNotes(totalsBy(parent), measureWord, dim) : []), ...untaggedNotes(totalsBy(xc), measureWord, dim)];
  return {
    block: 'chart',
    chart: {form, orientation, x: {key: xc.key, label: xc.label, unit: xc.unit}, series, rows: wide, folded},
    chosen: {...chosen(form, orientation, reason, adj, request), ...(notes.length ? {notes} : {})},
    twin: twinOf(result),
    emphasis: null,
  };
}

/** Group columns by unit: different units never share a chart. */
function byUnit(cols: ResultColumn[]): ResultColumn[][] {
  const groups = new Map<ColumnUnit, ResultColumn[]>();
  for (const c of cols) groups.set(c.unit, [...(groups.get(c.unit) ?? []), c]);
  return [...groups.values()];
}

function autoY(result: MetricResult, title = ''): ResultColumn[] {
  const numeric = result.columns.filter(isNumericColumn);
  const delta = numeric.find((c) => c.role === 'delta');
  if (delta) return [delta];
  const measures = numeric.filter((c) => c.role === 'measure');
  if (measures.length === 0) return numeric.slice(0, 1);
  // An Explore result has no registered primary measure: the title's measure, else the first peso measure, else the first count.
  const primary = result.meta.exploratory ? pickMeasure(measures, title) : (measures.find((c) => c.key === result.meta.measure) ?? measures[0]);
  const sameUnit = measures.filter((c) => c.unit === primary.unit);
  // Over time, several measures of one unit that are not derived ratios are comparable series (online channels and offline
  // sales week by week): draw them all together as lines, never only the primary one.
  const derived = (c: ResultColumn) => result.meta.measures.some((m) => m.key === c.key && m.kind === 'derived');
  const series = sameUnit.filter((c) => !derived(c));
  if (result.columns.some((c) => c.role === 'time') && series.length >= 2) return series.slice(0, SERIES_FOLD_AT);
  return sameUnit.length >= 3 && totalColumn(sameUnit, result.rows) ? sameUnit : [primary];
}

/**
 * Decide what to draw. Rules (first match wins): no rows -> table; one row -> stat tiles (more than KPI_MAX numbers
 * -> table); no category or time field, or no number -> table; measures of different units -> one chart per unit;
 * then by job: time (area for one series, lines for several), change (diverging bar), a total across measures
 * (stacked bar), several measures per category (grouped bar), parts of one whole (one stacked bar, never a pie on
 * auto), else a descending bar (a table plus a top-7 bar past TABLE_MIN_CLASSES categories).
 * Style preferences: tier A honored as asked (pie of 3 to 6 slices, stacked 100%, valid bar/line/area, any
 * orientation); tier B honored with an adjusted look and a note (a long pie folds to "Other", two slices or close
 * slices get a note); tier C substituted with the nearest valid form and a reason (line over unordered categories,
 * pie of negatives or of non-parts, a chart of one number, mixed units).
 */
export function recommendView(result: MetricResult, request: ViewRequest, pick: {x?: string; y?: string[]; /** the block title, only used to choose between several measures */ title?: string} = {}): ViewDecision {
  const {columns, rows} = result;
  const col = (key: string): ResultColumn | undefined => columns.find((c) => c.key === key);
  if (rows.length === 0) return {decisions: [tableDecision(result, request, 'The result has no rows.')]};

  const numeric = columns.filter(isNumericColumn);
  if (rows.length === 1) {
    const wanted = pick.y?.length ? pick.y.map(col).filter((c): c is ResultColumn => c !== undefined && isNumericColumn(c)) : numeric;
    const tiles = wanted.filter((c) => formatOf(c.unit) !== null);
    const adjustments = request.kind !== 'auto' ? ['A chart of a single number is a stat tile, so I drew tiles instead.'] : [];
    if (tiles.length === 0 || tiles.length > KPI_MAX) {
      return {decisions: [tableDecision(result, request, tiles.length === 0 ? 'There is no number to show as a tile.' : `More than ${KPI_MAX} numbers, so a table is clearer than tiles.`, adjustments)]};
    }
    const row = rows[0];
    return {
      decisions: [{
        block: 'kpi',
        tiles: tiles.map((c) => ({key: c.key, label: c.label, value: num(row[c.key]), format: formatOf(c.unit) as BlockFormat})),
        chosen: chosen('kpi', null, 'A single value is a stat tile, not a one-bar chart.', adjustments, request),
        twin: twinOf(result),
      }],
    };
  }

  // An explicit x on kind auto is a one-dimension ask; with a grouped/stacked/small-multiples kind, an x naming a category column still pivots (live A7).
  if (!pick.x || (request.kind !== 'auto' && columns.some((c) => c.key === pick.x && c.role === 'category'))) {
    const two = decideTwoDim(result, request, pick);
    if (two) return {decisions: [two]};
  }
  const x = (pick.x ? col(pick.x) : undefined) ?? columns.find((c) => c.role === 'time') ?? columns.find((c) => c.role === 'category');
  const ys = pick.y?.length ? pick.y.map(col).filter((c): c is ResultColumn => c !== undefined && isNumericColumn(c)) : autoY(result, pick.title ?? '');
  if (!x || ys.length === 0) return {decisions: [tableDecision(result, request, 'This is a detail listing, which reads best as a table.')]};

  const groups = byUnit(ys);
  const decisions = groups.flatMap((g) => decideChart({result, request, x, ys: g}, groups.length > 1));
  return {decisions};
}
