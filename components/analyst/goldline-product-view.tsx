'use client';

// Goldline product page: one item at one store (or all of the caller's stores added
// up) — four headline numbers from the same engine as the Stock forecast, the shared
// sales + stock chart (3 real + 3 forecast months), what the store counted, and how
// many sold. Every figure says where it comes from (count sheets or sales report).

import {useState} from 'react';
import Link from 'next/link';
import {AlertTriangle, ArrowLeft, Check, ChevronRight, Info, Star} from 'lucide-react';
import type {ItemMovement} from '@/src/goldline-movement';
import type {CountLine, ProductViewData, SoldSource} from '@/src/goldline-product';
import {StockSalesChart} from '@/components/analyst/stock-sales-chart';
import {Metric} from '@/components/analyst/metric';
import {Card, CardContent} from '@/components/ui/card';
import {fmtDay, MOVEMENT_STATUS, peso, StorePicker, ToneChip} from '@/components/analyst/goldline-ops-shared';
import {cn} from '@/lib/utils';
import {GL_TILES_MOBILE} from '@/src/goldline-ui';

type Status = ItemMovement['status'];

// Literal classes (Tailwind can't see classes built from variables).
const TONE_TEXT: Partial<Record<Status, string>> = {
  out: 'text-[var(--status-crit)]',
  reorder: 'text-[var(--status-warn)]',
  watch: 'text-[var(--status-warn)]',
  healthy: 'text-[var(--status-good)]',
};
const storeLabel = (code: string, name: string | null) => (name ? `${code} · ${name}` : `Store ${code}`);
const coverText = (d: number | null) => (d == null ? '—' : Number.isFinite(d) ? `${Math.floor(d)}d` : 'no sales');
const num = (v: number | null) => (v == null ? '—' : v.toLocaleString('en-US'));
const sourceName = (s: SoldSource) => (s === 'sales' ? 'sales report' : 'count sheets');

export function GoldlineProductView({data}: {data: ProductViewData}) {
  const {item, single, totals, chart} = data;
  const [vsLastYear, setVsLastYear] = useState(false);
  const title = item.productLine ? `${item.productLine} · ${item.name}` : item.name;
  const backHref = data.store ? `/stock?store=${encodeURIComponent(data.store)}` : '/stock';
  const hasSales = chart.some((m) => (m.isForecast ? m.soldForecast : m.sold) != null);
  const status = single ? MOVEMENT_STATUS[single.status] : null;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-3">
        <Link href={backHref} className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden /> Inventory
        </Link>
        <div className="flex flex-col gap-2">
          <h1 className="flex flex-wrap items-center gap-2 font-heading text-2xl font-semibold tracking-tight text-balance">
            {title}
            {item.bestseller && <Star aria-label="Bestseller" className="size-4 shrink-0 fill-current" style={{color: 'var(--status-warn)'}} />}
          </h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {data.stores.length > 0 && (
              <StorePicker stores={data.stores} value={data.store} allLabel={data.stores.length > 1 ? `All stores (${data.stores.length})` : undefined} />
            )}
            <span className="font-mono text-xs text-muted-foreground">
              {item.itemCode}
              {item.price != null ? ` · ${peso(item.price)}` : ''}
              {single?.latestEnd ? ` · counted ${fmtDay(single.latestEnd)}` : ''}
            </span>
          </div>
        </div>
        <div className="h-0.5 w-24 rounded-full bg-gradient-to-r from-primary to-transparent" aria-hidden />
      </header>

      {data.stores.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <h2 className="font-heading text-base font-semibold">Not counted yet</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              No store you can see has counted this product in the last 15 months. It appears here once a committed inventory form includes it.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <section aria-label="Summary" className={cn("grid grid-cols-2 gap-4 lg:grid-cols-4", GL_TILES_MOBILE)}>
            {single ? (
              <>
                <Metric label="On the shelf now" value={num(single.onHand)} sub={single.latestEnd ? `counted ${fmtDay(single.latestEnd)}` : 'not counted'}
                  valueClassName={single.onHand === 0 ? 'text-[var(--status-crit)]' : undefined} />
                <Metric label="Status" value={single.deadStock ? 'Not moving' : status!.label}
                  sub={
                    single.missingFromLatest
                      ? "not on the store's latest count"
                      : single.status === 'out'
                        ? 'deliver first'
                        : single.coverDays != null
                          ? `${coverText(single.coverDays)} of cover`
                          : 'needs 2 counts'
                  }
                  valueClassName={TONE_TEXT[single.status]} />
                <Metric label="Sold last month" value={num(data.soldLastMonth?.sold ?? null)}
                  sub={data.soldLastMonth ? `${data.soldLastMonth.label} · ${sourceName(single.source)}` : '—'} />
                <Metric label="Suggested order" value={single.suggestedOrder ? String(single.suggestedOrder) : '—'} sub="tops up to 2 cycles of cover"
                  valueClassName={single.suggestedOrder ? 'text-[var(--status-good)]' : undefined} />
              </>
            ) : (
              <>
                <Metric label="On the shelf now" value={num(totals.onHand)} sub={`sum of ${totals.storesCounted} ${totals.storesCounted === 1 ? 'store' : 'stores'}' latest counts`} />
                <Metric label="Stores needing it" value={`${totals.needing} of ${data.stores.length}`}
                  sub={totals.needing ? [totals.out && `${totals.out} out`, totals.reorder && `${totals.reorder} to reorder`].filter(Boolean).join(' · ') : 'all covered'}
                  valueClassName={totals.out ? 'text-[var(--status-crit)]' : totals.reorder ? 'text-[var(--status-warn)]' : undefined} />
                <Metric label="Sold last month" value={num(data.soldLastMonth?.sold ?? null)} sub={data.soldLastMonth ? `${data.soldLastMonth.label} · all stores` : '—'} />
                <Metric label="Suggested order" value={totals.suggestedOrder ? String(totals.suggestedOrder) : '—'} sub="each store's order, added up"
                  valueClassName={totals.suggestedOrder ? 'text-[var(--status-good)]' : undefined} />
              </>
            )}
          </section>

          <Card>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h2 className="font-heading text-base font-semibold">
                  Sales and stock, month by month{single ? '' : ' · all stores'}
                </h2>
                <label className={cn('inline-flex items-center gap-2 text-xs', data.hasLastYear ? 'cursor-pointer text-foreground' : 'cursor-not-allowed text-muted-foreground')}
                  title={data.hasLastYear ? undefined : 'Needs a year of counts'}>
                  <input type="checkbox" className="size-3.5 accent-[var(--status-good)]" checked={vsLastYear && data.hasLastYear} disabled={!data.hasLastYear}
                    onChange={(e) => setVsLastYear(e.target.checked)} />
                  vs last year
                </label>
              </div>
              {hasSales ? (
                <>
                  <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
                    Bars are pieces sold: solid is real{data.soldTable[0]?.partial ? ` (${data.soldTable[0].label.split(' ')[0]} so far)` : ''}, dashed is the
                    forecast (recent pace, shaped by last year once there&apos;s a year of history). The blue line is stock on hand: a delivery lifts it, and the
                    dotted part shows it running down if nothing is ordered.
                    {!single && ' Each month adds up every store; stores on different count days still line up.'}
                  </p>
                  <div className="-mx-1 overflow-x-auto px-1">
                    <div className="min-w-[36rem]">
                      <StockSalesChart data={chart} vsLastYear={vsLastYear && data.hasLastYear} lastCountedWeeksAgo={data.lastCountedWeeksAgo} />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-xs text-muted-foreground">
                    {single ? (
                      single.status === 'out' ? (
                        <span className="font-semibold text-[var(--status-crit)]">Out of stock now</span>
                      ) : single.coverDays != null && Number.isFinite(single.coverDays) ? (
                        <>
                          <span>Lasts ~{Math.floor(single.coverDays)} days</span>
                          {single.stockOutDate && (
                            <span className={cn('font-semibold', TONE_TEXT[single.status] && single.status !== 'healthy' ? TONE_TEXT[single.status] : 'text-foreground')}>
                              Runs out ~{fmtDay(single.stockOutDate)}
                            </span>
                          )}
                        </>
                      ) : null
                    ) : (
                      data.runsOutMonthLabel && <span className="font-semibold text-[var(--status-crit)]">Runs out ~{data.runsOutMonthLabel} across all stores</span>
                    )}
                    <span className="inline-flex items-center gap-1.5">
                      Sold from{' '}
                      <span className="rounded-full border px-2 py-0.5 text-[11px]">
                        {single
                          ? sourceName(single.source)
                          : totals.sources.sales && totals.sources.counts
                            ? `sales report · ${totals.sources.sales} · count sheets · ${totals.sources.counts}`
                            : `${sourceName(totals.sources.sales ? 'sales' : 'counts')} · ${data.stores.length} ${data.stores.length === 1 ? 'store' : 'stores'}`}
                      </span>
                    </span>
                  </div>
                  {single && <RegisterNote check={single.registerCheck} linked={item.skuLinked} source={single.source} />}
                </>
              ) : (
                <div className="flex items-start gap-3 rounded-lg border border-dashed px-4 py-4">
                  <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="flex flex-col gap-1">
                    <p className="text-sm font-medium">Not enough history yet</p>
                    <p className="max-w-prose text-sm text-muted-foreground">
                      Pieces sold come from comparing one count with the next, so the chart starts after this product&apos;s second count
                      {single ? ` at ${storeLabel(data.store as string, single.storeName)}` : ''}.
                      {single?.onHand != null ? ` On the shelf now: ${single.onHand}.` : ''}
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            {single ? <CountsCard lines={single.countLines} /> : <StoresCard rows={data.storeRows} item={item.itemCode} lastMonth={data.soldLastMonth?.label ?? null} />}
            <SoldCard rows={data.soldTable} source={single ? single.source : totals.sources.sales ? 'sales' : 'counts'} mixed={!single && totals.sources.sales > 0 && totals.sources.counts > 0} />
          </div>
        </>
      )}
    </div>
  );
}

function RegisterNote({check, linked, source}: {check: boolean | null; linked: boolean; source: SoldSource}) {
  if (check === true)
    return (
      <p className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs" style={{color: 'color-mix(in oklab, var(--status-good) 75%, var(--foreground))', background: 'color-mix(in oklab, var(--status-good) 10%, transparent)'}}>
        <Check className="size-3.5 shrink-0" aria-hidden /> Store counts matched the register in each of the last 3 months.
      </p>
    );
  if (check === false)
    return (
      <p className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs" style={{color: 'color-mix(in oklab, var(--status-warn) 75%, var(--foreground))', background: 'color-mix(in oklab, var(--status-warn) 10%, transparent)'}}>
        <AlertTriangle className="size-3.5 shrink-0" aria-hidden /> A month&apos;s count differed from the register by more than 10%. Check that month&apos;s count sheets.
      </p>
    );
  if (!linked || source === 'counts')
    return (
      <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
        {linked
          ? 'This store has no sales-report rows for this product yet, so sold is estimated from the counts.'
          : "Sold is estimated from the counts. Once this product's POS SKU is linked, it comes from the sales report and is checked against the register."}
      </p>
    );
  return null;
}

const COUNTS_SHOWN = 6;

function CountsCard({lines}: {lines: CountLine[]}) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, COUNTS_SHOWN);
  return (
    <Card className="py-0">
      <CardContent className="flex flex-col gap-1 px-0 pt-4 pb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-4">
          <h2 className="font-heading text-base font-semibold">What the store counted</h2>
          <span className="text-xs text-muted-foreground">straight from the count sheets</span>
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-y border-border bg-muted/40 text-left text-[11px] font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase">
                <th className="py-2 pr-3 pl-4 font-medium">When</th>
                <th className="py-2 pr-3 text-right font-medium">Back room</th>
                <th className="py-2 pr-3 text-right font-medium">Drawer</th>
                <th className="py-2 pr-3 text-right font-medium">On display</th>
                <th className="py-2 pr-3 text-right font-medium">Delivered</th>
                <th className="py-2 pr-4 text-right font-medium">On hand</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => (
                <tr key={l.periodEnd} className="border-b border-border/60 last:border-b-0">
                  <td className="py-2 pr-3 pl-4 whitespace-nowrap">
                    <span className="font-medium">{l.label}</span> <span className="font-mono text-[11px] text-muted-foreground">{fmtDay(l.periodEnd)}</span>
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">{num(l.stockroom)}</td>
                  <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">{num(l.drawer)}</td>
                  <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">{num(l.sellingArea)}</td>
                  <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">{l.delivery ? `+${l.delivery}` : '0'}</td>
                  <td className="py-2 pr-4 text-right font-mono text-xs font-semibold tabular-nums">{num(l.onHand)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {lines.length > COUNTS_SHOWN && (
          <button
            type="button"
            onClick={() => setAll((v) => !v)}
            aria-expanded={all}
            className="mx-4 mt-1 w-fit rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-muted"
          >
            {all ? 'Show the latest 6' : `Show all ${lines.length} counts`}
          </button>
        )}
      </CardContent>
    </Card>
  );
}

function StoresCard({rows, item, lastMonth}: {rows: ProductViewData['storeRows']; item: string; lastMonth: string | null}) {
  const sorted = [...rows].sort((a, b) => MOVEMENT_STATUS[a.status].rank - MOVEMENT_STATUS[b.status].rank || a.code.localeCompare(b.code, undefined, {numeric: true}));
  return (
    <Card className="py-0">
      <CardContent className="flex flex-col gap-1 px-0 pt-4 pb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-4">
          <h2 className="font-heading text-base font-semibold">By store</h2>
          <span className="text-xs text-muted-foreground">most urgent first · open a store for its counts</span>
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-y border-border bg-muted/40 text-left text-[11px] font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase">
                <th className="py-2 pr-3 pl-4 font-medium">Store</th>
                <th className="py-2 pr-3 text-right font-medium">On hand</th>
                <th className="py-2 pr-3 text-right font-medium">Sold{lastMonth ? ` ${lastMonth.split(' ')[0]}` : ''}</th>
                <th className="py-2 pr-3 text-right font-medium">Cover</th>
                <th className="py-2 pr-3 text-right font-medium">Order</th>
                <th className="py-2 pr-3 text-right font-medium">Status</th>
                <th className="w-8 py-2 pr-3" aria-hidden />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const s = r.deadStock ? {label: 'Not moving', tone: null} : MOVEMENT_STATUS[r.status];
                return (
                  <tr key={r.code} className="group relative border-b border-border/60 transition-colors duration-150 last:border-b-0 hover:bg-muted/40 has-[a:focus-visible]:bg-muted/40">
                    <td className="py-2 pr-3 pl-4">
                      <Link href={`/stock/${encodeURIComponent(item)}?store=${encodeURIComponent(r.code)}`}
                        className="font-medium whitespace-nowrap outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset">
                        {storeLabel(r.code, r.name)}
                      </Link>
                      {r.latestEnd && <span className="block font-mono text-[11px] text-muted-foreground">counted {fmtDay(r.latestEnd)}</span>}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-xs font-semibold tabular-nums">{num(r.onHand)}</td>
                    <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">{num(r.soldLastMonth)}</td>
                    <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">{coverText(r.coverDays)}</td>
                    <td className="py-2 pr-3 text-right font-mono text-xs font-semibold tabular-nums">{r.suggestedOrder || '—'}</td>
                    <td className="py-2 pr-3 text-right"><ToneChip tone={s.tone}>{s.label}</ToneChip></td>
                    <td className="py-2 pr-3 text-muted-foreground"><ChevronRight className="size-4" aria-hidden /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function SoldCard({rows, source, mixed}: {rows: ProductViewData['soldTable']; source: SoldSource; mixed: boolean}) {
  return (
    <Card className="py-0">
      <CardContent className="flex flex-col gap-1 px-0 pt-4 pb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-4">
          <h2 className="font-heading text-base font-semibold">How many sold</h2>
          <span className="text-xs text-muted-foreground">{mixed ? 'sales report + count sheets' : sourceName(source)}</span>
        </div>
        <p className="px-4 text-xs text-muted-foreground">
          {source === 'sales' && !mixed
            ? 'Straight from the sales report.'
            : 'Estimated per cycle: last on hand + delivered − this on hand, added up by the month each count ends in.'}
        </p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-y border-border bg-muted/40 text-left text-[11px] font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase">
                <th className="py-2 pr-3 pl-4 font-medium">Month</th>
                <th className="py-2 pr-4 text-right font-medium">Pieces sold</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.month} className="border-b border-border/60 last:border-b-0">
                  <td className="py-2 pr-3 pl-4">
                    {r.label}
                    {r.partial && <span className="text-xs text-muted-foreground"> · so far</span>}
                  </td>
                  <td className="py-2 pr-4 text-right font-mono text-xs font-semibold tabular-nums">{r.sold == null ? <span className="font-normal text-muted-foreground">no data</span> : num(r.sold)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
