'use client';

// The Sales page when dates are picked (any dates, or all time). Same look as the weekly view: back link, serif title, channel
// chips, totals, Compare channels, Top products. The dates are chosen with the top bar's "Custom dates" button. Every figure is built in code (src/sales-range.ts); this file only displays it.
import {useMemo, useState} from 'react';
import Link from 'next/link';
import {ArrowLeft, Check, Globe, Store} from 'lucide-react';
import {cn} from '@/lib/utils';
import {Card, CardContent} from '@/components/ui/card';
import {ShopeeIcon, LazadaIcon} from './brand-icons';
import {InfoTip} from './info-tip';
import {SegmentedControl} from './segmented-control';
import {adsTotals, sumTotals, type ProductRow, type SalesRangeView as View} from '../../src/sales-range';

type Channel = 'shopee' | 'lazada' | 'website' | 'offline';
const CHANNELS: {key: Channel; label: string; icon: React.ComponentType<{className?: string; style?: React.CSSProperties}>; accent: string}[] = [
  {key: 'shopee', label: 'Shopee', icon: ShopeeIcon, accent: '#ee4d2d'},
  {key: 'lazada', label: 'Lazada', icon: LazadaIcon, accent: '#2f6bd4'},
  {key: 'website', label: 'Website', icon: Globe, accent: 'var(--primary)'},
  {key: 'offline', label: 'Offline', icon: Store, accent: '#c9873f'},
];
const CH = Object.fromEntries(CHANNELS.map((c) => [c.key, c])) as Record<Channel, (typeof CHANNELS)[number]>;

type Metric = 'adSpend' | 'roas' | 'revenue' | 'orders' | 'aov' | 'units';
const METRICS: {value: Metric; label: string}[] = [
  {value: 'adSpend', label: 'Ad spend'},
  {value: 'roas', label: 'ROAS'},
  {value: 'revenue', label: 'Revenue'},
  {value: 'orders', label: 'Orders'},
  {value: 'aov', label: 'AOV'},
  {value: 'units', label: 'Units'},
];
const HINTS: Record<Metric, string> = {
  revenue: 'Summed per channel for the days you picked. Shopee and Lazada from the digests\' per-day sales, Website from live orders, Offline from completed POS orders.',
  orders: 'Orders over the same days.',
  aov: 'Revenue divided by orders of the totals, never an average of averages.',
  units: 'Units over the same days. Shopee does not report units.',
  adSpend: 'Sum of the ad figures whose whole window sits inside your dates. Website and Offline have no ad feed.',
  roas: 'Total ad revenue divided by total ad spend over those windows, never an average of ROAS.',
};

const money = (n: number) => `₱${n.toLocaleString('en-PH', {maximumFractionDigits: n < 100 ? 2 : 0})}`;
const count = (n: number) => n.toLocaleString('en-PH');
const fmt = (m: Metric, v: number) => (m === 'roas' ? `${v.toFixed(2)}x` : m === 'orders' || m === 'units' ? count(v) : money(v));
const tagTone = (kind: 'ex' | 'wk' | 'none') => (kind === 'ex' ? 'bg-primary/10 text-foreground' : 'text-[color:var(--amber-fg)]');

function Tag({kind, children}: {kind: 'ex' | 'wk' | 'none'; children: React.ReactNode}) {
  return (
    <span
      className={cn('inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide', tagTone(kind))}
      style={kind === 'ex' ? undefined : {background: 'var(--amber-bg)'}}
    >
      {kind === 'ex' && <Check className="size-3" />}
      {children}
    </span>
  );
}

function Kpi({label, value, tag, hint}: {label: string; value: string; tag?: React.ReactNode; hint?: string}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-5 first:pl-0 max-md:px-0 md:border-l md:first:border-l-0">
      <div className="flex items-center gap-1 text-[10.5px] font-medium uppercase tracking-[0.09em] text-muted-foreground">
        {label} {hint && <InfoTip text={hint} />}
      </div>
      <div className="font-serif text-[1.9rem] font-normal leading-[1.1] tabular-nums">{value}</div>
      {tag}
    </div>
  );
}

export function SalesRangeView({view, initialChannels = ['shopee', 'lazada', 'website', 'offline'], weeks}: {view: View; initialChannels?: Channel[]; weeks: {from: string; label: string}[]}) {
  const [selected, setSelected] = useState<Channel[]>(initialChannels);
  const [metric, setMetric] = useState<Metric>('revenue');
  const [productTab, setProductTab] = useState<'website' | 'shopee' | 'lazada'>('website');

  const toggle = (c: Channel) => setSelected((cur) => (cur.includes(c) ? (cur.length > 1 ? cur.filter((x) => x !== c) : cur) : [...cur, c]));
  const chosen = useMemo(() => view.channels.filter((c) => selected.includes(c.channel)), [view.channels, selected]);
  const totals = useMemo(() => sumTotals(chosen), [chosen]);
  const ads = useMemo(
    () => adsTotals([view.ads.shopee, view.ads.lazada].filter((a) => selected.includes(a.channel)), view.fromDay, view.toDay),
    [view, selected],
  );
  const exact = chosen.every((c) => c.status === 'ok' || c.status === 'not_connected');
  const noData = chosen.every((c) => c.revenue === null);

  const value = (c: Channel): number | null => {
    if (metric === 'adSpend') return c === 'shopee' ? view.ads.shopee.spend : c === 'lazada' ? view.ads.lazada.spend : null;
    if (metric === 'roas') return c === 'shopee' ? view.ads.shopee.roas : c === 'lazada' ? view.ads.lazada.roas : null;
    return view.channels.find((x) => x.channel === c)?.[metric] ?? null;
  };
  const rows = CHANNELS.filter((c) => selected.includes(c.key)).flatMap((c) => {
    const v = value(c.key);
    return v === null ? [] : [{c, v}];
  });
  const max = Math.max(...rows.map((r) => r.v), 0) || 1;
  const missing = CHANNELS.filter((c) => selected.includes(c.key) && value(c.key) === null).map((c) => c.label);
  const isAd = metric === 'adSpend' || metric === 'roas';

  const tabs = (['website', 'shopee', 'lazada'] as const).filter((t) => selected.includes(t));
  const tab = tabs.includes(productTab) ? productTab : tabs[0];
  const list: ProductRow[] = tab === 'website' ? view.products.website : tab ? view.products[tab].products : [];
  const topRev = Math.max(...list.map((p) => p.revenue), 0) || 1;
  const marketplace = tab && tab !== 'website' ? view.products[tab] : null;

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6 px-6 pb-14 pt-8 md:px-10">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <Link
          href="/"
          aria-label="Back to Today"
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 active:scale-[0.97]"
        >
          <ArrowLeft className="size-5" />
        </Link>
        <h1 className="font-serif text-[2.6rem] font-normal leading-[1.05] tracking-tight text-foreground max-md:text-[2rem]">{view.label}</h1>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/[0.08] px-3 py-1 text-[12px] font-medium text-foreground">
          {view.all ? 'All time' : `${view.dayCount} ${view.dayCount === 1 ? 'day' : 'days'}`}
          <InfoTip text="Sales, orders, units and AOV are exact for these days. Ad spend, ROAS and top products use whole export windows inside these dates." />
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {CHANNELS.map((c) => {
            const on = selected.includes(c.key);
            const Icon = c.icon;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => toggle(c.key)}
                aria-pressed={on}
                className={cn(
                  'inline-flex cursor-pointer items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors duration-150 ease-out active:scale-[0.97]',
                  on ? 'border-primary bg-primary/[0.1] text-foreground shadow-sm' : 'border-border bg-card text-muted-foreground opacity-70 hover:opacity-100',
                )}
              >
                <Icon className="size-4" style={{color: on ? c.accent : undefined}} />
                {c.label}
                {on ? <Check className="size-3.5 text-primary" /> : <span className="size-3.5 rounded-full border border-current opacity-40" aria-hidden />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-0 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi label="Total revenue" value={totals.revenue === null ? 'No data' : money(totals.revenue)} tag={noData ? undefined : <Tag kind={exact ? 'ex' : 'wk'}>{exact ? 'Exact' : 'Partial'}</Tag>} hint={HINTS.revenue} />
        <Kpi label="Total orders" value={totals.orders === null ? 'No data' : count(totals.orders)} hint={HINTS.orders} />
        <Kpi label="Blended AOV" value={totals.aov === null ? 'No data' : money(totals.aov)} hint={HINTS.aov} />
        <Kpi label="Ad spend" value={ads.spend === null ? 'No data' : money(ads.spend)} tag={<Tag kind={ads.tag.kind}>{ads.tag.text}</Tag>} hint={HINTS.adSpend} />
        <Kpi label="ROAS" value={ads.roas === null ? 'No data' : `${ads.roas.toFixed(2)}x`} tag={ads.spend === null ? undefined : <Tag kind={ads.tag.kind}>{ads.tag.text}</Tag>} hint={HINTS.roas} />
      </div>

      {view.notes.length > 0 && (
        <details open={view.notes.length <= 2} className="rounded-xl border px-4 py-3 text-sm" style={{background: 'var(--amber-bg)', color: 'var(--amber-fg)', borderColor: 'color-mix(in oklab, var(--amber-fg) 30%, transparent)'}}>
          <summary className="cursor-pointer font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            Coverage notes ({view.notes.length})
          </summary>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-[13px] leading-snug">
            {view.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <Card>
          <CardContent className="flex flex-col gap-3 p-5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-foreground/80">Recommended actions</div>
            <h2 className="font-serif text-xl font-normal">Written per week</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Recommended actions come from one weekly digest, so they do not apply to a span of dates. Pick a week to see them.
            </p>
            {weeks.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {weeks.map((w) => (
                  <Link
                    key={w.from}
                    href={`/?channel=all&week=${encodeURIComponent(w.from)}`}
                    className="rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-foreground transition-colors duration-150 ease-out hover:bg-muted active:scale-[0.97]"
                  >
                    {w.label}
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardContent className="p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-foreground/80">
                  Compare channels <InfoTip text={HINTS[metric]} />
                </div>
                <div className="max-md:-mx-1 max-md:overflow-x-auto max-md:px-1 [&_button]:whitespace-nowrap">
                  <SegmentedControl options={METRICS} value={metric} onChange={setMetric} ariaLabel="Metric" />
                </div>
              </div>
              {rows.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {isAd ? 'No full ad window sits inside these dates, so ad figures are not shown.' : 'No data for this metric in the selected channels for these dates.'}
                </p>
              ) : (
                <>
                  <div
                    className="flex items-end gap-3 border-b border-border pt-1 sm:gap-6"
                    style={{height: 168, backgroundImage: 'repeating-linear-gradient(to top, transparent 0, transparent 41px, color-mix(in oklab, var(--border) 55%, transparent) 41px, color-mix(in oklab, var(--border) 55%, transparent) 42px)'}}
                  >
                    {rows.map(({c, v}) => (
                      <div key={c.key} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
                        <div className="max-w-full truncate text-[15px] font-semibold tabular-nums text-foreground">{fmt(metric, v)}</div>
                        <div
                          className="w-full max-w-[112px] rounded-t-xl shadow-sm"
                          style={{height: Math.max(6, (v / max) * 130), backgroundImage: `linear-gradient(180deg, ${c.accent} 0%, color-mix(in oklab, ${c.accent} 72%, white) 100%)`}}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-3 pt-2.5 sm:gap-6">
                    {rows.map(({c}) => {
                      const Icon = c.icon;
                      return (
                        <div key={c.key} className="flex min-w-0 flex-1 items-center justify-center gap-1.5 text-[13px] font-medium text-foreground">
                          <Icon className="size-4 shrink-0" style={{color: c.accent}} /> <span className="truncate">{c.label}</span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
              {isAd && ads.spend !== null && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <Tag kind={ads.tag.kind}>{ads.tag.text}</Tag> Website and Offline have no ad feed.
                </div>
              )}
              {!isAd && missing.length > 0 && rows.length > 0 && <p className="mt-3 text-[11px] text-muted-foreground">No figures for {missing.join(', ')} in these dates. See the coverage notes.</p>}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-foreground/80">
                  Top products by revenue <InfoTip text="Website is built from live orders for your dates. Shopee and Lazada keep only a top list per export window, so merged lists can miss a product that is 6th every time." />
                </div>
                {tabs.length > 1 && <SegmentedControl options={tabs.map((t) => ({value: t, label: CH[t].label}))} value={tab} onChange={setProductTab} ariaLabel="Channel" />}
              </div>
              {list.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">
                  {!tab
                    ? 'Offline top products are on the Offline Sales page.'
                    : tab === 'website'
                      ? 'No website orders with products in these dates.'
                      : marketplace?.notes[0] ?? 'No product list for these dates.'}
                </p>
              ) : (
                <ol className="flex flex-col gap-3">
                  {list.map((p, i) => (
                    <li key={p.title} className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2.5 text-sm">
                        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate">{p.title}</span>
                        <span className="text-xs tabular-nums text-muted-foreground">{count(p.units)} units</span>
                      </div>
                      <div className="ml-[30px] flex items-center gap-3">
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary" style={{width: `${(p.revenue / topRev) * 100}%`}} />
                        </div>
                        <span className="min-w-[72px] text-right text-sm font-semibold tabular-nums">{money(p.revenue)}</span>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              {list.length > 0 && (
                <div className="mt-3 text-[11px] text-muted-foreground">
                  {tab === 'website' ? <Tag kind="ex">Exact</Tag> : marketplace?.approximate ? <Tag kind="wk">Approximate</Tag> : <Tag kind="ex">One export window</Tag>}
                  {marketplace && <span className="ml-2">{marketplace.windows.map((w) => w.label).join('; ')}</span>}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
      {view.sources.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer rounded font-medium outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">Where these numbers come from ({view.sources.length})</summary>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 leading-snug">
            {view.sources.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
