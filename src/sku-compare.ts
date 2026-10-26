// Cross-channel SKU comparison. PURE: no I/O, no clock. Each channel is read by an injected reader (src/sku-compare-readers.ts adapts POS, Shopee and the
// website CRM); this module maps the rows to the canonical POS product_id through the alias table and states what it can and cannot add up.
// Rules (plan 2026-10-22 D2, each pinned by test/sku-compare.test.ts):
//  - only mapped rows are summed; rows with no alias go to an UNMAPPED bucket with a share, never dropped, never guessed;
//  - totals only over whole Monday to Sunday weeks (other ranges give each channel on its own);
//  - every channel names its basis; a total says "mixed basis"; a channel that is partial or missing makes the total "at least" / partial;
//  - an alias conflict leaves that key unmapped and is reported, never resolved by picking one.
// Money is summed in whole centavos.

export type AliasChannel = 'shopee' | 'website' | 'lazada';
export type CompareChannel = 'pos' | AliasChannel;
export type AliasType = 'sku' | 'variant_id' | 'item_id+variation_id' | 'title';

/** A `product_channel_alias` row (supabase/product_channel_alias.sql). */
export interface AliasRow {
  channel: AliasChannel;
  alias_type: AliasType;
  alias_value: string;
  product_id: string;
  bundle_id: string | null;
  component_qty: number;
  valid_from: string | null;
  valid_to: string | null;
  source: 'auto' | 'manual';
  confirmed_at: string | null;
}

export interface RawKey {
  type: AliasType;
  value: string;
}
/** One channel row for one Monday-to-Sunday week. `keys` are tried in order; revenue is null when the channel cannot give one. */
export interface RawSkuRow {
  week_from: string;
  keys: RawKey[];
  label?: string;
  units: number;
  revenue: number | null;
  /** Revenue is an allocation (POS bundle picks), not a receipt. */
  allocated?: boolean;
}
export interface ChannelRead {
  rows: RawSkuRow[];
  /** Mondays of the weeks this source actually had data for (a daily channel lists every queried week; Shopee only the imported ones). */
  weeksWithData: string[];
  /** Share (0 to 100) of the channel's week the rows account for, per Monday; null or absent = unknown. */
  coveragePct?: Record<string, number | null>;
  /** False when the source lists only part of its channel (Shopee top products, a truncated CRM ranking). Default: true except Shopee. */
  complete?: boolean;
  notes?: string[];
}
export interface CompareRange {
  /** The product asked for (upper case, trimmed), so a reader can fetch only what it needs. */
  sku: string;
  from: string;
  to: string;
  weeks: string[];
}
export type ChannelReader = (range: CompareRange) => Promise<ChannelRead>;
export type SkuReaders = Partial<Record<CompareChannel, ChannelReader>>;

export interface Bucket {
  rows: number;
  units: number;
  revenue: number;
  shareOfUnits: number | null;
  shareOfRevenue: number | null;
}
export interface ChannelResult {
  channel: CompareChannel;
  status: 'ok' | 'no_data' | 'failed' | 'not_connected';
  basis: string;
  /** False for the website until a stored order has confirmed that its SKU is the POS code. */
  mappingVerified: boolean;
  allocated: boolean;
  units: number;
  revenue: number | null;
  weeksCovered: string[];
  weeksMissing: string[];
  /** Lowest weekly share of the channel's sales the source lists; null when unknown. */
  coveragePct: number | null;
  /** True when the figures are the whole channel for those weeks (no top-performers-only source). */
  exact: boolean;
  unmapped: Bucket;
  notes: string[];
}
export interface Combined {
  units: number;
  revenue: number;
  label: 'exact' | 'at least';
  partial: boolean;
  mixedBasis: boolean;
  channels: CompareChannel[];
  missing: CompareChannel[];
  note: string;
}
export type AliasIssue = {kind: 'conflict' | 'duplicate' | 'unconfirmed'; channel: AliasChannel; alias_type: AliasType; alias_value: string; detail: string};
export interface SkuComparison {
  sku: string;
  from: string;
  to: string;
  aligned: boolean;
  weeks: string[];
  channels: ChannelResult[];
  combined: Combined | null;
  /** Unmapped rows across all channels. */
  unmapped: Bucket;
  issues: AliasIssue[];
  notes: string[];
}

// ---------- weeks (Manila calendar dates as YYYY-MM-DD, UTC arithmetic) ----------
const DAY = 86_400_000;
const ms = (d: string): number => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
const validDay = (d: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(ms(d)) && iso(ms(d)) === d;
export const isMonday = (d: string): boolean => new Date(ms(d)).getUTCDay() === 1;
/** The Monday of the week containing `d`. */
export const weekStart = (d: string): string => iso(ms(d) - ((new Date(ms(d)).getUTCDay() + 6) % 7) * DAY);
export const weekContaining = (d: string): {from: string; to: string} => {
  const from = weekStart(d);
  return {from, to: iso(ms(from) + 6 * DAY)};
};
export const isWholeWeeks = (from: string, to: string): boolean => isMonday(from) && ms(to) >= ms(from) && (ms(to) - ms(from) + DAY) % (7 * DAY) === 0;
export const weeksIn = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let t = ms(weekStart(from)); t <= ms(to); t += 7 * DAY) out.push(iso(t));
  return out;
};

// ---------- the alias index ----------
const norm = (type: AliasType, value: string): string => {
  const v = value.trim();
  if (type === 'title') return v.toLowerCase().replace(/\s+/g, ' ');
  return type === 'sku' ? v.toUpperCase() : v;
};
const keyOf = (channel: AliasChannel, type: AliasType, value: string): string => `${channel}|${type}|${norm(type, value)}`;

export interface Target {
  product_id: string;
  qty: number;
}
type Entry = {kind: 'mapped'; targets: Target[]; combo: boolean} | {kind: 'conflict'};
export interface AliasIndex {
  entries: Map<string, Entry>;
  issues: AliasIssue[];
}

/** Rows that apply to the range (confirmed or exact-auto, validity window overlapping it), grouped per key; duplicates and conflicts are reported. */
export function buildAliasIndex(rows: readonly AliasRow[], range: {from: string; to: string}): AliasIndex {
  const issues: AliasIssue[] = [];
  const groups = new Map<string, AliasRow[]>();
  for (const r of rows) {
    if (!(r.source === 'auto' || r.confirmed_at)) {
      issues.push({kind: 'unconfirmed', channel: r.channel, alias_type: r.alias_type, alias_value: r.alias_value, detail: 'a manual alias counts only once it is confirmed'});
      continue;
    }
    if ((r.valid_from && r.valid_from > range.to) || (r.valid_to && r.valid_to < range.from)) continue;
    const k = keyOf(r.channel, r.alias_type, r.alias_value);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const entries = new Map<string, Entry>();
  for (const [k, g] of groups) {
    const head = g[0];
    const issue = (kind: 'conflict' | 'duplicate', detail: string): void => void issues.push({kind, channel: head.channel, alias_type: head.alias_type, alias_value: head.alias_value, detail});
    const seen = new Map<string, AliasRow>();
    for (const r of g) {
      const t = `${r.product_id}|${r.bundle_id ?? ''}|${r.component_qty}`;
      if (seen.has(t)) issue('duplicate', `listed more than once for ${r.product_id}; counted once`);
      else seen.set(t, r);
    }
    const distinct = [...seen.values()];
    const byProduct = new Set(distinct.map((r) => r.product_id));
    const sameBundle = distinct.length > 1 && distinct[0].bundle_id !== null && distinct.every((r) => r.bundle_id === distinct[0].bundle_id);
    if (distinct.length === 1 || (sameBundle && byProduct.size === distinct.length)) {
      entries.set(k, {kind: 'mapped', targets: distinct.map((r) => ({product_id: r.product_id, qty: r.component_qty})), combo: distinct.length > 1});
    } else {
      issue('conflict', `maps to ${[...byProduct].join(' and ')}; left unmapped until one is chosen`);
      entries.set(k, {kind: 'conflict'});
    }
  }
  return {entries, issues};
}

type Resolved = {kind: 'mapped'; targets: Target[]; combo: boolean} | {kind: 'unmapped'; reason: 'no_alias' | 'conflict' | 'no_key'};
function resolve(channel: CompareChannel, row: RawSkuRow, index: AliasIndex): Resolved {
  if (channel === 'pos') {
    const k = row.keys.find((x) => x.type === 'sku' && x.value.trim());
    return k ? {kind: 'mapped', targets: [{product_id: k.value.trim(), qty: 1}], combo: false} : {kind: 'unmapped', reason: 'no_key'};
  }
  const keys = row.keys.filter((k) => k.value.trim());
  if (!keys.length) return {kind: 'unmapped', reason: 'no_key'};
  for (const k of keys) {
    const e = index.entries.get(keyOf(channel, k.type, k.value));
    if (e?.kind === 'mapped') return e;
    if (e?.kind === 'conflict') return {kind: 'unmapped', reason: 'conflict'};
  }
  return {kind: 'unmapped', reason: 'no_alias'};
}

// ---------- the comparison ----------
const CHANNEL_META: Record<CompareChannel, {basis: string; verified: boolean; allocated: boolean}> = {
  pos: {basis: 'POS completed orders (offline); bundle revenue is an allocation', verified: true, allocated: true},
  shopee: {basis: 'Shopee confirmed sales (weekly SKU report, top products only)', verified: true, allocated: false},
  website: {basis: 'Website orders from the CRM, line gross minus discounts, before returns', verified: false, allocated: false},
  lazada: {basis: 'Lazada order items', verified: false, allocated: false},
};
export const CHANNEL_LABEL: Record<CompareChannel, string> = {pos: 'Offline (POS)', shopee: 'Shopee', website: 'Website', lazada: 'Lazada'};
const C = (n: number): number => Math.round(n * 100);
const bucket = (rows: number, units: number, revC: number, totalUnits: number, totalRevC: number): Bucket => ({
  rows,
  units,
  revenue: revC / 100,
  shareOfUnits: totalUnits > 0 ? units / totalUnits : null,
  shareOfRevenue: totalRevC > 0 ? revC / totalRevC : null,
});

export interface CompareInput {
  sku: string;
  from: string;
  to: string;
  aliases: readonly AliasRow[];
  readers: SkuReaders;
  /** Defaults to POS, Shopee and the website. */
  channels?: readonly CompareChannel[];
}

export async function compareSku(input: CompareInput): Promise<SkuComparison> {
  const sku = input.sku.trim().toUpperCase();
  const {from, to} = input;
  if (!sku) throw new Error('sku is required');
  if (!validDay(from) || !validDay(to) || to < from) throw new Error('from and to must be YYYY-MM-DD dates with to on or after from');
  const aligned = isWholeWeeks(from, to);
  const weeks = weeksIn(from, to);
  const range: CompareRange = {sku, from, to, weeks};
  const index = buildAliasIndex(input.aliases, range);
  const requested = input.channels ?? (['pos', 'shopee', 'website'] as const);
  const notes: string[] = [];
  if (!aligned) notes.push('These dates are not whole Monday to Sunday weeks, so each channel is shown on its own and no total is given. Shopee reports SKUs weekly.');

  let allUnmappedRows = 0;
  let allUnmappedUnits = 0;
  let allUnmappedC = 0;
  let allUnits = 0;
  let allC = 0;
  const channels: ChannelResult[] = [];
  for (const channel of requested) {
    const meta = CHANNEL_META[channel];
    const base: ChannelResult = {
      channel, status: 'ok', basis: meta.basis, mappingVerified: meta.verified, allocated: false, units: 0, revenue: 0, weeksCovered: [], weeksMissing: weeks,
      coveragePct: null, exact: false, unmapped: bucket(0, 0, 0, 0, 0), notes: [],
    };
    if (!meta.verified) base.notes.push(`${CHANNEL_LABEL[channel]} SKUs are matched to POS codes only through confirmed aliases; whether its SKU equals the POS code is unverified.`);
    const reader = input.readers[channel];
    if (!reader) {
      channels.push({...base, status: 'not_connected', units: 0, revenue: null, notes: [...base.notes, `${CHANNEL_LABEL[channel]} is not connected here.`]});
      continue;
    }
    let read: ChannelRead;
    try {
      read = await reader(range);
    } catch {
      channels.push({...base, status: 'failed', units: 0, revenue: null, notes: [...base.notes, `${CHANNEL_LABEL[channel]} could not be read.`]});
      continue;
    }
    const have = weeks.filter((w) => read.weeksWithData.includes(w));
    const live = read.rows.filter((r) => have.includes(r.week_from));
    let units = 0;
    let revC = 0;
    let revKnown = true;
    let allocated = false;
    let uRows = 0;
    let uUnits = 0;
    let uC = 0;
    let totUnits = 0;
    let totC = 0;
    let comboNote = false;
    const reasons = new Set<string>();
    for (const row of live) {
      totUnits += row.units;
      totC += C(row.revenue ?? 0);
      const res = resolve(channel, row, index);
      if (res.kind === 'unmapped') {
        uRows += 1;
        uUnits += row.units;
        uC += C(row.revenue ?? 0);
        reasons.add(res.reason);
        continue;
      }
      const t = res.targets.find((x) => x.product_id.toUpperCase() === sku);
      if (!t) continue;
      units += row.units * t.qty;
      if (res.combo || row.revenue === null) {
        revKnown = false;
        comboNote = comboNote || res.combo;
      } else revC += C(row.revenue);
      allocated = allocated || !!row.allocated;
    }
    const cov = read.coveragePct ? have.map((w) => read.coveragePct?.[w] ?? null) : [];
    const coveragePct = cov.length && cov.every((c) => c !== null) ? Math.min(...(cov as number[])) : null;
    const exact = (read.complete ?? channel !== 'shopee') && have.length === weeks.length;
    const missing = weeks.filter((w) => !have.includes(w));
    const result: ChannelResult = {
      ...base, status: have.length ? 'ok' : 'no_data', allocated, units, revenue: revKnown ? revC / 100 : null, weeksCovered: have, weeksMissing: missing, coveragePct, exact,
      unmapped: bucket(uRows, uUnits, uC, totUnits, totC), notes: [...base.notes, ...(read.notes ?? [])],
    };
    if (!have.length) result.notes.push(`${CHANNEL_LABEL[channel]} has no data for ${weeks.length > 1 ? 'these weeks' : 'this week'}.`);
    else if (missing.length) result.notes.push(`${CHANNEL_LABEL[channel]} has no data for the week${missing.length > 1 ? 's' : ''} of ${missing.join(', ')}.`);
    if (!(read.complete ?? channel !== 'shopee') && channel === 'shopee' && have.length) result.notes.push(coveragePct === null ? 'Shopee lists only the top performing products and its coverage of the shop is unknown, so its figure is at least this.' : `Shopee lists only the top performing products: they cover ${Math.round(coveragePct)}% of the shop's sales, so its figure is at least this.`);
    if (allocated) result.notes.push('Part of the POS revenue is an allocation of bundle prices, not a receipt.');
    if (comboNote) result.notes.push('Part of the units come from a combo listing; revenue for combos is not split, so revenue is not shown.');
    if (uRows) result.notes.push(`${uRows} row${uRows > 1 ? 's' : ''} with no confirmed alias (${[...reasons].map((r) => r.replace('_', ' ')).join(', ')}) sit in the unmapped bucket.`);
    channels.push(result);
    allUnmappedRows += uRows;
    allUnmappedUnits += uUnits;
    allUnmappedC += uC;
    allUnits += totUnits;
    allC += totC;
  }

  let combined: Combined | null = null;
  if (aligned) {
    const usable = channels.filter((c) => c.status === 'ok' && c.revenue !== null);
    const missing = channels.filter((c) => !usable.includes(c) || c.weeksMissing.length).map((c) => c.channel);
    if (usable.length) {
      const exact = !missing.length && usable.every((c) => c.exact) && channels.every((c) => c.channel !== 'lazada' || c.exact);
      combined = {
        units: usable.reduce((a, c) => a + c.units, 0),
        revenue: usable.reduce((a, c) => a + C(c.revenue ?? 0), 0) / 100,
        label: exact ? 'exact' : 'at least',
        partial: missing.length > 0,
        mixedBasis: new Set(usable.map((c) => c.basis)).size > 1,
        channels: usable.map((c) => c.channel),
        missing,
        note: '',
      };
      combined.note = [
        combined.mixedBasis ? 'Mixed basis: the channels count sales differently, see each channel.' : '',
        combined.label === 'at least' ? 'At least this much: a source lists only part of its channel or is missing.' : '',
        combined.partial ? `Partial: ${missing.map((m) => CHANNEL_LABEL[m]).join(', ')} missing or incomplete.` : '',
        usable.some((c) => !c.mappingVerified) ? 'Includes a channel whose SKU mapping is unverified.' : '',
      ].filter(Boolean).join(' ');
    }
  }
  return {sku, from, to, aligned, weeks, channels, combined, unmapped: bucket(allUnmappedRows, allUnmappedUnits, allUnmappedC, allUnits, allC), issues: index.issues, notes};
}
