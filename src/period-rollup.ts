// One channel report for any Philippine dates (spec F.6, v1 trimmed): revenue, orders, units and AOV per channel, as a total or by
// week or month. Pure, no I/O: shared by the dashboard and Ask Coop (get_channel_report).
// - Shopee and Lazada: the digests' per-day sales (`digest.daily`), merged per channel and per day. On overlap the NEWEST digest wins,
//   and a digest without this channel's `daily` never hides an older one that has it. Coverage is the union of the windows of the
//   digests that carry it, so a covered day with no sales is a zero, not a gap. Before `daily` existed (rows archived before
//   2026-09-28) whole published windows are used only when they tile the missing days exactly (PH-aligned, no overlap); otherwise
//   those days are "not combinable" and named. Never a subset picked silently, never prorated.
// - Website: live CRM orders (websiteRangeMetrics). Offline: completed POS orders (computeKpis drops voided ones).
// - AOV is always summed revenue / summed orders, never an average of averages.
// Deferred from v1 (spec F.6): ad spend, ROAS, ACOS, top products, written summaries across windows.
import {dailyRangeMetrics, phDayStart, websiteRangeMetrics, type DaySales, type RangeOrder} from './custom-range';
import {dedupeReruns, fullDays, isPhAligned, phStamp, windowDays, windowLabel, windowOf} from './digest-windows';
import {addDaysKey, dayKeysBetween, mondayOf, rangeLabel} from './chat/range';
import {computeKpis, manilaDayKey} from './pos-sales-compute';
import type {PosOrder} from './pos-sales-types';
import type {DigestDocument} from './types';

export const ROLLUP_CHANNELS = ['shopee', 'lazada', 'website', 'offline'] as const;
export type RollupChannel = (typeof ROLLUP_CHANNELS)[number];
export const GRANULARITIES = ['total', 'week', 'month'] as const;
export type Granularity = (typeof GRANULARITIES)[number];
export const CHANNEL_LABEL: Record<RollupChannel, string> = {shopee: 'Shopee', lazada: 'Lazada', website: 'Website', offline: 'Offline'};

/** The slice of a stored digest the rollup reads (a DigestRow fits). */
export interface RollupDigest {
  window_from: string;
  window_to: string;
  created_at: string;
  digest: Pick<DigestDocument, 'daily' | 'comparison'>;
}

/**
 * - ok: every day counted.
 * - partial: some days missing (named in notes).
 * - not_combinable: only overlapping or misaligned published windows.
 * - no_data: no source has these dates.
 * - not_connected: the source is not available at all.
 */
export type ChannelStatus = 'ok' | 'partial' | 'not_combinable' | 'no_data' | 'not_connected';

export interface ChannelPeriod {
  channel: RollupChannel;
  revenue: number | null;
  orders: number | null;
  units: number | null;
  aov: number | null;
  status: ChannelStatus;
  /** Plain-language coverage notes, written by code. */
  notes: string[];
}

export interface RollupBucket {
  fromDay: string;
  toDay: string;
  label: string;
  channels: ChannelPeriod[];
}

export interface RollupInput {
  fromDay: string;
  toDay: string;
  channels: readonly RollupChannel[];
  granularity: Granularity;
  /** Stored digests, any order; null when they could not be read. */
  digests: readonly RollupDigest[] | null;
  /** Live CRM orders and when they were read (ISO); null when the CRM is not connected. */
  website: {orders: readonly RangeOrder[]; asOf: string} | null;
  /** POS orders and the first and last PH day with an order; null when POS data is not loaded. */
  offline: {orders: readonly PosOrder[]; dataFrom: string | null; dataTo: string | null} | null;
}

const DAY_MS = 86_400_000;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const aovOf = (revenue: number, orders: number): number | null => (orders > 0 ? round2(revenue / orders) : null);
const empty = (channel: RollupChannel, status: ChannelStatus, notes: string[]): ChannelPeriod => ({channel, revenue: null, orders: null, units: null, aov: null, status, notes});

/** Sorted days as contiguous runs: "Sep 1 to Sep 14, 2026; Sep 16 to Sep 30, 2026". */
export function dayRuns(days: readonly string[]): string {
  const runs: [string, string][] = [];
  for (const d of [...new Set(days)].sort()) {
    const last = runs[runs.length - 1];
    if (last && addDaysKey(last[1], 1) === d) last[1] = d;
    else runs.push([d, d]);
  }
  return runs.map(([a, b]) => rangeLabel(a, b)).join('; ');
}

function lastOfMonth(day: string): string {
  const [y, m] = day.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return addDaysKey(next, -1);
}

/** total: one bucket; week: Monday to Sunday; month: calendar months. The first and last bucket are clipped to the range. */
export function buckets(fromDay: string, toDay: string, granularity: Granularity): [string, string][] {
  if (granularity === 'total') return [[fromDay, toDay]];
  const out: [string, string][] = [];
  for (let start = fromDay; start <= toDay; ) {
    const end = granularity === 'week' ? addDaysKey(mondayOf(start), 6) : lastOfMonth(start);
    const clipped = end < toDay ? end : toDay;
    out.push([start, clipped]);
    start = addDaysKey(clipped, 1);
  }
  return out;
}

/** The published windows that cover `missing` exactly once each, or null (misaligned, outside, overlapping, or not all of it). */
function tile(windows: readonly RollupDigest[], channel: 'shopee' | 'lazada', missing: ReadonlySet<string>): RollupDigest[] | null {
  const seen = new Set<string>();
  for (const d of windows) {
    const c = d.digest.comparison?.[channel];
    const span = fullDays(windowOf(d));
    if (!isPhAligned(windowOf(d)) || !span || !c || c.revenue === null || c.orders === null) return null;
    for (const day of dayKeysBetween(span.min, span.max)) {
      if (!missing.has(day) || seen.has(day)) return null;
      seen.add(day);
    }
  }
  return seen.size === missing.size ? [...windows] : null;
}

const labels = (ds: readonly RollupDigest[]): string => ds.map((d) => windowLabel(windowOf(d))).join('; ');
const notCombinable = (name: string, days: readonly string[], ds: readonly RollupDigest[]): string =>
  `${name}: ${dayRuns(days)} are only in published windows that overlap or do not line up with these dates (${labels(ds)}), so they are not combinable.`;

function marketplace(channel: 'shopee' | 'lazada', fromDay: string, toDay: string, digests: readonly RollupDigest[] | null): ChannelPeriod {
  const name = CHANNEL_LABEL[channel];
  if (digests === null) return empty(channel, 'not_connected', [`${name}: the stored digests are not available right now.`]);
  const wanted = dayKeysBetween(fromDay, toDay);
  const hasDaily = (d: RollupDigest): boolean => Array.isArray(d.digest.daily?.[channel]);

  // Oldest run first, so the newest run of any day is written last and wins.
  const merged = new Map<string, DaySales>();
  const supplied = new Map<string, RollupDigest>(); // day -> the digest whose per-day figure was kept
  for (const d of digests.filter(hasDaily).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    const span = fullDays(windowOf(d));
    if (!span) continue;
    const byDay = new Map((d.digest.daily?.[channel] ?? []).map((x) => [x.day, x] as const));
    for (const day of dayKeysBetween(span.min, span.max)) {
      merged.set(day, byDay.get(day) ?? {day, revenue: 0, orders: 0, units: 0});
      supplied.set(day, d);
    }
  }
  const covered = wanted.filter((d) => merged.has(d));
  const missing = wanted.filter((d) => !merged.has(d));
  const touchesDay = (d: RollupDigest, day: string): boolean => {
    const w = windowDays(windowOf(d));
    return day >= w.min && day <= w.max;
  };
  const touching = dedupeReruns(digests.filter((d) => !hasDaily(d)), windowOf).filter((d) => missing.some((m) => touchesDay(d, m)));
  const tiledRaw = missing.length > 0 && touching.length > 0 ? tile(touching, channel, new Set(missing)) : null;
  const tiled = tiledRaw && [...tiledRaw].sort((a, b) => Date.parse(a.window_from) - Date.parse(b.window_from));

  if (covered.length === 0 && !tiled) {
    if (touching.length > 0) return empty(channel, 'not_combinable', [`${notCombinable(name, missing, touching)} Read one of those windows on its own instead.`]);
    return empty(channel, 'no_data', [`${name}: no stored digest covers ${dayRuns(wanted)}.`]);
  }

  const daily = covered.length ? dailyRangeMetrics(covered.map((d) => merged.get(d) as DaySales), {fromDay, toDay}) : undefined;
  let revenueC = Math.round((daily?.revenue ?? 0) * 100);
  let orders = daily?.orders ?? 0;
  let units: number | null = daily?.units ?? 0;
  const notes: string[] = [];
  if (covered.length > 0) {
    // Always name where the per-day figures came from, so a fully covered channel is never reported as "not checked".
    const used = dedupeReruns([...new Set(covered.map((day) => supplied.get(day) as RollupDigest))], windowOf).sort((a, b) => Date.parse(a.window_from) - Date.parse(b.window_from));
    notes.push(`${name}: per-day sales from digests ${labels(used)}${missing.length === 0 ? ' (every day covered)' : ''}.`);
  }
  if (tiled) {
    for (const d of tiled) {
      const c = d.digest.comparison?.[channel];
      revenueC += Math.round((c?.revenue ?? 0) * 100);
      orders += c?.orders ?? 0;
      units = units === null || typeof c?.units !== 'number' ? null : units + c.units;
    }
    notes.push(`${name}: ${dayRuns(missing)} come from whole published windows (${labels(tiled)}), not from per-day data.`);
  } else if (missing.length > 0) {
    notes.push(`${name}: the totals cover ${dayRuns(covered)} only.`);
    const gap = missing.filter((m) => !touching.some((d) => touchesDay(d, m)));
    const blocked = missing.filter((m) => !gap.includes(m));
    if (gap.length) notes.push(`${name}: no stored digest covers ${dayRuns(gap)}.`);
    if (blocked.length) notes.push(notCombinable(name, blocked, touching));
  }
  const revenue = revenueC / 100;
  return {channel, revenue, orders, units, aov: aovOf(revenue, orders), status: !tiled && missing.length > 0 ? 'partial' : 'ok', notes};
}

function website(fromDay: string, toDay: string, w: RollupInput['website']): ChannelPeriod {
  if (!w) return empty('website', 'not_connected', ['Website: the website CRM is not connected, so there are no Website figures.']);
  const range = {from: new Date(phDayStart(fromDay)).toISOString(), to: new Date(phDayStart(toDay) + DAY_MS).toISOString()};
  const {metrics} = websiteRangeMetrics([...w.orders], range);
  const basis = `live CRM orders as of ${phStamp(w.asOf)} (PH time)`;
  if (!metrics) return empty('website', 'no_data', [`Website: no website orders were found for these dates (${basis}; or the CRM could not be read).`]);
  // websiteRangeMetrics counts only parseable line items: 0 units means none were readable, not "0 sold".
  const unitsKnown = metrics.units > 0;
  const notes = [`Website: ${basis}.`, ...(unitsKnown ? [] : ['Website: units unknown (CRM orders carry no line items).'])];
  return {channel: 'website', revenue: metrics.revenue, orders: metrics.orders, units: unitsKnown ? metrics.units : null, aov: metrics.aov, status: 'ok', notes};
}

function offline(fromDay: string, toDay: string, o: RollupInput['offline']): ChannelPeriod {
  if (!o) return empty('offline', 'not_connected', ['Offline: POS data is not loaded right now.']);
  if (!o.dataFrom) return empty('offline', 'no_data', ['Offline: there is no POS order data yet.']);
  if (toDay < o.dataFrom) return empty('offline', 'no_data', [`Offline: POS data starts ${rangeLabel(o.dataFrom, o.dataFrom)}, after these dates.`]);
  const k = computeKpis(o.orders.filter((x) => {
    const d = manilaDayKey(x.created_at);
    return d >= fromDay && d <= toDay;
  }));
  const notes = fromDay < o.dataFrom ? [`Offline: POS data starts ${rangeLabel(o.dataFrom, o.dataFrom)}; the days before it have no POS data.`] : [];
  const revenue = round2(k.revenue);
  return {channel: 'offline', revenue, orders: k.orders, units: k.units, aov: aovOf(k.revenue, k.orders), status: notes.length ? 'partial' : 'ok', notes};
}

export function rollupChannels(input: RollupInput): RollupBucket[] {
  return buckets(input.fromDay, input.toDay, input.granularity).map(([fromDay, toDay]) => ({
    fromDay,
    toDay,
    label: rangeLabel(fromDay, toDay),
    channels: input.channels.map((c) =>
      c === 'website' ? website(fromDay, toDay, input.website) : c === 'offline' ? offline(fromDay, toDay, input.offline) : marketplace(c, fromDay, toDay, input.digests),
    ),
  }));
}
