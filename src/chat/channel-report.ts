// get_channel_report (spec F.6): the model's request is validated here; the figures come from src/period-rollup.ts (code, never the
// model); the result is a MetricResult the render tools can draw. Pure: digests, CRM orders and POS data are injected.
import {phDayStart} from '../custom-range';
import {sameWindow, windowOf} from '../digest-windows';
import {buckets, CHANNEL_LABEL, GRANULARITIES, ROLLUP_CHANNELS, rollupChannels, type Granularity, type RollupChannel, type RollupInput} from '../period-rollup';
import {buildCoverage} from './coverage';
import type {DigestSource} from './digest-lookup';
import {dayKeysBetween, isRealDay, rangeLabel} from './range';
import type {DigestRow} from './read/digest';
import type {Check, MeasureDecl, MetricData, MetricError, MetricResult, MetricRow, ResultColumn} from './result-types';

export const REPORT_CHANNELS = ['all', ...ROLLUP_CHANNELS] as const;
export interface ChannelReportRequest {
  from: string;
  to: string;
  channels: RollupChannel[];
  granularity: Granularity;
}
export interface ReportSources {
  /** Stored digests (rows), or null when they could not be read. */
  digests: readonly DigestRow[] | null;
  mock: boolean;
  website: RollupInput['website'];
  data: MetricData | null;
  /** The CRM is connected but the read failed: Website says so instead of "not connected". */
  websiteFailed?: boolean;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;
const MAX_BUCKETS: Record<Exclude<Granularity, 'total'>, number> = {week: 27, month: 13}; // 26 weeks or 12 months, plus a clipped edge
const MAX_EXTRA_ROWS = 12;
const MAX_NOTES = 16;
const fail = (error: string): MetricError => ({error});
const col = (key: string, label: string, unit: ResultColumn['unit'], role: ResultColumn['role']): ResultColumn => ({key, label, unit, role});

const SOURCES = 'Shopee and Lazada from the digests\' per-day sales (newest digest wins per day; a day inside a digest with no sales is a zero), Website from live CRM orders, Offline from completed POS orders';
const BASIS = `Built in code: ${SOURCES}. AOV is revenue / orders of the totals. Say every coverage note below before any figure, and name the dates.`;
const REVENUE: MeasureDecl = {key: 'revenue', label: 'Revenue', kind: 'measured', unit: 'PHP', method: `Summed per channel: ${SOURCES}.`};
const ORDERS: MeasureDecl = {key: 'orders', label: 'Orders', kind: 'measured', unit: 'count', method: 'Orders summed over the same days.'};
const UNITS: MeasureDecl = {key: 'units', label: 'Units', kind: 'measured', unit: 'units', method: 'Units summed over the same days; null when a whole published window had no unit count.'};
const AOV: MeasureDecl = {key: 'aov', label: 'Average order value', kind: 'derived', unit: 'PHP', method: 'Revenue / orders of the summed totals, never an average of averages.'};

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
export async function digestsFor(src: DigestSource, from: string, to: string): Promise<DigestRow[]> {
  const lo = phDayStart(from);
  const hi = phDayStart(to) + 86_400_000;
  const missing = (src.index ?? [])
    .filter((w) => Date.parse(w.from) < hi && Date.parse(w.to) > lo && !src.rows.some((r) => sameWindow(windowOf(r), w)))
    .slice(0, MAX_EXTRA_ROWS);
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
    for (const b of out) for (const p of b.channels) if (p.channel === 'website' && p.status === 'not_connected') p.notes = ['Website: the CRM could not be read right now; no website figures.'];
  }
  const total = req.granularity === 'total';
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
