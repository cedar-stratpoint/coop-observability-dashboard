// The Sales range page's data, built in code (spec: Sales range page). Pure, no I/O: the page hands in what it read.
// Totals come from period-rollup (any PH dates); ad spend, ROAS and top products from span-windows (whole windows inside the dates).
import {addDaysKey, dayKeysBetween, isRealDay, mondayOf, rangeLabel} from './chat/range';
import {phDayStart, websiteRangeMetrics, type RangeOrder} from './custom-range';
import {fullDays, windowOf} from './digest-windows';
import {manilaDayKey} from './pos-sales-compute';
import {rollupChannels, ROLLUP_CHANNELS, type ChannelPeriod, type RollupDigest} from './period-rollup';
import type {PosOrder} from './pos-sales-types';
import {buildSeries, type Series} from './sales-range-series';
import {spanAds, spanTopProducts, type ChannelAds, type ChannelProducts, type UsedWindow, type WindowDigest} from './span-windows';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
export const DEFAULT_WEEKS = 4;

export interface SpanRequest {from?: string; to?: string; span?: string}
export interface SpanBounds {firstDay: string; todayDay: string}
export interface ResolvedSpan {fromDay: string; toDay: string; all: boolean; /** Plain words when the dates were moved. */ note: string | null}

/** The Sunday that ended the last full Monday to Sunday week (today is never finished). */
function lastFinishedSunday(todayDay: string): string {
  const yesterday = addDaysKey(todayDay, -1);
  const monday = mondayOf(yesterday);
  const sunday = addDaysKey(monday, 6);
  return sunday <= yesterday ? sunday : addDaysKey(monday, -1);
}

/** The dates in the URL, made safe: swapped if reversed, clamped to the data and today, or the last 4 finished weeks. */
export function resolveSpan(req: SpanRequest, {firstDay, todayDay}: SpanBounds): ResolvedSpan {
  if (req.span === 'all') return {fromDay: firstDay, toDay: todayDay, all: true, note: null};
  if (validDay(req.from) && validDay(req.to)) {
    const [a, b] = req.from <= req.to ? [req.from, req.to] : [req.to, req.from];
    const fromDay = a < firstDay ? firstDay : a;
    const toDay = b > todayDay ? todayDay : b;
    if (fromDay <= toDay) {
      const notes = [fromDay !== a ? `The first day with data is ${rangeLabel(firstDay, firstDay)}, so the range starts there.` : '', toDay !== b ? 'Days after today are left out.' : ''].filter(Boolean);
      return {fromDay, toDay, all: false, note: notes.length ? notes.join(' ') : null};
    }
  }
  const toDay = lastFinishedSunday(todayDay);
  const start = addDaysKey(toDay, -(DEFAULT_WEEKS * 7 - 1));
  const fromDay = start < firstDay ? firstDay : start;
  return fromDay <= toDay ? {fromDay, toDay, all: false, note: null} : {fromDay: firstDay, toDay: todayDay, all: false, note: null};
}

const validDay = (d?: string): d is string => Boolean(d && DAY_RE.test(d) && isRealDay(d));

/** True when the link asks for a range: `span=all`, or two real dates. Anything else is the weekly view. */
export function isRangeRequest(req: SpanRequest): boolean {
  return req.span === 'all' || (validDay(req.from) && validDay(req.to));
}

/** What the Ask Coop drawer should say it is answering about while dates are picked (the span, not the selected week). Null when no dates are picked. */
export function spanScopeLabel(req: SpanRequest, bounds: SpanBounds): string | null {
  if (!isRangeRequest(req)) return null;
  const r = resolveSpan(req, bounds);
  return r.all ? `${rangeLabel(r.fromDay, r.toDay)} (all time)` : rangeLabel(r.fromDay, r.toDay);
}

/** The dates moved out to whole Monday to Sunday weeks (end stops at the last finished Sunday), or null when nothing would change. */
export function snapToWeeks(fromDay: string, toDay: string, {firstDay, todayDay}: SpanBounds): {fromDay: string; toDay: string} | null {
  const monday = mondayOf(fromDay);
  const start = monday < firstDay ? firstDay : monday;
  const sunday = addDaysKey(mondayOf(toDay), 6);
  const last = lastFinishedSunday(todayDay);
  const end = sunday > last ? last : sunday;
  if (start > end || (start === fromDay && end === toDay)) return null;
  return {fromDay: start, toDay: end};
}

/** The span of the same length directly before this one, or null when it would start before the first day with data. */
export function previousSpan(fromDay: string, toDay: string, firstDay: string): {fromDay: string; toDay: string} | null {
  const n = dayKeysBetween(fromDay, toDay).length;
  const prevFrom = addDaysKey(fromDay, -n);
  return prevFrom >= firstDay ? {fromDay: prevFrom, toDay: addDaysKey(fromDay, -1)} : null;
}

/** What the page needs from the span before to show a fair change: per-channel figures with their status, and the ad windows. */
export interface PreviousView {
  fromDay: string;
  toDay: string;
  label: string;
  channels: ChannelPeriod[];
  ads: {shopee: ChannelAds; lazada: ChannelAds};
}

/** The first PH day any stored digest touches (the archive's start), or null when there are none. */
export function firstDigestDay(digests: readonly Pick<RollupDigest, 'window_from' | 'window_to' | 'created_at'>[]): string | null {
  let first: string | null = null;
  for (const d of digests) {
    const days = fullDays(windowOf(d));
    if (days && (!first || days.min < first)) first = days.min;
  }
  return first;
}

export interface ProductRow {title: string; revenue: number; units: number}
export interface SalesRangeView {
  fromDay: string;
  toDay: string;
  label: string;
  dayCount: number;
  all: boolean;
  snap: {fromDay: string; toDay: string; label: string} | null;
  bounds: {min: string; max: string};
  channels: ChannelPeriod[];
  totals: {revenue: number | null; orders: number | null; aov: number | null; units: number | null};
  ads: {shopee: ChannelAds; lazada: ChannelAds; total: {spend: number | null; roas: number | null; tag: {kind: 'ex' | 'wk' | 'none'; text: string}}};
  products: {website: ProductRow[]; shopee: ChannelProducts; lazada: ChannelProducts};
  /** The span of the same length directly before, for "compare with the span before"; null when there is none in the archive. */
  previous: PreviousView | null;
  /** Weekly and monthly buckets for the "Over time" view. */
  series: Series;
  /** Gaps and anything left out. Shown in an amber banner. */
  notes: string[];
  /** Where the figures came from. Shown quietly. */
  sources: string[];
}
export interface SalesRangeInput extends SpanBounds {
  span: SpanRequest;
  digests: readonly (RollupDigest & WindowDigest)[];
  website: {orders: readonly RangeOrder[]; asOf: string} | null;
  offline: {orders: readonly PosOrder[]; dataFrom: string | null; dataTo: string | null} | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** True when the windows, joined end to end, cover every day from fromDay to toDay. */
function covers(windows: readonly UsedWindow[], fromDay: string, toDay: string): boolean {
  let next = fromDay;
  for (const w of [...windows].sort((a, b) => (a.from < b.from ? -1 : 1))) {
    if (w.from > next) return false;
    if (w.to >= next) next = addDaysKey(w.to, 1);
  }
  return next > toDay;
}

/** Ad spend and ROAS over the chosen marketplaces. ROAS is weighted by spend; the tag says which windows back the numbers. */
export function adsTotals(selected: readonly ChannelAds[], fromDay: string, toDay: string): SalesRangeView['ads']['total'] {
  const parts = selected.filter((a) => a.spend !== null);
  if (parts.length === 0) return {spend: null, roas: null, tag: {kind: 'none', text: 'needs a full ad window inside these dates'}};
  const spend = round2(parts.reduce((s, a) => s + (a.spend ?? 0), 0));
  const withRoas = parts.filter((a) => a.roas !== null);
  const roasSpend = withRoas.reduce((s, a) => s + (a.spend ?? 0), 0);
  const roas = roasSpend > 0 ? round2(withRoas.reduce((s, a) => s + (a.roas as number) * (a.spend ?? 0), 0) / roasSpend) : null;
  const every = parts.length === selected.length && parts.every((a) => covers(a.windows, fromDay, toDay));
  const n = (a: ChannelAds) => `${a.windows.length} full ${a.windows.length === 1 ? 'window' : 'windows'}`;
  const text = parts.every((a) => a.windows.length === parts[0].windows.length) ? n(parts[0]) : parts.map((a) => `${a.channel === 'shopee' ? 'Shopee' : 'Lazada'} ${n(a)}`).join(', ');
  return {spend, roas, tag: {kind: every ? 'ex' : 'wk', text}};
}

/** Totals over the given channels: only channels that have revenue and orders count; AOV is revenue / orders. */
export function sumTotals(channels: readonly ChannelPeriod[]): SalesRangeView['totals'] {
  const live = channels.filter((c) => c.revenue !== null && c.orders !== null);
  const revenue = live.length ? round2(live.reduce((s, c) => s + (c.revenue as number), 0)) : null;
  const orders = live.length ? live.reduce((s, c) => s + (c.orders as number), 0) : null;
  const unitsKnown = live.length > 0 && live.every((c) => c.units !== null);
  return {revenue, orders, aov: revenue !== null && orders ? round2(revenue / orders) : null, units: unitsKnown ? live.reduce((s, c) => s + (c.units as number), 0) : null};
}

/** What the rollup needs from POS orders: the orders and the first and last PH day that has one. */
export function offlineInput(orders: readonly PosOrder[] | null): SalesRangeInput['offline'] {
  if (!orders) return null;
  const days = orders.map((o) => manilaDayKey(o.created_at)).sort();
  return {orders, dataFrom: days[0] ?? null, dataTo: days[days.length - 1] ?? null};
}

export function buildSalesRange(input: SalesRangeInput): SalesRangeView {
  const {firstDay, todayDay} = input;
  const span = resolveSpan(input.span, {firstDay, todayDay});
  const {fromDay, toDay} = span;
  const [min, max] = [firstDay, todayDay];

  const channels = rollupChannels({fromDay, toDay, channels: ROLLUP_CHANNELS, granularity: 'total', digests: input.digests, website: input.website, offline: input.offline})[0].channels;
  const totals = sumTotals(channels);

  const shopeeAds = spanAds('shopee', fromDay, toDay, input.digests);
  const lazadaAds = spanAds('lazada', fromDay, toDay, input.digests);
  const ads = {shopee: shopeeAds, lazada: lazadaAds, total: adsTotals([shopeeAds, lazadaAds], fromDay, toDay)};
  const shopee = spanTopProducts('shopee', fromDay, toDay, input.digests);
  const lazada = spanTopProducts('lazada', fromDay, toDay, input.digests);
  const range = {from: new Date(phDayStart(fromDay)).toISOString(), to: new Date(phDayStart(toDay) + DAY_MS).toISOString()};
  const website: ProductRow[] = input.website ? websiteRangeMetrics([...input.website.orders], range, 5).topProducts.map((p: {title: string; units: number; revenue: number}): ProductRow => ({title: p.title, revenue: p.revenue, units: p.units})) : [];

  const snap = snapToWeeks(fromDay, toDay, {firstDay, todayDay});
  const prevSpan = previousSpan(fromDay, toDay, firstDay);
  const previous: PreviousView | null = prevSpan
    ? {
        ...prevSpan,
        label: rangeLabel(prevSpan.fromDay, prevSpan.toDay),
        channels: rollupChannels({fromDay: prevSpan.fromDay, toDay: prevSpan.toDay, channels: ROLLUP_CHANNELS, granularity: 'total', digests: input.digests, website: input.website, offline: input.offline})[0].channels,
        ads: {shopee: spanAds('shopee', prevSpan.fromDay, prevSpan.toDay, input.digests), lazada: spanAds('lazada', prevSpan.fromDay, prevSpan.toDay, input.digests)},
      }
    : null;
  const series = buildSeries({fromDay, toDay, digests: input.digests, website: input.website, offline: input.offline});
  const uniq = (xs: (string | null)[]): string[] => [...new Set(xs.filter((n): n is string => Boolean(n)))];
  const gaps = channels.filter((c) => c.status !== 'ok');
  const notes = uniq([span.note, ...gaps.flatMap((c) => c.notes), ...ads.shopee.warnings, ...ads.lazada.warnings, ...shopee.warnings, ...lazada.warnings]);
  const sources = uniq([...channels.filter((c) => c.status === 'ok').flatMap((c) => c.notes), ...[ads.shopee, ads.lazada, shopee, lazada].flatMap((x) => x.notes.filter((n) => !x.warnings.includes(n)))]);
  return {
    fromDay,
    toDay,
    label: rangeLabel(fromDay, toDay),
    dayCount: dayKeysBetween(fromDay, toDay).length,
    all: span.all,
    snap: snap ? {...snap, label: rangeLabel(snap.fromDay, snap.toDay)} : null,
    bounds: {min, max},
    channels,
    totals,
    ads,
    products: {website, shopee, lazada},
    previous,
    series,
    notes,
    sources,
  };
}

