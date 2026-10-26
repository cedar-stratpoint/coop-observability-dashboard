// The review CSV for product_channel_alias (scripts/sku-aliases.ts). PURE. `propose` turns what each channel was seen selling into rows: an exact match
// with a POS code is an 'auto' row; anything else is only a PROPOSAL (blank or suggested product_id, confirmed = no) that a person edits. `apply` loads
// only auto rows and rows the person marked confirmed = yes. Nothing fuzzy is written silently.
import type {AliasChannel, AliasRow, AliasType} from './sku-compare';

export interface Observed {
  channel: AliasChannel;
  alias_type: AliasType;
  alias_value: string;
  label: string;
}
export interface PosProduct {
  product_id: string;
  name: string;
}
export interface CsvRow {
  channel: AliasChannel;
  alias_type: AliasType;
  alias_value: string;
  label: string;
  product_id: string;
  bundle_id: string;
  component_qty: number;
  valid_from: string;
  valid_to: string;
  source: 'auto' | 'manual';
  confirmed: 'yes' | 'no';
}
export const CSV_COLUMNS = ['channel', 'alias_type', 'alias_value', 'label', 'product_id', 'bundle_id', 'component_qty', 'valid_from', 'valid_to', 'source', 'confirmed'] as const;

const flat = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function proposeAliases(observed: readonly Observed[], products: readonly PosProduct[]): CsvRow[] {
  const byId = new Map(products.map((p) => [p.product_id.toUpperCase(), p]));
  const byName = new Map(products.map((p) => [flat(p.name), p]));
  const seen = new Set<string>();
  const out: CsvRow[] = [];
  for (const o of observed) {
    const key = `${o.channel}|${o.alias_type}|${o.alias_value.trim().toLowerCase()}`;
    if (!o.alias_value.trim() || seen.has(key)) continue;
    seen.add(key);
    const base = {channel: o.channel, alias_type: o.alias_type, alias_value: o.alias_value.trim(), label: o.label, bundle_id: '', component_qty: 1, valid_from: '', valid_to: ''};
    const exact = o.alias_type === 'sku' ? byId.get(o.alias_value.trim().toUpperCase()) : undefined;
    if (exact) {
      out.push({...base, product_id: exact.product_id, source: 'auto', confirmed: 'yes'});
      continue;
    }
    const name = o.alias_type === 'title' ? byName.get(flat(o.alias_value)) : undefined;
    out.push({...base, product_id: name?.product_id ?? '', source: 'manual', confirmed: 'no'});
  }
  return out;
}

const esc = (s: string | number): string => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
export const toCsv = (rows: readonly CsvRow[]): string => [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => esc(r[c])).join(','))].join('\n') + '\n';

function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = parseLine(lines[0] ?? '');
  if (CSV_COLUMNS.some((c) => !head.includes(c))) throw new Error(`CSV header must contain: ${CSV_COLUMNS.join(', ')}`);
  return lines.slice(1).map((l) => {
    const cells = parseLine(l);
    const g = (c: string): string => (cells[head.indexOf(c)] ?? '').trim();
    return {
      channel: g('channel') as AliasChannel, alias_type: g('alias_type') as AliasType, alias_value: g('alias_value'), label: g('label'), product_id: g('product_id'),
      bundle_id: g('bundle_id'), component_qty: Number(g('component_qty') || 1), valid_from: g('valid_from'), valid_to: g('valid_to'),
      source: g('source') === 'auto' ? 'auto' : 'manual', confirmed: g('confirmed').toLowerCase() === 'yes' ? 'yes' : 'no',
    };
  });
}

const CHANNELS = ['shopee', 'website', 'lazada'];
const TYPES = ['sku', 'variant_id', 'item_id+variation_id', 'title'];
/** The rows `apply` may write, and why each skipped row was skipped. Only auto rows and confirmed rows with a product pass. */
export function rowsToApply(rows: readonly CsvRow[], products: readonly PosProduct[], now: string): {apply: (AliasRow & {label: string})[]; skipped: {row: number; reason: string}[]} {
  const ids = new Set(products.map((p) => p.product_id.toUpperCase()));
  const apply: (AliasRow & {label: string})[] = [];
  const skipped: {row: number; reason: string}[] = [];
  rows.forEach((r, i) => {
    const n = i + 2;
    const skip = (reason: string): void => void skipped.push({row: n, reason});
    if (!CHANNELS.includes(r.channel) || !TYPES.includes(r.alias_type) || !r.alias_value) return skip('bad channel, type or value');
    if (r.source !== 'auto' && r.confirmed !== 'yes') return skip('not confirmed');
    if (!r.product_id) return skip('no product_id');
    if (!ids.has(r.product_id.toUpperCase())) return skip(`product_id ${r.product_id} is not a POS product`);
    if (r.source === 'auto' && !(r.alias_type === 'sku' && r.alias_value.toUpperCase() === r.product_id.toUpperCase())) return skip('auto is only for an exact sku match');
    if (!Number.isInteger(r.component_qty) || r.component_qty < 1) return skip('component_qty must be a whole number of 1 or more');
    apply.push({
      channel: r.channel, alias_type: r.alias_type, alias_value: r.alias_value, product_id: r.product_id, bundle_id: r.bundle_id || null, component_qty: r.component_qty,
      valid_from: r.valid_from || null, valid_to: r.valid_to || null, source: r.source, confirmed_at: now, label: r.label,
    });
  });
  return {apply, skipped};
}

/** Per channel: how many distinct observed identifiers have a usable alias (an applied row or an exact POS code). */
export function coverage(observed: readonly Observed[], aliases: readonly Pick<AliasRow, 'channel' | 'alias_type' | 'alias_value'>[]): Record<string, {observed: number; mapped: number}> {
  const have = new Set(aliases.map((a) => `${a.channel}|${a.alias_type}|${a.alias_value.trim().toLowerCase()}`));
  const out: Record<string, {observed: number; mapped: number}> = {};
  const seen = new Set<string>();
  for (const o of observed) {
    const key = `${o.channel}|${o.alias_type}|${o.alias_value.trim().toLowerCase()}`;
    if (!o.alias_value.trim() || seen.has(key)) continue;
    seen.add(key);
    const c = (out[o.channel] ??= {observed: 0, mapped: 0});
    c.observed += 1;
    if (have.has(key)) c.mapped += 1;
  }
  return out;
}
