// get_channel_report (spec F.6): the model's request is validated here; the figures come from src/period-rollup.ts (code, never the
// model); the result is a MetricResult the render tools can draw. Pure: digests, CRM orders and POS data are injected.
import {phDayStart} from '../custom-range';
import {sameWindow, windowOf} from '../digest-windows';
import {buckets, CHANNEL_LABEL, type ChannelPeriod, type RollupDigest, GRANULARITIES, ROLLUP_CHANNELS, rollupChannels, type Granularity, type RollupChannel, type RollupInput} from '../period-rollup';
import {formatPeso} from '../pos-format';
import {buildCoverage} from './coverage';
import type {DigestSource} from './digest-lookup';
import {dayKeysBetween, isRealDay, rangeLabel} from './range';
import type {DigestRow} from './read/digest';
import type {ChannelTotal, Check, MeasureDecl, MetricData, MetricError, MetricResult, MetricRow, ResultColumn} from './result-types';

export const REPORT_CHANNELS = ['all', ...ROLLUP_CHANNELS] as const;
export interface ChannelReportRequest {
  from: string;
  to: string;
  channels: RollupChannel[];
  granularity: Granularity;
}
export interface ReportSources {
  /** Stored digests (rows), or null when they could not be read. */
  digests: readonly RollupDigest[] | null;
  mock: boolean;
  website: RollupInput['website'];
  data: MetricData | null;
  /** The CRM is connected but the read failed: Website says so instead of "not connected". */
  websiteFailed?: boolean;
  /** Why the CRM read failed, as a safe class (never a URL, token or upstream text). */
  websiteReason?: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;
const MAX_BUCKETS: Record<Exclude<Granularity, 'total'>, number> = {week: 27, month: 13}; // 26 weeks or 12 months, plus a clipped edge
const MAX_EXTRA_ROWS = 12;
const MAX_NOTES = 16;
const fail = (error: string): MetricError => ({error});
const col = (key: string, label: string, unit: ResultColumn['unit'], role: ResultColumn['role']): ResultColumn => ({key, label, unit, role});

const SOURCES = 'Shopee and Lazada from saved per-day sales rows (imported from the exports and the Lazada API) and the digests\' per-day sales (newest digest wins per day; a day inside a digest with no sales is a zero), Website from live CRM orders, Offline from completed POS orders';
const BASIS = `Built in code: ${SOURCES}. AOV is revenue / orders of the totals. Say every coverage note below before any figure, and name the dates.`;
const REVENUE: MeasureDecl = {key: 'revenue', label: 'Revenue', kind: 'measured', unit: 'PHP', method: `Summed per channel: ${SOURCES}.`};
const ORDERS: MeasureDecl = {key: 'orders', label: 'Orders', kind: 'measured', unit: 'count', method: 'Orders summed over the same days.'};
const UNITS: MeasureDecl = {key: 'units', label: 'Units', kind: 'measured', unit: 'units', method: 'Units summed over the same days; null when a whole published window had no unit count.'};
const AOV: MeasureDecl = {key: 'aov', label: 'Average order value', kind: 'derived', unit: 'PHP', method: 'Revenue / orders of the summed totals, never an average of averages.'};

const ONLINE: readonly RollupChannel[] = ['shopee', 'lazada', 'website'];
const WHY: Record<ChannelPeriod['status'], string> = {
  ok: '',
  partial: 'only part of these dates is covered',
  not_combinable: 'its published windows do not line up with these dates',
  no_data: 'has no figures for these dates',
  not_connected: 'is not connected',
};
const names = (cs: readonly string[]): string => (cs.length <= 1 ? cs.join('') : `${cs.slice(0, -1).join(', ')} and ${cs[cs.length - 1]}`);

/**
 * One cross-channel total over the given channel periods, in WHOLE CENTAVOS (integer sums, no float drift). Owner defaults 2026-10-22: a total
 * counts only channels whose figures are complete for the dates (status ok, with revenue and orders); any other requested channel is named as
 * left out and makes the total `partial`, never silently included. AOV is revenue / orders of the totals. Units are null if any included
 * channel has no unit count. Ad spend and ROAS are not totalled here (the report carries no ad revenue to recompute ROAS from).
 */
export function totalOf(label: string, periods: readonly ChannelPeriod[]): ChannelTotal {
  const used = periods.filter((p) => p.status === 'ok' && p.revenue !== null && p.orders !== null);
  const left = periods.filter((p) => !used.includes(p));
  const cents = used.reduce((s, p) => s + Math.round((p.revenue as number) * 100), 0);
  const orders = used.reduce((s, p) => s + (p.orders as number), 0);
  const unitsKnown = used.length > 0 && used.every((p) => p.units !== null);
  const included = used.map((p) => CHANNEL_LABEL[p.channel]);
  const excluded = left.map((p) => ({channel: CHANNEL_LABEL[p.channel], reason: WHY[p.status] || 'has no complete figures'}));
  const complete = used.length > 0 && left.length === 0;
  const why = excluded.map((e) => `${e.channel} ${e.reason}`).join('; ');
  // `ok` is all-or-nothing for a marketplace: marketplace() in period-rollup.ts gives `ok` only when per-day rows or whole published windows
  // (tile(), which returns null unless it covers every missing day exactly once) cover the dates, and `partial` otherwise. So `ok` is safe to trust here.
  // The channels do not share a source though: Website is live CRM orders as of now, Shopee and Lazada are saved daily rows and published digests.
  const basis = used.some((p) => p.channel === 'website') && used.length > 1 ? ' Website figures are live CRM orders while Shopee and Lazada come from saved daily rows and published digests, so say the total is not like for like.' : '';
  const figure = used.length ? `${formatPeso(cents / 100)} revenue from ${orders} ${orders === 1 ? 'order' : 'orders'}` : '';
  const note =
    used.length === 0
      ? `No total: no requested channel has complete figures for these dates (${why}).`
      : complete
        ? `${label}: ${names(included)}: ${figure}, calculated in code.${unitsKnown ? '' : ' Units are left out because a channel has no unit count.'}${basis}`
        : `Partial total of ${names(included)}: ${figure}. Left out: ${why}. Say it is partial, quote this revenue and name what is missing.${basis}`;
  return {
    label,
    channels_included: included,
    channels_excluded: excluded,
    status: complete ? 'complete' : 'partial',
    revenue: used.length ? cents / 100 : null,
    orders: used.length ? orders : null,
    units: unitsKnown ? used.reduce((s, p) => s + (p.units as number), 0) : null,
    aov: used.length && orders > 0 ? Math.round(cents / orders) / 100 : null,
    note,
    calculated_in_code: true,
  };
}

/** The totals for a granularity 'total' report: over every requested channel, and an online-only total when Offline is also requested. */
export function reportTotals(requested: readonly RollupChannel[], periods: readonly ChannelPeriod[]): ChannelTotal[] {
  const mine = periods.filter((p) => requested.includes(p.channel));
  if (mine.length < 2) return [];
  const all = totalOf(requested.length === ROLLUP_CHANNELS.length ? 'All channels' : 'Total of the requested channels', mine);
  const online = mine.filter((p) => ONLINE.includes(p.channel));
  return requested.includes('offline') && online.length >= 2 ? [totalOf('Online total', online), all] : [all];
}

/** The model's input as a request, or a steering error. The dates are the OWNER's: without them it asks for them. */
export function readReportInput(input: unknown): ChannelReportRequest | MetricError {
  const o = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const from = typeof o.from === 'string' ? o.from : '';
  const to = typeof o.to === 'string' ? o.to : '';
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to)) {
    return fail('A channel report needs the owner\'s dates. Ask them for a start and an end date (for example "September" or "1 Sep to 30 Sep"), then call again with from and to as YYYY-MM-DD. Do not pick dates yourself.');
  }
  for (const d of [from, to]) {
    if (!isRealDay(d)) return fail(`${d} is not a real date; ask the owner for the dates again.`);
  }
  if (from > to) return fail('from is after to. Ask the owner for the dates again.');
  if (dayKeysBetween(from, to).length > MAX_DAYS) return fail(`That is more than ${MAX_DAYS} days. Ask the owner for a shorter range.`);
  const g = typeof o.granularity === 'string' && (GRANULARITIES as readonly string[]).includes(o.granularity) ? (o.granularity as Granularity) : null;
  if (!g) return fail(`granularity ${JSON.stringify(o.granularity ?? null)} is not allowed. Allowed values: ${GRANULARITIES.join(', ')}.`);
  const raw = Array.isArray(o.channels) ? o.channels : [];
  if (raw.length === 0 || raw.some((c) => typeof c !== 'string' || !(REPORT_CHANNELS as readonly string[]).includes(c))) {
    return fail(`channels must be a list of: ${REPORT_CHANNELS.join(', ')} (["all"] for every channel).`);
  }
  const channels = raw.includes('all') ? [...ROLLUP_CHANNELS] : ROLLUP_CHANNELS.filter((c) => raw.includes(c));
  if (g !== 'total') {
    const n = buckets(from, to, g).length;
    if (n > MAX_BUCKETS[g]) return fail(`That is ${n} ${g}s; the limit is ${MAX_BUCKETS[g]}. Ask the owner for a shorter range, or use granularity "total".`);
  }
  return {from, to, channels, granularity: g};
}

/** The loaded digests plus any stored window touching from..to that is not loaded yet (an older one), so coverage is never understated. */
export async function digestsFor(src: DigestSource, from: string, to: string, cap = MAX_EXTRA_ROWS): Promise<DigestRow[]> {
  const lo = phDayStart(from);
  const hi = phDayStart(to) + 86_400_000;
  const missing = (src.index ?? [])
    .filter((w) => Date.parse(w.from) < hi && Date.parse(w.to) > lo && !src.rows.some((r) => sameWindow(windowOf(r), w)))
    .slice(0, cap);
  const rowAt = src.rowAt;
  if (!rowAt || missing.length === 0) return src.rows;
  const extra = await Promise.all(missing.map((w) => rowAt(w).catch(() => null)));
  return [...src.rows, ...extra.filter((r): r is DigestRow => r !== null)];
}

export function shapeChannelReport(req: ChannelReportRequest, src: ReportSources): MetricResult {
  const cover = src.data ? buildCoverage(src.data) : null;
  const out = rollupChannels({
    fromDay: req.from,
    toDay: req.to,
    channels: req.channels,
    granularity: req.granularity,
    digests: src.digests,
    website: src.website,
    offline: src.data ? {orders: src.data.orders, dataFrom: cover?.dataFrom ?? null, dataTo: cover?.dataTo ?? null} : null,
  });
  if (src.websiteFailed) {
    for (const b of out) for (const p of b.channels) if (p.channel === 'website' && p.status === 'not_connected') p.notes = [`Website: the CRM could not be read right now; no website figures.${src.websiteReason ? ` Reason: ${src.websiteReason}.` : ''}`];
  }
  const total = req.granularity === 'total';
  const totals = total ? reportTotals(req.channels, out[0].channels) : []; // per-bucket totals are not built: ask granularity "total"
  const columns: ResultColumn[] = total
    ? [col('channel', 'Channel', 'text', 'category'), col('revenue', 'Revenue', 'PHP', 'measure'), col('orders', 'Orders', 'count', 'measure'), col('units', 'Units', 'units', 'measure'), col('aov', 'Average order value', 'PHP', 'measure')]
    : [col('period', req.granularity === 'week' ? 'Week starting' : 'Month starting', 'date', 'time'), ...req.channels.map((c) => col(c, CHANNEL_LABEL[c], 'PHP', 'measure'))];
  const rows: MetricRow[] = total
    ? out[0].channels.map((p) => ({channel: CHANNEL_LABEL[p.channel], revenue: p.revenue, orders: p.orders, units: p.units, aov: p.aov}))
    : out.map((b) => ({period: b.fromDay, ...Object.fromEntries(b.channels.map((p) => [p.channel, p.revenue]))}));

  const checks: Check[] = [];
  if (src.mock || src.data?.source === 'mock') checks.push({code: 'mock_source', status: 'warn', text: 'These are built-in sample figures, not real ones.'});
  checks.push({code: 'partial_coverage', status: 'info', text: BASIS});
  const seen = new Set<string>();
  const notes: Check[] = [];
  for (const b of out) {
    for (const p of b.channels) {
      for (const n of p.notes) {
        const text = total ? n : `${b.label}: ${n}`;
        if (seen.has(text)) continue;
        seen.add(text);
        notes.push({code: 'partial_coverage', status: p.status === 'ok' ? 'info' : 'warn', text});
      }
    }
  }
  checks.push(...notes.slice(0, MAX_NOTES));
  if (notes.length > MAX_NOTES) checks.push({code: 'partial_coverage', status: 'warn', text: `${notes.length - MAX_NOTES} more coverage notes were left out; ask for a shorter range to see them.`});
  const full = out.every((b) => b.channels.every((p) => p.status === 'ok'));
  const measures = total ? [REVENUE, ORDERS, UNITS, AOV] : req.channels.map((c): MeasureDecl => ({...REVENUE, key: c, label: `${CHANNEL_LABEL[c]} revenue`}));
  return {
    id: '',
    metric: 'channel_report',
    dimension: req.granularity,
    columns,
    rows,
    meta: {
      source: src.mock ? 'mock' : 'live',
      range: {from: req.from, to: req.to, label: rangeLabel(req.from, req.to)},
      dataFrom: req.from,
      dataTo: req.to,
      rowCount: rows.length,
      ...(totals.length ? {totals} : {}),
      coverage: full ? 'full' : 'partial',
      coveredFrom: req.from,
      coveredTo: req.to,
      caveats: checks.map((c) => c.text),
      share_basis: null,
      measure: total ? 'revenue' : req.channels[0],
      measures,
      insights: [],
      checks,
      reliable: true,
    },
  };
}
