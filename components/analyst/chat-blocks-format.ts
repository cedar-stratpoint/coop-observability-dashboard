// Pure helpers for the Ask Coop answer blocks (F7): number formats, token mapping, label fitting, accessible
// summaries and tolerant loading of persisted blocks. No React, no Recharts. Contract: src/chat/block-types.ts.
import type {BlockFormat, ChartBlock, ChatBlock, ColorToken} from '@/src/chat/block-types';
import type {ColumnUnit} from '@/src/chat/result-types';

export const EM_DASH = '—';

export type ValueFormat = ColumnUnit | BlockFormat;

const COLOR_TOKENS: readonly ColorToken[] = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'cat-1', 'cat-2', 'cat-3', 'cat-4'];
const NEUTRAL_TOKENS: readonly ColorToken[] = ['chart-5'];

/** The gray reserved for "No tag" and "Other" (design 4b). */
export const NEUTRAL_TOKEN: ColorToken = 'chart-5';

export const isColorToken = (t: unknown): t is ColorToken => typeof t === 'string' && (COLOR_TOKENS as readonly string[]).includes(t);
export const isNeutralToken = (t: ColorToken): boolean => NEUTRAL_TOKENS.includes(t);

/** 'cat-1' -> 'var(--cat-1)'. The CSS variables are defined per theme in app/globals.css. An unknown token falls back to the neutral gray. */
export function tokenToCssVar(token: ColorToken): string {
  return `var(--${isColorToken(token) ? token : NEUTRAL_TOKEN})`;
}

const num = (n: number, max: number) => n.toLocaleString('en-US', {minimumFractionDigits: 0, maximumFractionDigits: max});

/** One formatter for tiles, tables, tooltips. null/undefined/NaN is an em dash, never 0. */
export function formatValue(value: number | string | null | undefined, format: ValueFormat): string {
  if (value === null || value === undefined) return EM_DASH;
  if (typeof value === 'string') return value === '' ? EM_DASH : value;
  if (!Number.isFinite(value)) return EM_DASH;
  switch (format) {
    case 'PHP':
    case 'peso':
      return `${value < 0 ? '-' : ''}₱${num(Math.abs(value), 2)}`;
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'ratio':
      return `${value.toFixed(1)}x`;
    case 'count':
    case 'units':
      return num(value, 0);
    default:
      return String(value);
  }
}

/** Compact axis tick: 71050 -> 71K, 1250000 -> 1.3M (peso keeps the sign). Percent and ratio keep their suffix. */
export function formatAxis(value: number, format: ValueFormat): string {
  if (!Number.isFinite(value)) return EM_DASH;
  if (format === 'percent' || format === 'ratio') return formatValue(value, format).replace('.0', '');
  const abs = Math.abs(value);
  let body: string;
  if (abs >= 1_000_000) body = `${num(abs / 1_000_000, 1)}M`;
  else if (abs >= 10_000) body = `${num(abs / 1_000, 0)}K`;
  else if (abs >= 1_000) body = `${num(abs / 1_000, 1)}K`;
  else body = num(abs, abs < 10 ? 1 : 0);
  const prefix = format === 'PHP' || format === 'peso' ? '₱' : '';
  return `${value < 0 ? '-' : ''}${prefix}${body}`;
}

/** An ISO date (2026-09-11) becomes "Sep 11"; anything else is returned as written. */
export function formatCategory(value: string | number | null | undefined, unit: ColumnUnit): string {
  if (value === null || value === undefined || value === '') return EM_DASH;
  const s = String(value);
  if (unit === 'date' && /^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(`${s.slice(0, 10)}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'});
  }
  return s;
}

/** Truncate with an ellipsis so a label never overflows its slot. */
export function shortLabel(text: string, max: number): string {
  if (max < 2 || text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** A "nice" axis maximum at or above `max` (1, 2, 2.5, 5, 10 times a power of ten). */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  const f = max / pow;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * pow;
}

/** `count + 1` evenly spaced ticks from 0 to a nice maximum. */
export function axisTicks(max: number, count = 4): number[] {
  const top = niceMax(max);
  return Array.from({length: count + 1}, (_, i) => (top / count) * i);
}

const FORM_WORD: Record<ChartBlock['chart']['form'], string> = {
  bar: 'bar chart',
  grouped_bar: 'grouped bar chart',
  stacked_bar: 'stacked bar chart',
  stacked_bar_100: '100% stacked bar chart',
  small_multiples: 'small multiples (one small bar chart per group)',
  line: 'line chart',
  area: 'area chart',
  pie: 'pie chart',
  diverging_bar: 'diverging bar chart',
};

/** The form the renderer will actually draw: a form it does not know (a newer server, a bad payload) falls back to grouped bars, never blank. */
export function resolveForm(form: string | undefined): ChartBlock['chart']['form'] {
  return form && Object.hasOwn(FORM_WORD, form) ? (form as ChartBlock['chart']['form']) : 'grouped_bar';
}

/** A plain sentence for assistive tech: what the block is and its largest values. The full rows are in the table twin. */
export function ariaSummary(block: ChatBlock, top = 3): string {
  if (block.kind === 'kpi') {
    return `${block.title}: ${block.label} ${formatValue(block.value, block.format)}${block.sub ? `, ${block.sub}` : ''}.`;
  }
  if (block.kind === 'table') {
    return `${block.title}: table with ${block.rows.length} ${block.rows.length === 1 ? 'row' : 'rows'} and ${block.columns.length} columns.`;
  }
  const {chart} = block;
  const first = chart.series[0];
  const head = `${block.title}: ${FORM_WORD[resolveForm(chart.form)]} of ${chart.rows.length} ${chart.rows.length === 1 ? 'category' : 'categories'}`;
  if (!first) return `${head}.`;
  const key = first.key;
  const ranked = chart.rows
    .map((r) => ({label: formatCategory(r[chart.x.key], chart.x.unit), v: r[key]}))
    .filter((r): r is {label: string; v: number} => typeof r.v === 'number')
    .sort((a, b) => b.v - a.v)
    .slice(0, top);
  const tops = ranked.map((r) => `${r.label} ${formatValue(r.v, first.unit)}`).join(', ');
  const more = chart.series.length > 1 ? ` across ${chart.series.length} series (${[...chart.series.slice(0, 3).map((s) => s.label), ...(chart.series.length > 3 ? [`and ${chart.series.length - 3} more`] : [])].join(', ')})` : '';
  return `${head}${more}.${tops ? ` Largest ${first.label}: ${tops}.` : ''} The full figures are in the table view.`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** True when the value has the minimum shape the renderers rely on. Anything deeper is guarded in the components. */
export function isRenderableBlock(v: unknown): v is ChatBlock {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id) return false;
  if (typeof v.title !== 'string') return false;
  if (!Array.isArray(v.caveats)) return false;
  if (v.kind === 'kpi') return typeof v.label === 'string' && typeof v.format === 'string';
  if (v.kind === 'table') return Array.isArray(v.columns) && Array.isArray(v.rows);
  if (v.kind === 'chart') {
    const c = v.chart;
    if (!isObj(c) || !Array.isArray(c.series) || !Array.isArray(c.rows) || !isObj(c.x) || typeof c.x.key !== 'string') return false;
    if (!c.series.every((s) => isObj(s) && typeof s.key === 'string')) return false;
    return isObj(v.chosen) && Array.isArray(v.chosen.adjustments) && isObj(v.twin) && Array.isArray(v.twin.columns) && Array.isArray(v.twin.rows);
  }
  return false;
}

export type PlacedBlock = {at: number; block: ChatBlock};

/** Tolerant loader for persisted `blocks`: drops anything malformed, never throws, keeps order, one entry per block id. */
export function sanitizeBlocks(raw: unknown): PlacedBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: PlacedBlock[] = [];
  for (const item of raw) {
    if (!isObj(item) || !isRenderableBlock(item.block)) continue;
    const at = typeof item.at === 'number' && Number.isFinite(item.at) && item.at >= 0 ? Math.floor(item.at) : 0;
    const i = out.findIndex((p) => p.block.id === (item.block as ChatBlock).id);
    if (i >= 0) out[i] = {at, block: item.block};
    else out.push({at, block: item.block});
  }
  return out;
}

/** Add a block, or replace the entry with the same id (a block can be re-bound). Returns a new array. */
export function upsertBlock(blocks: PlacedBlock[] | undefined, at: number, block: ChatBlock): PlacedBlock[] {
  const list = blocks ?? [];
  const i = list.findIndex((p) => p.block.id === block.id);
  if (i < 0) return [...list, {at, block}];
  return list.map((p, j) => (j === i ? {at: p.at, block} : p));
}

/** Split text at block offsets. Returns pieces in order: text slices and blocks. Offsets are clamped to the text length. */
export type Piece = {type: 'text'; text: string} | {type: 'blocks'; blocks: ChatBlock[]};
export function interleave(text: string, placed: PlacedBlock[]): Piece[] {
  const sorted = [...placed].map((p) => ({at: Math.min(Math.max(p.at, 0), text.length), block: p.block})).sort((a, b) => a.at - b.at);
  const pieces: Piece[] = [];
  let cursor = 0;
  let i = 0;
  while (i < sorted.length) {
    const at = sorted[i].at;
    if (at > cursor) pieces.push({type: 'text', text: text.slice(cursor, at)});
    cursor = Math.max(cursor, at);
    const group: ChatBlock[] = [];
    while (i < sorted.length && sorted[i].at === at) group.push(sorted[i++].block);
    pieces.push({type: 'blocks', blocks: group});
  }
  if (cursor < text.length) pieces.push({type: 'text', text: text.slice(cursor)});
  return pieces;
}

export interface PieSlice {name: string; value: number; token: ColorToken; unit: ColumnUnit}

/** Slices of a pie block. The server emits a pie as one row with each category as a series (recommend-view.ts), so a slice is a series. */
export function pieSlices(chart: ChartBlock['chart'], max = 6): PieSlice[] {
  const row = chart.rows[0] ?? {};
  return chart.series
    .map((s) => ({name: s.label, value: row[s.key], token: s.color, unit: s.unit}))
    .filter((r): r is PieSlice => typeof r.value === 'number' && r.value > 0)
    .slice(0, max);
}
