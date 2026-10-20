// Ad spend, ROAS and top products for any PH dates, from the stored digests. Pure, no I/O (spec: Sales range page, stories 3 and 5).
// A digest holds ONE figure for ONE window and these figures cannot be cut by day, so a window counts toward a span only when the
// whole window sits inside it. The window used is the facet's own (Shopee's exports have their own dates, often not the digest's);
// a facet without one falls back to the digest window. Windows that overlap are never summed: the newest run wins.
// ROAS is total ad revenue / total spend (roas x spend per window), never an average of ratios.
import {rangeLabel} from './chat/range';
import {windowDays, windowOf} from './digest-windows';
import type {DigestDocument, DigestSkuRank} from './types';

export type MarketChannel = 'shopee' | 'lazada';
/** The slice of a stored digest this reads (a DigestRow fits). */
export interface WindowDigest {
  window_from: string;
  window_to: string;
  created_at: string;
  digest: Pick<DigestDocument, 'comparison' | 'shopee' | 'lazada'>;
}
export type SkipReason = 'outside' | 'rerun' | 'overlap' | 'no_figures' | 'no_window';
export interface WindowSkip {from: string; to: string; label: string; reason: SkipReason}
export interface UsedWindow {from: string; to: string; label: string}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const cents = (n: number): number => Math.round(n * 100);
type Days = {min: string; max: string};
/** days: where the figure belongs (null: cannot be placed). value: the figure (null: none). */
type Read<T> = (d: WindowDigest) => {days: Days | null; value: T | null};

/** Date-only strings are inclusive PH days (Shopee export ranges); instants are a half-open window (digest, Lazada). */
function daysOf(w: {from?: string | null; to?: string | null} | null | undefined): Days | null {
  if (!w?.from || !w?.to) return null;
  if (DAY_RE.test(w.from) && DAY_RE.test(w.to)) return w.from <= w.to ? {min: w.from, max: w.to} : null;
  return windowDays({from: w.from, to: w.to}); // every day it touches: a partly covered edge day makes it "not fully inside"
}
const digestDays = (d: WindowDigest): Days | null => windowDays(windowOf(d));

/** Shopee's exports carry their own dates and are placed only by them. Lazada's facets share the digest's query window, so it is the fallback. */
const ownOrDigestDays = (d: WindowDigest, channel: MarketChannel, own: Days | null): Days | null => own ?? (channel === 'lazada' ? digestDays(d) : null);

const REASON_TEXT: Record<SkipReason, string> = {
  outside: 'is only partly inside these dates, and these figures cannot be cut by day',
  rerun: 'is an older run of a window already counted',
  overlap: 'overlaps a window already counted, so it is not added',
  no_figures: 'has no figures',
  no_window: 'has no export dates, so it cannot be placed',
};

/** Windows fully inside the span, newest run first; a window is kept only if it overlaps none already kept. Skips are named. */
function select<T>(fromDay: string, toDay: string, digests: readonly WindowDigest[], read: Read<T>) {
  const skipped: WindowSkip[] = [];
  const skip = (d: Days, reason: SkipReason): void => void skipped.push({from: d.min, to: d.max, label: rangeLabel(d.min, d.max), reason});
  const touches = (d: Days): boolean => !(d.max < fromDay || d.min > toDay);
  const inside: {days: Days; value: T; createdAt: number}[] = [];
  for (const d of digests) {
    const {days, value} = read(d);
    if (!days) {
      // A figure with no dates of its own cannot be placed. Name it if its digest touches the span.
      const own = digestDays(d);
      if (value !== null && own && touches(own)) skip(own, 'no_window');
      continue;
    }
    if (!touches(days)) continue; // not part of this span: nothing to report
    if (value === null) skip(days, 'no_figures');
    else if (days.min < fromDay || days.max > toDay) skip(days, 'outside');
    else inside.push({days, value, createdAt: Date.parse(d.created_at)});
  }
  const kept: typeof inside = [];
  // Newest run first; on a tie the window that ends last.
  const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  for (const w of [...inside].sort((a, b) => b.createdAt - a.createdAt || cmpStr(b.days.max, a.days.max) || cmpStr(a.days.min, b.days.min))) {
    const clash = kept.find((k) => w.days.min <= k.days.max && w.days.max >= k.days.min);
    if (!clash) kept.push(w);
    else skip(w.days, clash.days.min === w.days.min && clash.days.max === w.days.max ? 'rerun' : 'overlap');
  }
  kept.sort((a, b) => cmpStr(a.days.min, b.days.min));
  const used: UsedWindow[] = kept.map((k) => ({from: k.days.min, to: k.days.max, label: rangeLabel(k.days.min, k.days.max)}));
  return {kept, used, skipped};
}

const nameOf = (c: MarketChannel): string => (c === 'shopee' ? 'Shopee' : 'Lazada');
/** One line per skipped window, except "no figures", which is normal for a channel that is not connected: one line for all of them. */
function skipNotes(what: string, skipped: readonly WindowSkip[]): string[] {
  const none = skipped.filter((s) => s.reason === 'no_figures');
  const rest = skipped.filter((s) => s.reason !== 'no_figures').map((s) => `${what}: ${s.label} ${REASON_TEXT[s.reason]}.`);
  return none.length ? [...rest, `${what}: ${none.length} ${none.length === 1 ? 'window has' : 'windows have'} no figures (${none.slice(0, 3).map((s) => s.label).join('; ')}${none.length > 3 ? '; and more' : ''}).`] : rest;
}

// ── ad spend and ROAS ──────────────────────────────────────────────────────────────────────────────────────────────────────
export interface AdsWindow extends UsedWindow {spend: number; roas: number | null}
export interface ChannelAds {
  channel: MarketChannel;
  /** Null (not 0) when no full window is inside the span. */
  spend: number | null;
  roas: number | null;
  windows: AdsWindow[];
  skipped: WindowSkip[];
  status: 'ok' | 'none';
  /** Plain-language notes, written by code: what was used, then what was left out. */
  notes: string[];
  /** Only what is wrong or left out (a subset of notes). */
  warnings: string[];
}

export function spanAds(channel: MarketChannel, fromDay: string, toDay: string, digests: readonly WindowDigest[]): ChannelAds {
  const what = `${nameOf(channel)} ads`;
  const {kept, used, skipped} = select(fromDay, toDay, digests, (d) => {
    const c = d.digest.comparison?.[channel];
    return {days: ownOrDigestDays(d, channel, daysOf(d.digest[channel]?.ads?.window)), value: c && typeof c.adSpend === 'number' ? {spend: c.adSpend, roas: typeof c.roas === 'number' ? c.roas : null} : null};
  });
  const windows: AdsWindow[] = kept.map((k, i) => ({...used[i], ...k.value}));
  const warnings = skipNotes(what, skipped);
  if (windows.length === 0) {
    warnings.unshift(`${what}: no full ad window is inside these dates.`);
    return {channel, spend: null, roas: null, windows, skipped, status: 'none', notes: warnings, warnings};
  }

  let spendC = 0;
  let roasSpendC = 0;
  let adRevC = 0;
  for (const w of windows) {
    spendC += cents(w.spend);
    if (w.roas !== null) {
      roasSpendC += cents(w.spend);
      adRevC += cents(w.spend) * w.roas;
    }
  }
  if (roasSpendC < spendC) warnings.push(`${what}: some windows have spend but no ROAS, so ROAS covers only the windows that have one.`);
  const usedNote = `${what}: ${windows.length} full ${windows.length === 1 ? 'window' : 'windows'} inside these dates (${windows.map((w) => w.label).join('; ')}).`;
  return {channel, spend: spendC / 100, roas: roasSpendC > 0 ? Math.round((adRevC / roasSpendC) * 100) / 100 : null, windows, skipped, status: 'ok', notes: [usedNote, ...warnings], warnings};
}

// ── top products ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ChannelProducts {
  channel: MarketChannel;
  products: DigestSkuRank[];
  windows: UsedWindow[];
  skipped: WindowSkip[];
  status: 'ok' | 'none';
  /** True when more than one window was merged: each window keeps only its own top list, so a product that is 6th every time can be missing. */
  approximate: boolean;
  notes: string[];
  warnings: string[];
}

/** The facet that carries the per-SKU list: Shopee stamps it on `sales` (else `products`), Lazada on `sales`. */
function productFacet(d: WindowDigest, channel: MarketChannel) {
  const has = <F extends {topProducts?: DigestSkuRank[]}>(f: F | null | undefined): F | null => (f?.topProducts?.length ? f : null);
  return channel === 'shopee' ? has(d.digest.shopee?.sales) ?? has(d.digest.shopee?.products) : has(d.digest.lazada?.sales);
}

export function spanTopProducts(channel: MarketChannel, fromDay: string, toDay: string, digests: readonly WindowDigest[], limit = 5): ChannelProducts {
  const what = `${nameOf(channel)} top products`;
  const {kept, used, skipped} = select(fromDay, toDay, digests, (d) => {
    const f = productFacet(d, channel);
    return {days: ownOrDigestDays(d, channel, daysOf(f?.window)), value: f?.topProducts ?? null};
  });
  const warnings = skipNotes(what, skipped);
  if (kept.length === 0) {
    warnings.unshift(`${what}: no full window with a product list is inside these dates.`);
    return {channel, products: [], windows: used, skipped, status: 'none', approximate: false, notes: warnings, warnings};
  }

  const byTitle = new Map<string, {title: string; revenueC: number; units: number}>();
  for (const k of kept) {
    for (const p of k.value) {
      const key = p.title.trim().toLowerCase();
      const cur = byTitle.get(key) ?? {title: p.title.trim(), revenueC: 0, units: 0};
      cur.revenueC += cents(p.revenue);
      cur.units += p.units;
      byTitle.set(key, cur);
    }
  }
  const products = [...byTitle.values()]
    .sort((a, b) => b.revenueC - a.revenueC || (a.title < b.title ? -1 : 1))
    .slice(0, limit)
    .map((p) => ({title: p.title, revenue: p.revenueC / 100, units: p.units}));
  const approximate = kept.length > 1;
  const merged = `${what}: merged from ${used.length} full ${used.length === 1 ? 'window' : 'windows'} (${used.map((w) => w.label).join('; ')}).${approximate ? ' Each window keeps only its own top list, so a product that is 6th every time can be missing.' : ''}`;
  return {channel, products, windows: used, skipped, status: 'ok', approximate, notes: [merged, ...warnings], warnings};
}
