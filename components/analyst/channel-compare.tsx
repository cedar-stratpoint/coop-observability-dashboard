'use client';

// Unified channel Overview — merges Shopee / Lazada / Website into one view with a
// channel filter, an apples-to-apples comparison chart, combined KPIs, and merged
// (channel-tagged) recommendations. Single-channel selection drills into that
// channel's full detail. Comparison numbers are read from each channel's existing
// figures (label-matched) — interim until the batch emits a normalized summary.
import {useMemo, useState} from 'react';
import Link from 'next/link';
import {ArrowLeft, Check, Globe, Search, Store} from 'lucide-react';
import type {DigestArchiveRow, DigestFigure, DigestRec} from '../../src/types';
import type {AnalystBrief} from '../../src/salesSignals';
import {cn} from '@/lib/utils';
import {metricValueClass} from './metric';
import {Card, CardContent} from '@/components/ui/card';
import {Sparkles} from 'lucide-react';
import {ShopeeIcon, LazadaIcon} from './brand-icons';
import {usePlaybook, usePlaybookProgress, recAction, recSteps, recIsComplete} from './playbook';
import {InfoTip} from './info-tip';
import {fmtRange, hasNoSalesData} from '../../src/week';
import {ShopeeSection, LazadaSection, SalesSection, CustomersSection, ConversationsSection} from './sections';

export type Channel = 'shopee' | 'lazada' | 'website' | 'offline';
const CHANNELS: {key: Channel; label: string; icon: React.ComponentType<{className?: string; style?: React.CSSProperties}>; accent: string}[] = [
  {key: 'shopee', label: 'Shopee', icon: ShopeeIcon, accent: '#ee4d2d'},
  {key: 'lazada', label: 'Lazada', icon: LazadaIcon, accent: '#2f6bd4'},
  {key: 'website', label: 'Website', icon: Globe, accent: 'var(--primary)'},
  {key: 'offline', label: 'Offline', icon: Store, accent: '#c9873f'},
];
const CH = Object.fromEntries(CHANNELS.map((c) => [c.key, c])) as Record<Channel, (typeof CHANNELS)[number]>;

// ── metric extraction (interim: read from each channel's existing figures) ───────
type Metric = 'revenue' | 'orders' | 'aov' | 'units' | 'adSpend' | 'roas';
const METRICS: {key: Metric; label: string; money?: boolean; ratio?: boolean}[] = [
  {key: 'adSpend', label: 'Ad spend', money: true},
  {key: 'roas', label: 'ROAS', ratio: true},
  {key: 'revenue', label: 'Revenue', money: true},
  {key: 'orders', label: 'Orders'},
  {key: 'aov', label: 'AOV', money: true},
  {key: 'units', label: 'Units'},
];
// Per-metric "where this comes from" copy for the ⓘ tooltip.
const METRIC_HINTS: Record<Metric, string> = {
  adSpend: 'Ad spend per channel. Shopee & Lazada from their on-platform ad reports; Website (Meta) isn’t connected, so it reads 0.',
  roas: 'Return on ad spend = ad revenue ÷ ad spend. Higher is better; channels with no ad spend show 0.',
  revenue: 'Net revenue per channel for this period (excludes cancellations/returns).',
  orders: 'Orders per channel for this period.',
  aov: 'Average order value = each channel’s revenue ÷ its orders.',
  units: 'Units sold per channel. Shopee doesn’t report units in its sales export, so it’s omitted.',
};

function figVal(figs: DigestFigure[] | undefined, re: RegExp, exclude?: RegExp): number | null {
  const f = (figs ?? []).find((x) => re.test(x.label) && (!exclude || !exclude.test(x.label)));
  return f ? f.value : null;
}
type ChannelMetrics = Record<Metric, number | null>;

/** A custom date range inside the period, resolved server-side (app/page.tsx). */
// shopee/lazada: summed from the digest's per-day series; undefined when the row
// has none (then they're full-period only), null when no sales fall in the range.
export type CustomView = {
  label: string;
  metrics: ChannelMetrics | null;
  topProducts: {title: string; revenue: number; units?: number}[];
  shopee?: ChannelMetrics | null;
  lazada?: ChannelMetrics | null;
};
// Marketplaces whose top products are whole-period digest lists (no per-day products).
const FULL_PERIOD_ONLY: Channel[] = ['shopee', 'lazada'];
/** Marketplaces that can't follow this custom range (the row has no per-day series). */
const fullPeriodOnly = (custom?: CustomView | null): Channel[] =>
  custom ? FULL_PERIOD_ONLY.filter((c) => custom[c as 'shopee' | 'lazada'] === undefined) : [];
// A custom range with no sales is an empty stretch of days, not missing data.
const noSalesOnDays = (cs: Channel[], custom?: CustomView | null) => {
  const names = cs.filter((c) => !fullPeriodOnly(custom).includes(c)).map((c) => CH[c].label);
  return names.length ? `No ${names.join(' or ')} sales on these days.` : 'No sales on these days.';
};
const fullOnlyNote = (cs: Channel[]) => `${cs.map((c) => CH[c].label).join(' and ')} only report full-period totals, so they're left out for custom dates.`;

function channelMetrics(row: DigestArchiveRow): Record<Channel, ChannelMetrics | null> {
  const d = row.digest;
  // Preferred: the batch's stamped, normalized comparison numbers (facts — no
  // label matching). Falls back to figure label-matching for pre-stamp archives.
  const c = d.comparison;
  if (c) {
    // Derive AOV = revenue ÷ orders from the SAME figures we display, so a
    // channel's AOV always reconciles with its revenue and orders (and the
    // blended KPI is their weighted blend) — never a divergent stamped basis.
    const pick = (m?: {revenue: number | null; orders: number | null; aov: number | null; units: number | null; adSpend: number | null; roas: number | null}) =>
      m
        ? {
            revenue: m.revenue,
            orders: m.orders,
            aov: m.revenue != null && m.orders ? Math.round((m.revenue / m.orders) * 100) / 100 : m.aov,
            units: m.units,
            adSpend: m.adSpend,
            roas: m.roas,
          }
        : null;
    return {shopee: pick(c.shopee), lazada: pick(c.lazada), website: pick(c.website), offline: null};
  }
  const sh = d.shopee?.sales?.figures;
  const lz = d.lazada?.sales?.figures;
  const wb = d.sales?.figures;
  const shAds = d.shopee?.ads?.figures;
  return {
    shopee: d.shopee?.sales
      ? {revenue: figVal(sh, /^sales\s*(₱|php)/i), orders: figVal(sh, /buyers/i), aov: figVal(sh, /per buyer/i), units: null, adSpend: figVal(shAds, /ad spend/i), roas: figVal(shAds, /^roas\b/i, /direct/i)}
      : null,
    lazada: d.lazada?.sales
      ? {revenue: figVal(lz, /net revenue/i), orders: figVal(lz, /net orders/i), aov: figVal(lz, /aov/i), units: figVal(lz, /units/i), adSpend: figVal(d.lazada?.ads?.figures, /ad spend|spend/i), roas: figVal(d.lazada?.ads?.figures, /^roas\b/i, /direct/i)}
      : null,
    website: d.sales
      ? {revenue: figVal(wb, /net revenue/i), orders: figVal(wb, /orders/i, /trend|%/i), aov: figVal(wb, /aov/i), units: figVal(wb, /units/i), adSpend: null, roas: null}
      : null,
    offline: null, // filled from pos_orders (passed into ChannelOverview), not the digest
  };
}

const money = (n: number) => `₱${n.toLocaleString(undefined, {maximumFractionDigits: n < 100 ? 2 : 0})}`;
const fmt = (m: Metric, n: number) => {
  const meta = METRICS.find((x) => x.key === m);
  if (meta?.ratio) return `${n.toFixed(2)}×`;
  return meta?.money ? money(n) : n.toLocaleString();
};

// ── comparison chart ─────────────────────────────────────────────────────────────
function ComparisonChart({metrics, channels, metric, setMetric, custom}: {metrics: Record<Channel, ChannelMetrics | null>; channels: Channel[]; metric: Metric; setMetric: (m: Metric) => void; custom?: CustomView | null}) {
  // Ad-spend / ROAS: show every channel with a value of 0 when it has no spend
  // (rather than dropping it), so the comparison reads at a glance. Not under a
  // custom range: no channel has per-day ad data, so a 0 there would be false.
  const isAdMetric = metric === 'adSpend' || metric === 'roas';
  const rows = channels
    .map((c) => {
      const raw = metrics[c]?.[metric] ?? null;
      return {c, value: raw == null && isAdMetric && !custom ? 0 : raw};
    })
    .filter((r): r is {c: Channel; value: number} => r.value != null);
  const max = Math.max(1, ...rows.map((r) => r.value));

  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-foreground/80">
            Compare channels <InfoTip text={METRIC_HINTS[metric]} />
          </div>
          <div className="max-md:-mx-1 max-md:overflow-x-auto max-md:px-1">
          <div
            className="relative grid rounded-xl border border-border bg-muted/40 p-1 max-md:min-w-[468px]"
            style={{gridTemplateColumns: `repeat(${METRICS.length}, minmax(0, 1fr))`}}
          >
            {/* liquid-glass sliding indicator — springs to the active metric */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-1 left-1 rounded-lg bg-primary shadow-sm"
              style={{
                width: `calc((100% - 0.5rem) / ${METRICS.length})`,
                transform: `translateX(${Math.max(0, METRICS.findIndex((m) => m.key === metric)) * 100}%)`,
                transition: 'transform 600ms cubic-bezier(0.34, 1.56, 0.64, 1)',
              }}
            />
            {METRICS.map((m) => (
              <button
                key={m.key}
                onClick={() => setMetric(m.key)}
                className={cn(
                  'relative z-10 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[12px] font-semibold transition-colors duration-300',
                  metric === m.key ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {custom ? (isAdMetric ? 'Ad spend and ROAS are only reported for the full period.' : noSalesOnDays(channels, custom)) : 'No data for this metric in the selected channels.'}
          </p>
        ) : (
          <>
          {/* Columns flex to share the panel width (min-w-0 so they can shrink),
              so 2–4 channels always fit at any zoom; the bar itself is capped so
              it never balloons when only a couple of channels are selected. */}
          <div
            className="flex items-end gap-3 border-b border-border pt-1 sm:gap-6"
            style={{
              height: 168,
              // faint horizontal gridlines for a sense of scale
              backgroundImage:
                'repeating-linear-gradient(to top, transparent 0, transparent 41px, color-mix(in oklab, var(--border) 55%, transparent) 41px, color-mix(in oklab, var(--border) 55%, transparent) 42px)',
            }}
          >
            {rows.map(({c, value}) => {
              const meta = CH[c];
              return (
                <div key={c} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
                  <div className="max-w-full truncate text-[15px] font-semibold tabular-nums text-foreground">{fmt(metric, value)}</div>
                  <div
                    className="w-full max-w-[112px] rounded-t-xl shadow-sm transition-all"
                    style={{
                      height: Math.max(6, (value / max) * 130),
                      backgroundImage: `linear-gradient(180deg, ${meta.accent} 0%, color-mix(in oklab, ${meta.accent} 72%, white) 100%)`,
                    }}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex gap-3 pt-2.5 sm:gap-6">
            {rows.map(({c}) => {
              const meta = CH[c];
              const Icon = meta.icon;
              return (
                <div key={c} className="flex min-w-0 flex-1 items-center justify-center gap-1.5 text-[13px] font-medium text-foreground">
                  <Icon className="size-4 shrink-0" style={{color: meta.accent}} /> <span className="truncate">{meta.label}</span>
                </div>
              );
            })}
          </div>
          </>
        )}
        {(() => {
          // Under a custom range, Lazada/Shopee are omitted because they only have
          // whole-period totals — say that instead of "no data".
          const fullOnly = channels.filter((c) => fullPeriodOnly(custom).includes(c));
          // Ad spend / ROAS under custom dates: the centred message already explains.
          if (custom && isAdMetric) return null;
          const omitted = channels.filter((c) => !rows.some((r) => r.c === c) && !fullOnly.includes(c));
          if (fullOnly.length && !omitted.length)
            return <p className="mt-3 text-[11px] text-muted-foreground">{fullOnlyNote(fullOnly)}</p>;
          if (!omitted.length) return null;
          // Custom range, nothing to chart: the centred message already says the days were empty.
          if (custom && !rows.length) return fullOnly.length ? <p className="mt-3 text-[11px] text-muted-foreground">{fullOnlyNote(fullOnly)}</p> : null;
          const names = omitted.map((c) => CH[c].label).join(', ');
          const why = custom
            ? noSalesOnDays(omitted, custom)
            : metric === 'units'
              ? `Shopee doesn’t report units in its sales export, so it’s omitted here.`
              : `No ${METRICS.find((m) => m.key === metric)?.label.toLowerCase()} data for ${names} in this window.`;
          return <p className="mt-3 text-[11px] text-muted-foreground">{why}{fullOnly.length ? ` ${fullOnlyNote(fullOnly)}` : ''}</p>;
        })()}
      </CardContent>
    </Card>
  );
}

// ── combined KPIs (for selected channels) ────────────────────────────────────────
function KpiDelta({cur, prior, range}: {cur: number; prior: number | null; range: string | null}) {
  if (prior == null || prior === 0 || !Number.isFinite(cur)) return null;
  const pct = ((cur - prior) / prior) * 100;
  if (!Number.isFinite(pct)) return null;
  const flat = Math.abs(pct) < 0.5;
  const up = pct > 0;
  const color = flat ? 'var(--muted-foreground)' : up ? 'var(--status-good)' : 'var(--status-crit)';
  return (
    <span
      className="inline-flex items-center gap-0.5 text-[11px] font-semibold tabular-nums"
      style={{color}}
      title={range ? `vs ${range}` : 'vs previous period'}
    >
      {flat ? '±' : up ? '▲' : '▼'} {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

function CombinedKpis({
  metrics,
  priorMetrics,
  priorRange,
  channels,
}: {
  metrics: Record<Channel, ChannelMetrics | null>;
  priorMetrics?: Record<Channel, ChannelMetrics | null> | null;
  priorRange?: string | null;
  channels: Channel[];
}) {
  const sumOf = (src: Record<Channel, ChannelMetrics | null> | null | undefined, m: Metric, chans: Channel[] = channels) =>
    src ? chans.reduce((a, c) => a + (src[c]?.[m] ?? 0), 0) : 0;
  // Displayed totals include every selected channel (offline included).
  const revenue = sumOf(metrics, 'revenue');
  const orders = sumOf(metrics, 'orders');
  const aov = orders ? revenue / orders : 0;

  // Period-over-period delta is like-for-like: compare only channels that exist
  // in BOTH periods. Offline has no prior-window data (it isn't in the weekly
  // digest), so including it would inflate every delta against a permanent zero
  // baseline. With offline absent this set == channels, so the arrows are
  // byte-identical to before. The big totals above still include offline.
  const cmp = priorMetrics ? channels.filter((c) => priorMetrics[c] != null) : channels;
  const cRevenue = sumOf(metrics, 'revenue', cmp);
  const cOrders = sumOf(metrics, 'orders', cmp);
  const cAov = cOrders ? cRevenue / cOrders : 0;
  const pRevenue = priorMetrics ? sumOf(priorMetrics, 'revenue', cmp) : null;
  const pOrders = priorMetrics ? sumOf(priorMetrics, 'orders', cmp) : null;
  const pAov = priorMetrics && pOrders ? (pRevenue as number) / pOrders : null;

  const tiles = [
    {label: 'Total revenue', value: money(revenue), cur: cRevenue, prior: pRevenue, hint: 'Sum of net revenue across the selected channels for this period. The trend compares only channels with prior-period data.'},
    {label: 'Total orders', value: orders.toLocaleString(), cur: cOrders, prior: pOrders, hint: 'Sum of orders across the selected channels for this period. The trend compares only channels with prior-period data.'},
    // Weighted blend — total revenue ÷ total orders — NOT the average of per-channel AOVs.
    {label: 'Blended AOV', value: money(aov), cur: cAov, prior: pAov, hint: 'Total revenue ÷ total orders (a weighted blend — not the simple average of each channel’s AOV).'},
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-7 gap-y-3 sm:gap-x-9">
      {tiles.map((t, i) => (
        <div key={t.label} className={cn('flex flex-col', i > 0 && 'sm:border-l sm:border-border/70 sm:pl-7 md:pl-9')}>
          <span className="flex items-center gap-1 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-foreground/80">
            {t.label} <InfoTip text={t.hint} />
          </span>
          <span className="flex items-baseline gap-2">
            <span className={cn(metricValueClass, 'text-[23px] text-foreground')}>{t.value}</span>
            <KpiDelta cur={t.cur} prior={t.prior} range={priorRange ?? null} />
          </span>
        </div>
      ))}
    </div>
  );
}

// ── merged, channel-tagged recommendations (left column) ─────────────────────────
function collectRecs(row: DigestArchiveRow, channels: Channel[]): {channel: Channel; rec: DigestRec}[] {
  const d = row.digest;
  const out: {channel: Channel; rec: DigestRec}[] = [];
  const add = (channel: Channel, recs?: DigestRec[]) => (recs ?? []).forEach((rec) => out.push({channel, rec}));
  if (channels.includes('shopee')) for (const f of ['sales', 'ads', 'traffic', 'products'] as const) add('shopee', d.shopee?.[f]?.recommendations);
  if (channels.includes('lazada')) for (const f of ['sales', 'finance', 'inventory', 'ads'] as const) add('lazada', d.lazada?.[f]?.recommendations);
  if (channels.includes('website')) {
    add('website', d.sales?.recommendations);
    add('website', d.customers?.recommendations);
    add('website', d.recommendations);
  }
  return out;
}

// Keywords that mark a recommendation as relevant to the metric currently on the
// chart — used to float the related actions to the top (regardless of channel).
const METRIC_KEYWORDS: Record<Metric, RegExp> = {
  revenue: /revenue|sales|gmv|turnover|top-?line|growth|traffic|visitor|acquisition|discover/i,
  orders: /order|conversion|convert|checkout|cart|placed|click-to-order|visit-to-placed|bounce|funnel|abandon/i,
  aov: /basket|sales-?per-?buyer|per buyer|aov|order value|bundle|voucher|upsell|cross-?sell|add-?on|minimum spend/i,
  units: /unit|stock|inventory|quantity|sku|restock|out of stock|sell-?through/i,
  adSpend: /ad|ads|spend|budget|campaign|acos|cpc|cpm|bid|keyword|sponsored/i,
  roas: /roas|acos|return on ad|ad spend|ads|campaign|bid|budget|margin/i,
};

/** Stable-sort recs so those matching the active metric come first (channel-agnostic). */
function orderRecsByMetric(items: {channel: Channel; rec: DigestRec}[], metric: Metric): {channel: Channel; rec: DigestRec}[] {
  const re = METRIC_KEYWORDS[metric];
  return items
    .map((it, i) => ({it, i, hit: re.test(recAction(it.rec)) ? 0 : 1}))
    .sort((a, b) => a.hit - b.hit || a.i - b.i)
    .map((x) => x.it);
}

function MergedActionCard({channel, rec}: {channel: Channel; rec: DigestRec}) {
  const {open} = usePlaybook();
  const meta = CH[channel];
  const Icon = meta.icon;
  const action = recAction(rec);
  const steps = recSteps(rec);
  const clickable = steps.length > 0;
  const {done, complete} = usePlaybookProgress(action, steps.length);

  const badge = complete ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-primary">
      <Check className="size-3" /> Done
    </span>
  ) : (
    <span className="shrink-0 text-[10.5px] font-medium text-primary">
      {done > 0 ? `${done}/${steps.length} done` : `${steps.length} steps`} →
    </span>
  );

  const body = (
    <CardContent className="px-3.5 py-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
          <Icon className="size-3" style={{color: meta.accent}} /> {meta.label}
        </span>
        {clickable && badge}
      </div>
      <p className="line-clamp-2 text-[13.5px] leading-snug text-foreground/90">{action}</p>
    </CardContent>
  );

  if (!clickable) return <Card className="h-full py-0">{body}</Card>;
  return (
    <Card className="h-full cursor-pointer py-0 transition-all hover:-translate-y-0.5 hover:shadow-md hover:ring-2 hover:ring-primary">
      <button type="button" onClick={() => open({action, steps, label: meta.label})} className="block h-full w-full text-left">
        {body}
      </button>
    </Card>
  );
}

function MergedActions({items}: {items: {channel: Channel; rec: DigestRec}[]}) {
  if (!items.length) return null;
  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      {items.map(({channel, rec}, i) => (
        <MergedActionCard key={i} channel={channel} rec={rec} />
      ))}
    </div>
  );
}

// ── top products by revenue — one ranked list per channel, in a tabbed card ───────
type SkuRow = {title: string; revenue: number; units?: number};

/** Per-SKU ranking for a channel, or [] when that channel has no per-product data. */
function productsFor(row: DigestArchiveRow, c: Channel, custom?: CustomView | null): SkuRow[] {
  if (c === 'offline') return []; // offline's top products live on the Offline Sales page, not the digest
  if (c === 'website' && custom) return custom.topProducts;
  const d = row.digest;
  const raw =
    c === 'shopee'
      ? d.shopee?.sales?.topProducts ?? d.shopee?.products?.topProducts
      : c === 'lazada'
        ? d.lazada?.sales?.topProducts
        : d.sales?.topProducts;
  return [...(raw ?? [])].sort((a, b) => b.revenue - a.revenue).slice(0, 6);
}

function TopProducts({row, channels, custom}: {row: DigestArchiveRow; channels: Channel[]; custom?: CustomView | null}) {
  const sources = channels.map((c) => ({channel: c, meta: CH[c], items: productsFor(row, c, custom)})).filter((s) => s.items.length);
  const [tab, setTab] = useState<Channel | null>(null);
  if (!sources.length) return null;
  // Under custom dates, open on Website — the list that actually follows the range.
  const active = sources.find((s) => s.channel === tab) ?? (custom && sources.find((s) => s.channel === 'website')) ?? sources[0];
  const max = Math.max(1, ...active.items.map((p) => p.revenue));
  // channels selected but without any per-SKU feed yet (e.g. Shopee before its export).
  // Offline is excluded — its per-SKU breakdown lives on the Offline Sales page, not here.
  const missing = channels.filter((c) => c !== 'offline' && !sources.some((s) => s.channel === c));

  return (
    <Card className="py-0">
      <CardContent className="p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-foreground/80">
            Top products by revenue <InfoTip text="Best-selling SKUs by revenue for the selected channel this period. Per-SKU data comes from each channel's product export/API." />
          </div>
          {sources.length > 1 && (
            <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
              {sources.map((s) => {
                const on = s.channel === active.channel;
                const Icon = s.meta.icon;
                return (
                  <button
                    key={s.channel}
                    onClick={() => setTab(s.channel)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                      on ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Icon className="size-3.5" style={{color: on ? undefined : s.meta.accent}} /> {s.meta.label}
                  </button>
                );
              })}
            </div>
          )}
          {sources.length === 1 && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
              <active.meta.icon className="size-3" style={{color: active.meta.accent}} /> {active.meta.label}
            </span>
          )}
        </div>

        <ol className="space-y-4">
          {active.items.map((p, i) => (
            <li key={p.title} className="flex gap-3">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold tabular-nums text-primary-foreground">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                {/* full title on its own line — wraps, never truncated */}
                <p className="mb-1.5 text-[13px] font-medium leading-snug text-foreground">{p.title}</p>
                <div className="flex items-center gap-3">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full transition-all" style={{width: `${(p.revenue / max) * 100}%`, backgroundColor: active.meta.accent}} />
                  </div>
                  <span className="shrink-0 text-[13px] font-semibold tabular-nums text-foreground">
                    {money(p.revenue)}
                    {p.units ? <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">· {p.units.toLocaleString()} units</span> : null}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ol>

        {custom && FULL_PERIOD_ONLY.includes(active.channel) && (
          <p className="mt-3.5 text-[11px] text-muted-foreground">{active.meta.label} covers the full period, not {custom.label}.</p>
        )}
        {missing.length > 0 && (
          <p className="mt-3.5 text-[11px] text-muted-foreground">
            No per-SKU feed yet for {missing.map((c) => CH[c].label).join(', ')}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── single-channel drill-down detail ─────────────────────────────────────────────
function ChannelDetail({channel, row}: {channel: Channel; row: DigestArchiveRow}) {
  if (channel === 'shopee') return <ShopeeSection row={row} />;
  if (channel === 'lazada') return <LazadaSection row={row} />;
  if (channel === 'offline') {
    // Offline has no digest sections (it's not part of the weekly digest). Point
    // to its own page for the full breakdown.
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-2 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Store className="size-4" style={{color: '#c9873f'}} /> Offline · Bazaar
          </div>
          <p className="text-sm text-muted-foreground">
            Bazaar sales synced from the POS. The full breakdown (sales over time, top products, recent orders, stock alerts) lives on its own page.
          </p>
          <Link href="/offline-sales" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
            Open Offline Sales &rarr;
          </Link>
        </CardContent>
      </Card>
    );
  }
  return (
    <>
      <SalesSection row={row} />
      <CustomersSection row={row} />
      <ConversationsSection row={row} />
    </>
  );
}

// ── the unified overview ─────────────────────────────────────────────────────────
export function ChannelOverview({row, priorRow, initialChannels, offline, custom}: {brief: AnalystBrief; row: DigestArchiveRow; priorRow?: DigestArchiveRow | null; initialChannels: Channel[]; offline?: ChannelMetrics | null; custom?: CustomView | null}) {
  const [selected, setSelected] = useState<Channel[]>(initialChannels.length ? initialChannels : ['shopee', 'lazada', 'website']);
  // Default to Revenue (not Ad spend) so every channel — including offline, which
  // has no ad spend — shows a bar on first paint.
  const [metric, setMetric] = useState<Metric>('revenue');
  // Offline metrics come from pos_orders (passed in), merged over the digest-derived
  // channels. Offline has no ad spend / ROAS, so those metric views show it as N-A.
  // A custom range recomputes every channel server-side: Website from CRM orders,
  // Offline from POS orders, Shopee/Lazada from the digest's per-day series. A
  // marketplace without a series (older rows) drops out rather than mix bases.
  const metrics = useMemo(
    () =>
      custom
        ? {shopee: custom.shopee ?? null, lazada: custom.lazada ?? null, website: custom.metrics, offline: offline ?? null}
        : {...channelMetrics(row), offline: offline ?? null},
    [row, offline, custom],
  );
  // No like-for-like prior for an arbitrary range → no deltas.
  const priorMetrics = useMemo(() => (priorRow && !custom ? channelMetrics(priorRow) : null), [priorRow, custom]);
  const priorRange = priorRow ? fmtRange(priorRow.window_from, priorRow.window_to, priorRow.digest.window?.label) : null;
  // Merged recs, reordered so those relevant to the metric on the chart come first.
  const recs = useMemo(() => orderRecsByMetric(collectRecs(row, selected), metric), [row, selected, metric]);
  // Action toolbar: text filter · channel narrow · hide-completed.
  const [recQuery, setRecQuery] = useState('');
  const [recChannel, setRecChannel] = useState<Channel | 'all'>('all');
  const [hideDone, setHideDone] = useState(false);
  const filteredRecs = useMemo(() => {
    const q = recQuery.trim().toLowerCase();
    const chanFilter = recChannel !== 'all' && selected.includes(recChannel) ? recChannel : null;
    return recs.filter(({channel, rec}) => {
      if (chanFilter && channel !== chanFilter) return false;
      if (q && !recAction(rec).toLowerCase().includes(q)) return false;
      if (hideDone && recIsComplete(recAction(rec), recSteps(rec).length)) return false;
      return true;
    });
  }, [recs, recQuery, recChannel, hideDone, selected]);
  const backHref = row.window_from ? `/?week=${encodeURIComponent(row.window_from)}` : '/';

  if (hasNoSalesData(row)) {
    return <div className="mx-auto max-w-6xl px-6 py-8 md:px-10 text-muted-foreground max-md:px-4">No data for this window — check the batch job.</div>;
  }

  const toggle = (c: Channel) =>
    setSelected((prev) => {
      const next = prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c];
      return next.length ? next : prev; // never empty
    });

  const single = selected.length === 1 ? selected[0] : null;

  return (
    <div className="w-full px-6 py-8 md:px-10 lg:px-12 max-md:px-4 max-md:py-6">
      {/* header — back · date range · channel filter · compact KPIs (right) */}
      <div className="mb-7 flex flex-wrap items-center gap-x-6 gap-y-4">
        <Link
          href={backHref}
          aria-label="Back to Today"
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
        >
          <ArrowLeft className="size-5" />
        </Link>
        <h1 className="font-serif text-[2.6rem] font-normal leading-[1.05] tracking-tight text-foreground max-md:text-[2rem]">
          {fmtRange(row.window_from, row.window_to, row.digest.window.label)}
        </h1>
        {custom && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/[0.08] px-3 py-1 text-[12px] font-medium text-foreground">
            Showing {custom.label}
            <InfoTip
              text={
                fullPeriodOnly(custom).length
                  ? `Website and Offline are recalculated for these dates. ${fullPeriodOnly(custom).map((c) => CH[c].label).join(' and ')} only have full-period totals for this period, so they're left out of the totals and chart. Ad spend, ROAS and recommended actions are from the full period.`
                  : 'Sales, orders, AOV and units are recalculated for these dates across every channel. Ad spend, ROAS, marketplace top products and recommended actions are from the full period.'
              }
            />
          </span>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {CHANNELS.map((c, i) => {
            const on = selected.includes(c.key);
            const Icon = c.icon;
            return (
              <button
                key={c.key}
                onClick={() => toggle(c.key)}
                aria-pressed={on}
                style={{animationDelay: `${1.7 + i * 0.18}s`}}
                className={cn(
                  'coop-chip-hint inline-flex cursor-pointer items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-all hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 active:scale-95',
                  on
                    ? 'border-primary bg-primary/[0.1] text-foreground shadow-sm'
                    : 'border-border bg-card text-muted-foreground opacity-70 hover:opacity-100',
                )}
              >
                <Icon className="size-4" style={{color: on ? c.accent : undefined}} />
                {c.label}
                {on ? (
                  <Check className="size-3.5 text-primary" />
                ) : (
                  <span className="size-3.5 rounded-full border border-current opacity-40" aria-hidden />
                )}
              </button>
            );
          })}
        </div>

        <div className="ml-auto">
          <CombinedKpis metrics={metrics} priorMetrics={priorMetrics} priorRange={priorRange} channels={selected} />
        </div>
      </div>

      {single ? (
        /* single channel — full-width detail, no compact comparison layout */
        <ChannelDetail channel={single} row={row} />
      ) : (
        /* comparing 2+ channels — merged recs (2-col) beside the comparison chart */
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
          <section className="flex min-w-0 flex-col lg:sticky lg:top-[calc(3.5rem+1rem)] lg:max-h-[calc(100vh-5.5rem)]">
            <div className="mb-2.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-foreground/80">
              <Sparkles className="size-3.5 text-primary" /> Recommended actions
              <InfoTip text="AI-generated actions from this period's digest, grounded in the numbers. Reordered so those relevant to the chart metric come first." />
              <span className="font-medium normal-case tracking-normal text-muted-foreground/70">· {METRICS.find((m) => m.key === metric)?.label} first{custom ? ' · based on the full period' : ''}</span>
              <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10.5px] tabular-nums text-muted-foreground">{filteredRecs.length}</span>
            </div>

            {/* filter toolbar */}
            <div className="mb-2.5 flex flex-wrap items-center gap-2">
              <div className="relative min-w-[140px] flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={recQuery}
                  onChange={(e) => setRecQuery(e.target.value)}
                  placeholder="Filter actions…"
                  aria-label="Filter actions"
                  className="w-full rounded-full border border-border bg-card py-1.5 pl-8 pr-3 text-[12.5px] text-foreground outline-none transition-colors focus:border-primary/50"
                />
              </div>
              {selected.length > 1 && (
                <div className="inline-flex rounded-full border border-border bg-muted/40 p-0.5">
                  {(['all', ...selected] as const).map((c) => {
                    const on = recChannel === c;
                    return (
                      <button
                        key={c}
                        onClick={() => setRecChannel(c)}
                        className={cn('rounded-full px-2.5 py-1 text-[11.5px] font-medium capitalize transition-colors', on ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
                      >
                        {c === 'all' ? 'All' : CH[c].label}
                      </button>
                    );
                  })}
                </div>
              )}
              <button
                onClick={() => setHideDone((v) => !v)}
                aria-pressed={hideDone}
                className={cn('rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors', hideDone ? 'border-primary/40 bg-primary/[0.1] text-primary' : 'border-border bg-card text-muted-foreground hover:text-foreground')}
              >
                Hide done
              </button>
            </div>

            {/* fills the column height and scrolls; px/py + matching -mx give the
                card borders, shadows and hover-lift room so overflow doesn't crop them */}
            <div className="lg:-mx-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-2 lg:py-1.5">
              {filteredRecs.length ? (
                <MergedActions items={filteredRecs} />
              ) : (
                <p className="px-1 py-6 text-center text-[13px] text-muted-foreground">No actions match your filter.</p>
              )}
            </div>
          </section>

          <main className="min-w-0 space-y-6 lg:sticky lg:top-[calc(3.5rem+1rem)] lg:self-start">
            <ComparisonChart metrics={metrics} channels={selected} metric={metric} setMetric={setMetric} custom={custom} />
            <TopProducts row={row} channels={selected} custom={custom} />
          </main>
        </div>
      )}
    </div>
  );
}
