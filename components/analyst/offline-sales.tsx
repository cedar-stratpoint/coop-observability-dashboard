'use client';

import {useMemo, useState} from 'react';
import Link from 'next/link';
import {CalendarClock, CalendarDays, ChevronDown, ChevronRight, PackageX, Receipt, TriangleAlert} from 'lucide-react';
import dynamic from 'next/dynamic';
import type {BundleSalesSummary, DayMethodRevenue, FeaturedEvent, PetMix, PosOrder, SalesKpis, SalesRange, TopBundle, TopProduct} from '@/src/pos-sales-types';
import type {DailyProgress} from '@/src/pos-target-types';
import type {PaymentMethodOption, StockAlerts} from '@/src/pos-sales-compute';
import {SALES_RANGES, computeKpis, orderMethod, paymentMethodOptions, petMix, presentMethods, salesByDayAndMethod} from '@/src/pos-sales-compute';
import type {PosProductRow} from '@/src/pos-types';
import type {ForecastRow, ForecastSummary, ForecastStatus} from '@/src/pos-forecast-compute';
import {formatPeso, paymentMethodColor, paymentMethodLabel} from '@/src/pos-format';
import {Card, CardContent} from '@/components/ui/card';
import {Badge} from '@/components/ui/badge';
import {cn} from '@/lib/utils';
import {Eyebrow, MockNote} from './sections';
import {metricValueClass} from './metric';
import {SegmentedControl} from './segmented-control';
import {RefreshControl} from './refresh-control';
import {DailyTargetBar} from './daily-target-bar';
import {InfoTip} from './info-tip';

type Props = {
  range: SalesRange;
  progress: DailyProgress | null; // today vs daily goal; null = hidden (fail-soft)
  featured: FeaturedEvent | null; // event running today, else next upcoming, else null
  kpis: SalesKpis; // all-methods totals for the range
  productsByRevenue: TopProduct[]; // full product list ranked high→low by revenue
  productsByUnits: TopProduct[]; // full product list ranked high→low by units sold
  topBundles: TopBundle[]; // bundles sold by name (from bundle_id lines)
  bundles: BundleSalesSummary; // reconciles itemized product revenue with the KPI
  orders: PosOrder[]; // filtered, newest first
  stock: {urgent: ForecastRow[]; summary: ForecastSummary} | null; // snapshot for the Stock panel; null = fail-soft
  alerts: StockAlerts;
  usingMock: boolean;
  fetchedAt: string; // ISO; when the server loaded this data
};

const expiryLabel = (iso: string | null) =>
  iso ? new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'}) : 'no date';

const shortDay = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
const timeLabel = (iso: string) => new Date(iso).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});

export function OfflineSalesView({range, progress, featured, kpis, productsByRevenue, productsByUnits, topBundles, bundles, orders, stock, alerts, usingMock, fetchedAt}: Props) {
  // 'all' or a specific payment method. The method drives the KPI cards and
  // which segment of the stacked chart is highlighted. Computed client-side from
  // the range-filtered orders so switching is instant (no reload).
  const [method, setMethod] = useState<string>('all');
  const methods = useMemo(() => presentMethods(orders), [orders]);
  // Full method list for the filter: enabled (has sales) first, then the rest
  // greyed. The chart still uses `methods` (present only).
  const methodOptions = useMemo(() => paymentMethodOptions(orders), [orders]);
  const stackData = useMemo(() => salesByDayAndMethod(orders), [orders]);
  // The orders the KPI cards summarize: the range-filtered set, narrowed to the
  // selected method (or all). Pet mix reads from the exact same set so the split
  // reacts to the method toggle client-side, just like the KPIs above it.
  const shownOrders = useMemo(
    () => (method === 'all' ? orders : orders.filter((o) => orderMethod(o) === method)),
    [method, orders],
  );
  const shownKpis = useMemo(() => (method === 'all' ? kpis : computeKpis(shownOrders)), [method, kpis, shownOrders]);
  const mix = useMemo(() => petMix(shownOrders), [shownOrders]);

  const hasBundles = topBundles.length > 0;

  return (
    <div className="w-full px-6 py-8 md:px-10 max-md:px-4 max-md:py-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Eyebrow icon={Receipt}>Offline Sales</Eyebrow>
          <p className="text-sm text-muted-foreground">Bazaar sales synced from the POS.</p>
        </div>
        <RefreshControl fetchedAt={fetchedAt} />
      </div>

      {/* One toolbar for everything that scopes the numbers below. */}
      <div className="mb-8 flex flex-wrap items-center gap-2">
        <RangeTabs active={range} />
        <PaymentMethodSelect value={method} options={methodOptions} onChange={setMethod} />
      </div>

      {usingMock && (
        <div className="mb-6">
          <MockNote>
            Mock sales. Set <code>SUPABASE_URL_ARCHIVE</code> / <code>SUPABASE_SERVICE_ROLE_KEY_ARCHIVE</code> to the
            Staging project to load real <code>pos_orders</code>.
          </MockNote>
        </div>
      )}

      {/* Hero: event + daily goal + KPIs. One row on wide screens (3 / 4 / 5 of
          12), event + goal side by side with KPIs under them on laptops, stacked
          on phones. */}
      <div className="mb-5 grid gap-5 lg:mb-6 lg:grid-cols-2 lg:gap-6 xl:grid-cols-12">
        <div className={cn(progress ? 'xl:col-span-3' : 'lg:col-span-2 xl:col-span-7')}>
          <EventStatusCard featured={featured} />
        </div>
        {progress && (
          <div className="xl:col-span-4">
            <DailyTargetBar progress={progress} variant="full" />
          </div>
        )}
        <div className="lg:col-span-2 xl:col-span-5">
          <KpiStrip kpis={shownKpis} />
        </div>
      </div>

      {/* Trend gets the width; pet mix sits beside it on wide screens. */}
      <div className="mb-5 grid gap-5 lg:mb-6 lg:gap-6 xl:grid-cols-12">
        <Panel title="Sales over time" className="xl:col-span-8">
          {stackData.length === 0 ? (
            <Empty>No sales in this range.</Empty>
          ) : (
            <MethodStackChart data={stackData} methods={methods} selected={method} className="h-[220px] xl:h-[260px]" />
          )}
        </Panel>
        <PetMixCard mix={mix} className="xl:col-span-4" />
      </div>

      {/* Lists: 3 across on wide screens, 2 on tablets, 1 on phones. */}
      <div className="grid gap-5 md:grid-cols-2 lg:gap-6 xl:grid-cols-3">
        <TopSellers byRevenue={productsByRevenue} byUnits={productsByUnits} bundles={bundles} topBundles={topBundles} />

        <Panel title="Recent orders" action={{label: 'View all', href: '/offline-sales/orders'}}>
          {orders.length === 0 ? (
            <Empty>No orders yet.</Empty>
          ) : (
            <ul className="flex flex-col divide-y">
              {orders.slice(0, 6).map((o) => (
                <li key={o.id}>
                  <Link
                    href="/offline-sales/orders"
                    className="-mx-2 flex items-start gap-3 rounded-md px-2 py-3 transition-colors hover:bg-muted/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={cn('text-sm', o.status === 'voided' && 'line-through')}>{timeLabel(o.created_at)}</span>
                        {o.status === 'voided' && <Badge variant="destructive">voided</Badge>}
                        {o.oversold && (
                          <Badge variant="destructive">
                            <TriangleAlert /> oversold
                          </Badge>
                        )}
                      </div>
                      <p className={cn('truncate text-xs text-muted-foreground', o.status === 'voided' && 'line-through')}>
                        {o.items.map((it) => `${it.name} ×${it.qty}`).join(', ') || 'No items'}
                      </p>
                    </div>
                    <span className={cn('text-sm font-medium tabular-nums', o.status === 'voided' && 'text-muted-foreground line-through')}>{formatPeso(o.total)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <StockSnapshot stock={stock} />
        <StockAlertsCard alerts={alerts} className={cn('md:col-span-2', !hasBundles && 'xl:col-span-3')} />
      </div>
    </div>
  );
}

/** The four headline numbers as one segmented card (hairline dividers) rather
 *  than four separate boxes: less chrome, reads as a single summary. 2x2 on
 *  phones and in the wide hero slot, 4 across on laptops. */
function KpiStrip({kpis}: {kpis: SalesKpis}) {
  const cells: {label: string; value: string; warn?: boolean}[] = [
    {label: 'Revenue', value: formatPeso(kpis.revenue)},
    {label: 'Orders', value: String(kpis.orders)},
    {label: 'Units', value: String(kpis.units)},
    {label: 'Oversells', value: String(kpis.oversells), warn: kpis.oversells > 0},
  ];
  return (
    <div className="grid h-full grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border lg:grid-cols-4 xl:grid-cols-2">
      {cells.map((c) => (
        <div key={c.label} className="flex min-w-0 flex-col justify-center gap-1.5 bg-card px-6 py-5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{c.label}</span>
          <span className={cn(metricValueClass, 'truncate text-2xl xl:text-[1.75rem]', c.warn && 'text-destructive')}>{c.value}</span>
        </div>
      ))}
    </div>
  );
}

const SNAPSHOT_STATUS: Record<ForecastStatus, {label: string; dot: string; text: string}> = {
  healthy: {label: 'Healthy', dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400'},
  low: {label: 'Low', dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400'},
  out: {label: 'Out', dot: 'bg-red-500', text: 'text-red-600 dark:text-red-400'},
};

// Replaces "Recently synced" — a live pulse on what needs restocking, deep-linking
// into the Inventory forecast with Offline preselected.
function StockSnapshot({stock}: {stock: {urgent: ForecastRow[]; summary: ForecastSummary} | null}) {
  return (
    <Panel title="Stock" action={{label: 'View all →', href: '/inventory?channel=offline'}}>
      {!stock || stock.summary.total === 0 ? (
        <Empty>No stock data yet.</Empty>
      ) : stock.urgent.length === 0 ? (
        <Empty>All good. Nothing low or out.</Empty>
      ) : (
        <ul className="flex flex-col gap-3">
          {stock.urgent.map((r) => {
            const s = SNAPSHOT_STATUS[r.status];
            return (
              <li key={r.product_id} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate font-medium">{r.name}</span>
                <span className={cn('inline-flex shrink-0 items-center gap-1.5 text-xs font-medium', s.text)}>
                  <span className={cn('size-1.5 rounded-full', s.dot)} />
                  {r.status === 'out' ? 'Out' : `${r.stock} · ${s.label}`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {stock && stock.summary.total > 0 && (
        <div className="mt-3 border-t pt-3 font-mono text-[11px] text-muted-foreground">
          {stock.summary.healthy} healthy · {stock.summary.low} low · {stock.summary.out} out
        </div>
      )}
    </Panel>
  );
}

function StockAlertsCard({alerts, className}: {alerts: StockAlerts; className?: string}) {
  const nothing = alerts.out.length === 0 && alerts.low.length === 0 && alerts.nearExpiry.length === 0;
  return (
    <Panel title="Stock alerts" className={className}>
      {nothing ? (
        <Empty>All good. Nothing low, out, or near expiry.</Empty>
      ) : (
        <div className="grid gap-6 sm:grid-cols-3">
          <AlertColumn
            icon={<PackageX className="size-3.5" />}
            title="Out of stock"
            rows={alerts.out.map((p) => ({key: p.product_id, name: p.name, note: `${p.stock}`}))}
            tone="destructive"
          />
          <AlertColumn
            icon={<TriangleAlert className="size-3.5" />}
            title="Low stock"
            rows={alerts.low.map((p) => ({key: p.product_id, name: p.name, note: `${p.stock} left`}))}
            tone="warn"
          />
          <AlertColumn
            icon={<CalendarClock className="size-3.5" />}
            title="Near expiry"
            rows={alerts.nearExpiry.map((p) => ({key: p.product_id, name: p.name, note: expiryLabel(p.next_expiry)}))}
            tone="warn"
          />
        </div>
      )}
    </Panel>
  );
}

function AlertColumn({
  icon,
  title,
  rows,
  tone,
}: {
  icon: React.ReactNode;
  title: string;
  rows: {key: string; name: string; note: string}[];
  tone: 'destructive' | 'warn';
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className={cn('flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider', tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground')}>
        {icon}
        {title}
        <span className="text-muted-foreground">({rows.length})</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">None</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">{r.name}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{r.note}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RangeTabs({active}: {active: SalesRange}) {
  return (
    <div className="inline-flex rounded-md border p-0.5">
      {SALES_RANGES.map((r) => (
        <Link
          key={r.value}
          href={`/offline-sales?range=${r.value}`}
          scroll={false}
          className={cn(
            'rounded px-2.5 py-1 text-xs font-medium transition-colors',
            r.value === active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {r.label}
        </Link>
      ))}
    </div>
  );
}

/** A compact event date range: "Sep 16", "Sep 16 to Sep 18", "Sep 30 to Oct 1". */
function eventDatesShort(startsOn: string | null, endsOn: string | null): string {
  if (!startsOn && !endsOn) return 'No dates set';
  if (!startsOn) return shortDay(endsOn as string);
  if (!endsOn || endsOn === startsOn) return shortDay(startsOn);
  return `${shortDay(startsOn)} to ${shortDay(endsOn)}`;
}

/** The event spotlight banner: the bazaar running today ("Happening now"), else
 *  the next upcoming one, else an empty prompt to schedule. The whole card links
 *  to the Events page (replacing the old plain "Events" button). */
function EventStatusCard({featured}: {featured: FeaturedEvent | null}) {
  const ev = featured?.event ?? null;
  const current = featured?.state === 'current';
  const place = ev ? [ev.venue, ev.city].filter(Boolean).join(', ') : '';
  const meta = ev ? [place, eventDatesShort(ev.starts_on, ev.ends_on)].filter(Boolean).join(' · ') : '';

  return (
    <Link
      href="/offline-sales/events"
      className="group flex h-full flex-col justify-between gap-6 rounded-xl border bg-card p-5 transition-colors hover:bg-muted/40 lg:p-6"
    >
      {/* Top row: status icon (left) + the go-to-events affordance (right). */}
      <div className="flex items-start justify-between gap-3">
        <span
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-lg',
            current ? 'text-[var(--status-good)]' : 'text-muted-foreground',
          )}
          style={current ? {backgroundColor: 'color-mix(in oklab, var(--status-good) 14%, transparent)'} : {backgroundColor: 'var(--muted)'}}
        >
          {ev ? <CalendarClock className="size-5" /> : <CalendarDays className="size-5" />}
        </span>
        <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
          {ev ? 'All events' : 'Schedule'}
          <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>

      {/* Identity, anchored to the bottom so the tile fills its column height. */}
      <div className="min-w-0">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider">
          {current && <span className="size-1.5 rounded-full bg-[var(--status-good)]" aria-hidden />}
          <span className={current ? 'text-[var(--status-good)]' : 'text-muted-foreground'}>
            {ev ? (current ? 'Happening now' : 'Next event') : 'Events'}
          </span>
        </div>
        <div className="truncate text-lg font-semibold tracking-tight">{ev ? ev.name || 'Untitled event' : 'No events scheduled'}</div>
        <div className="mt-0.5 truncate text-sm text-muted-foreground">
          {ev ? meta : 'Schedule a bazaar so the POS can tag that day’s sales.'}
        </div>
      </div>
    </Link>
  );
}

// Pet-mix segments. Colors are deliberately distinct from the ochre page accent
// and from the payment-method hues: dog = blue, cat = purple, both = green,
// untagged = a muted neutral so it reads as "not yet categorized".
const PET_SEGMENTS: {key: keyof PetMix; label: string; color: string}[] = [
  {key: 'dog', label: 'Dog', color: '#3b82f6'}, // blue-500
  {key: 'cat', label: 'Cat', color: '#a855f7'}, // purple-500
  {key: 'both', label: 'Both', color: '#22c55e'}, // green-500
  {key: 'untagged', label: 'Untagged', color: '#a1a1aa'}, // zinc-400
];

/** Revenue + order split by tagged pet: a 4-segment bar over a per-segment
 *  legend. Widths are revenue-proportional; the legend always lists all four so
 *  a zero segment still reads. Empty (no orders) shows a friendly note. */
function PetMixCard({mix, className}: {mix: PetMix; className?: string}) {
  const totalRevenue = PET_SEGMENTS.reduce((s, seg) => s + mix[seg.key].revenue, 0);
  const totalOrders = PET_SEGMENTS.reduce((s, seg) => s + mix[seg.key].orders, 0);

  return (
    <Panel
      title="Pet mix"
      className={className}
      info="Sales split by the pet each order was tagged for at the POS. Untagged sales were recorded without a pet type. Honors the range and payment-option filters above."
    >
      {totalOrders === 0 ? (
        <Empty>No sales in this range.</Empty>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label="Revenue share by pet type">
            {PET_SEGMENTS.map((seg) => {
              const pct = totalRevenue > 0 ? (mix[seg.key].revenue / totalRevenue) * 100 : 0;
              if (pct <= 0) return null;
              return <div key={seg.key} style={{width: `${pct}%`, backgroundColor: seg.color}} />;
            })}
          </div>
          {/* A 2/4-up legend grid; on wide screens (beside the chart) it becomes a
              row-per-pet list so the card fills the chart's height. */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 xl:mt-1 xl:grid-cols-1 xl:gap-y-0 xl:divide-y">
            {PET_SEGMENTS.map((seg) => {
              const s = mix[seg.key];
              const pct = totalRevenue > 0 ? Math.round((s.revenue / totalRevenue) * 100) : 0;
              return (
                <div key={seg.key} className="flex flex-col gap-0.5 xl:flex-row xl:items-center xl:justify-between xl:gap-3 xl:py-3">
                  <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    <span className="size-2 rounded-[3px]" style={{backgroundColor: seg.color}} aria-hidden />
                    {seg.label}
                    {totalRevenue > 0 && <span className="tabular-nums text-muted-foreground/60">{pct}%</span>}
                  </span>
                  <span className="flex flex-col gap-0.5 xl:items-end">
                    <span className="text-sm font-medium tabular-nums">{formatPeso(s.revenue)}</span>
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {s.orders} {s.orders === 1 ? 'order' : 'orders'}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Panel>
  );
}

const METRIC_OPTIONS = [
  {value: 'revenue', label: 'Revenue'},
  {value: 'units', label: 'Units'},
] as const;
const DIRECTION_OPTIONS = [
  {value: 'top', label: 'Top'},
  {value: 'bottom', label: 'Bottom'},
] as const;
const SELLERS_LIMIT = 5;

/** Top products + Top bundles, rendered as two sibling grid cells.
 *  A Revenue/Units toggle picks the metric; a Top/Bottom toggle flips between the
 *  best sellers and the lowest ("kulelat"). In Units mode bundles rank by orders
 *  (their unit analog: one order == one bundle sold). */
function TopSellers({
  byRevenue,
  byUnits,
  bundles,
  topBundles,
}: {
  byRevenue: TopProduct[];
  byUnits: TopProduct[];
  bundles: BundleSalesSummary;
  topBundles: TopBundle[];
}) {
  const [metric, setMetric] = useState<'revenue' | 'units'>('revenue');
  const [direction, setDirection] = useState<'top' | 'bottom'>('top');
  const isTop = direction === 'top';

  // Full ranked list (high→low). Top shows the first N; Bottom shows the last N
  // flipped so #1 is the single lowest seller.
  const ranked = metric === 'revenue' ? byRevenue : byUnits;
  const rows = isTop ? ranked.slice(0, SELLERS_LIMIT) : ranked.slice(-SELLERS_LIMIT).reverse();
  const bundleRows =
    metric === 'revenue'
      ? topBundles
      : [...topBundles].sort((a, b) => b.orders - a.orders || b.revenue - a.revenue);

  // The bundle reconciliation is a whole-of-total statement ("matching Revenue
  // above"), so it only belongs with the best-sellers view, not the lowest.
  const showBundleReconcile = isTop && bundles.bundleRevenue > 0;

  const controls = (
    <div className="flex items-center gap-1.5">
      <SegmentedControl ariaLabel="Rank by" options={METRIC_OPTIONS} value={metric} onChange={setMetric} />
      <SegmentedControl ariaLabel="Show best or lowest" options={DIRECTION_OPTIONS} value={direction} onChange={setDirection} />
    </div>
  );

  return (
    <>
      <Panel
        title={isTop ? 'Top products' : 'Lowest products'}
        info="Money shown is itemized sales only. Bundle deals are priced as a set, so their value is listed once under Bundle deals, not split per item."
        control={controls}
      >
        {ranked.length === 0 && bundles.bundleRevenue <= 0 ? (
          <Empty>No sales in this range.</Empty>
        ) : (
          <div className="flex flex-col gap-3">
            <ul className="flex flex-col gap-3">
              {rows.map((t, i) => (
                <li key={t.product_id} className="flex items-start gap-3">
                  <span className="w-4 pt-0.5 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 block text-sm leading-snug">{t.name}</span>
                    {t.bundledUnits > 0 && (
                      <span className="text-[11px] text-muted-foreground">{t.bundledUnits} of these units were bundled</span>
                    )}
                  </span>
                  <span className={cn('pt-0.5 text-xs tabular-nums', metric === 'units' ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                    {t.units} units
                  </span>
                  <span className={cn('w-20 pt-0.5 text-right text-sm tabular-nums', metric === 'revenue' ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                    {formatPeso(t.revenue)}
                  </span>
                </li>
              ))}
            </ul>

            {showBundleReconcile && (
              <>
                <div className="h-px w-full bg-border" />
                <div className="flex items-center gap-3">
                  <span className="w-4" />
                  <span className="min-w-0 flex-1 text-sm">
                    Bundle deals
                    <span className="ml-1.5 text-[11px] text-muted-foreground">priced as a set</span>
                  </span>
                  <span className="text-xs text-muted-foreground">{bundles.bundleOrders} orders</span>
                  <span className="w-20 text-right text-sm font-medium tabular-nums">{formatPeso(bundles.bundleRevenue)}</span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Itemized {formatPeso(bundles.itemizedRevenue)} plus bundles {formatPeso(bundles.bundleRevenue)} is{' '}
                  {formatPeso(bundles.totalRevenue)}, matching Revenue above.
                </p>
              </>
            )}
          </div>
        )}
        {ranked.length > 0 && <ViewAllFooter href="/offline-sales/rankings?tab=products" label="View all products" />}
      </Panel>

      {topBundles.length > 0 && (
        <Panel
          title="Top bundles"
          info="Bundles sold as a set. Sales made offline, or before bundle tracking landed, are counted in the Bundle deals total on Top products but are not listed by name here."
        >
          <ul className="flex flex-col gap-3">
            {bundleRows.map((b, i) => (
              <li key={b.bundle_id} className="flex items-center gap-3">
                <span className="w-4 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{b.name}</span>
                <span className={cn('text-xs tabular-nums', metric === 'units' ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                  {b.orders} {b.orders === 1 ? 'order' : 'orders'}
                </span>
                <span className={cn('w-20 text-right text-sm tabular-nums', metric === 'revenue' ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                  {formatPeso(b.revenue)}
                </span>
              </li>
            ))}
          </ul>
          <ViewAllFooter href="/offline-sales/rankings?tab=bundles" label="View all bundles" />
        </Panel>
      )}
    </>
  );
}

/** Right-aligned "View all → " footer link, used under the Top products / Top
 *  bundles lists to reach the full paginated rankings page. */
function ViewAllFooter({href, label}: {href: string; label: string}) {
  return (
    <div className="mt-auto pt-3">
      <div className="border-t pt-3 text-right">
        <Link href={href} className="text-xs font-medium text-primary hover:underline">
          {label} →
        </Link>
      </div>
    </div>
  );
}

function Panel({
  title,
  info,
  action,
  control,
  className,
  children,
}: {
  title: string;
  info?: string;
  action?: {label: string; href: string};
  control?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={cn('h-full', className)}>
      <CardContent className="flex h-full flex-col py-5 lg:px-6 lg:py-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-x-2 gap-y-2">
          <h3 className="flex items-center gap-1 text-sm font-semibold">
            {title}
            {info && <InfoTip text={info} />}
          </h3>
          {control}
          {action && (
            <Link href={action.href} className="text-xs font-medium text-primary hover:underline">
              {action.label}
            </Link>
          )}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function Empty({children}: {children: React.ReactNode}) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

// Recharts is code-split: MethodStackChart (+ its tooltip) live in
// ./offline-sales-chart and load as an async chunk, keeping Recharts (~110 kB gz)
// out of this route's initial JS. A height-matched skeleton holds layout (no CLS).
const MethodStackChart = dynamic(() => import('./offline-sales-chart').then((m) => m.MethodStackChart), {
  ssr: false,
  loading: () => <div className="h-[220px] w-full animate-pulse rounded-lg bg-muted/40" aria-hidden />,
});

/** Color-coded payment-method dropdown. Default "All payment options". */
function PaymentMethodSelect({value, options, onChange}: {value: string; options: PaymentMethodOption[]; onChange: (v: string) => void}) {
  const [open, setOpen] = useState(false);
  const currentLabel = value === 'all' ? 'All payment options' : paymentMethodLabel(value);
  // Index of the first greyed (no-sales) method, so a divider marks the split.
  const firstDisabled = options.findIndex((o) => !o.enabled);

  const select = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted/50"
      >
        <MethodDot method={value} />
        {currentLabel}
        <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <ul
            role="listbox"
            className="absolute left-0 z-50 mt-1 min-w-[14rem] overflow-hidden rounded-lg border bg-background p-1 shadow-lg"
          >
            <li>
              <button
                type="button"
                role="option"
                aria-selected={value === 'all'}
                onClick={() => select('all')}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted',
                  value === 'all' ? 'font-medium text-foreground' : 'text-muted-foreground',
                )}
              >
                <MethodDot method="all" />
                All payment options
              </button>
            </li>
            {options.map((o, i) => {
              const label = paymentMethodLabel(o.method);
              if (!o.enabled) {
                return (
                  <li key={o.method}>
                    {i === firstDisabled && <div className="mx-1 my-1 border-t border-border/70" role="separator" />}
                    {/* No sales in range: shown for completeness, greyed + unclickable. */}
                    <div
                      aria-disabled="true"
                      className="flex w-full cursor-not-allowed items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground opacity-50"
                    >
                      <MethodDot method={o.method} />
                      {label}
                      <span className="ml-auto text-[10px] font-medium uppercase tracking-wide">No sales</span>
                    </div>
                  </li>
                );
              }
              return (
                <li key={o.method}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={o.method === value}
                    onClick={() => select(o.method)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted',
                      o.method === value ? 'font-medium text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    <MethodDot method={o.method} />
                    {label}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/** The color swatch for a method; a muted ring for "all". */
function MethodDot({method}: {method: string}) {
  if (method === 'all') return <span className="size-2.5 rounded-full border border-muted-foreground/50" aria-hidden />;
  return <span className="size-2.5 rounded-full" style={{backgroundColor: paymentMethodColor(method)}} aria-hidden />;
}
