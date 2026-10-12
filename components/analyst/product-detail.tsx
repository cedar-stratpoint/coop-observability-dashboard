'use client';

// Per-product detail page: KPI cards, a year-over-year headline, the two-panel
// sales + stock chart (3 real + 3 forecast months, with a vs-last-year overlay),
// the sold-by-month table, and this SKU's stock-in history. Reached by tapping a
// row on the merged Inventory page.

import {useState} from 'react';
import Link from 'next/link';
import {Check, TriangleAlert} from 'lucide-react';
import {cn} from '@/lib/utils';
import {formatPeso} from '@/src/pos-format';
import {StockSalesChart} from './stock-sales-chart';
import type {ProductDetail} from '@/src/pos-product-detail';
import type {ForecastStatus} from '@/src/pos-forecast-compute';

const STATUS: Record<ForecastStatus, {label: string; text: string}> = {
  healthy: {label: 'Healthy', text: 'text-emerald-600 dark:text-emerald-400'},
  low: {label: 'Low', text: 'text-amber-600 dark:text-amber-400'},
  out: {label: 'Out', text: 'text-red-600 dark:text-red-400'},
};
const when = (iso: string) => new Date(iso).toLocaleString('en-US', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});

export function ProductDetailView({detail, backHref = '/inventory', boxme, boxmeFirst = false}: {
  detail: ProductDetail; backHref?: string; boxme?: React.ReactNode; boxmeFirst?: boolean;
}) {
  const {product, forecast, series, chart, yoy, hasLastYear, lastCountedWeeksAgo, countsMatched, latestRealLabel, runsOutLabel, history} = detail;
  const status = (forecast?.status ?? (product.stock <= 0 ? 'out' : 'healthy')) as ForecastStatus;
  const s = STATUS[status];
  const lastMonthSold = series.length >= 2 ? series[series.length - 2].sold : 0;
  const [vsLastYear, setVsLastYear] = useState(false);

  return (
    <div className="mx-auto max-w-5xl px-6 py-8 md:px-10">
      <Link href={backHref} className="font-mono text-xs text-primary hover:underline">‹ Back to inventory</Link>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">{product.name}</h1>
      <div className="mt-1 font-mono text-[11px] text-muted-foreground">
        {product.product_id} · {formatPeso(product.price)}{!product.active && ' · unlisted'}
      </div>

      {boxmeFirst && boxme}

      <h2 className="mt-6 text-sm font-semibold">Stratpoint (Offline) stock and sales</h2>
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi big={String(product.stock)} lbl="Stock Qty now" tone={product.stock <= 0 ? 'crit' : undefined} />
        <Kpi big={s.label} lbl="status right now" small toneClass={s.text} />
        <Kpi big={String(lastMonthSold)} lbl="sold last month" />
        <Kpi big={forecast?.reorderQty != null ? String(forecast.reorderQty) : '—'} lbl="suggested order" tone={forecast?.reorderQty ? 'good' : undefined} />
      </div>

      {yoy && <YoyStrip yoy={yoy} />}

      <div className="mt-5 rounded-xl border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-sm font-semibold">Sales and stock, month by month</h2>
          <VsLastYearToggle on={vsLastYear} disabled={!hasLastYear} onChange={setVsLastYear} />
        </div>
        <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
          Bars are pieces sold: solid is real (latest data: {latestRealLabel}), dashed is our forecast (recent pace, adjusted
          by last year&apos;s pattern when we have it). The blue line is stock on hand: a delivery pushes it up, and the dotted
          part shows it running down if nothing is ordered.
        </p>
        <div className="mt-4">
          <StockSalesChart data={chart} vsLastYear={vsLastYear && hasLastYear} lastCountedWeeksAgo={lastCountedWeeksAgo} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span>Lasts {forecast?.coverEventDays != null ? `~${Math.round(forecast.coverEventDays * 10) / 10} selling days` : '—'} · {forecast?.runsOutLabel ?? '—'}.</span>
          {runsOutLabel && <span className="font-semibold text-red-600 dark:text-red-400">{runsOutLabel}</span>}
        </div>
        {countsMatched != null && (
          <div className={cn('mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs',
            countsMatched ? 'border-emerald-600/20 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-300' : 'border-amber-600/20 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300')}>
            {countsMatched ? <Check className="size-3.5 shrink-0" /> : <TriangleAlert className="size-3.5 shrink-0" />}
            {countsMatched
              ? 'Store counts matched the register in each of the last 3 months.'
              : 'A store count differed from the register in the last 3 months.'}
          </div>
        )}
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border bg-card p-5">
          <h2 className="mb-3 text-sm font-semibold">How many sold</h2>
          {series.every((m) => m.sold === 0) ? (
            <p className="text-sm text-muted-foreground">No sales in the last three months.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {[...series].reverse().map((m) => (
                  <tr key={m.month} className="border-b last:border-0">
                    <td className="py-2 font-mono text-xs text-muted-foreground">{m.month}</td>
                    <td className="py-2 text-right font-medium tabular-nums">{m.sold}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="rounded-xl border bg-card p-5">
          <h2 className="mb-3 text-sm font-semibold">Stock history</h2>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No stock changes recorded for this product.</p>
          ) : (
            <div className="flex flex-col">
              {history.map((h) => {
                const label = h.kind === 'recount' ? 'Edited stock' : h.kind === 'add-void' ? 'Reversed add' : 'Added stock';
                const positive = h.delta > 0;
                return (
                  <div key={h.id} className="flex items-center gap-3 border-b py-2.5 text-sm last:border-0">
                    <span className="shrink-0">
                      <span className="block font-medium">{label}</span>
                      {h.kind === 'recount' && (
                        <span className="block font-mono text-[10.5px] tabular-nums text-muted-foreground">{h.before} → {h.after}</span>
                      )}
                    </span>
                    <span className={cn('shrink-0 font-mono text-sm font-bold tabular-nums', positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                      {positive ? '+' : ''}{h.delta}
                    </span>
                    <span className="ml-auto min-w-0 text-right font-mono text-[10.5px] leading-tight text-muted-foreground">
                      <span className="block truncate font-semibold text-foreground/80" title={h.created_by ?? 'unknown'}>{h.created_by ?? 'unknown'}</span>
                      {when(h.created_at)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {!boxmeFirst && boxme}
    </div>
  );
}

function VsLastYearToggle({on, disabled, onChange}: {on: boolean; disabled: boolean; onChange: (v: boolean) => void}) {
  return (
    <label
      title={disabled ? 'No last-year data for this product yet' : undefined}
      className={cn('inline-flex shrink-0 select-none items-center gap-2 text-xs font-medium',
        disabled ? 'cursor-not-allowed text-muted-foreground/50' : 'cursor-pointer text-muted-foreground hover:text-foreground')}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)}
        className="size-3.5 rounded border-muted-foreground/40 accent-primary disabled:cursor-not-allowed disabled:opacity-40" />
      vs last year
    </label>
  );
}

function Kpi({big, lbl, small, tone, toneClass}: {big: string; lbl: string; small?: boolean; tone?: 'crit' | 'good'; toneClass?: string}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className={cn('font-bold leading-none', small ? 'text-base' : 'text-2xl', tone === 'crit' && 'text-red-600 dark:text-red-400', tone === 'good' && 'text-emerald-600 dark:text-emerald-400', toneClass)}>{big}</div>
      <div className="mt-1.5 text-xs text-muted-foreground">{lbl}</div>
    </div>
  );
}

// Year-over-year callout: this month's units against the same month one year ago.
// Shown only when there is a baseline (detail.yoy set). Green up / red down.
function YoyStrip({yoy}: {yoy: NonNullable<ProductDetail['yoy']>}) {
  const d = yoy.deltaPct ?? 0;
  const up = d > 0, flat = d === 0;
  const cls = flat ? 'text-muted-foreground' : up ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-card px-4 py-3 text-sm">
      <span className="font-semibold">Year over year</span>
      <span className="text-muted-foreground">this month <span className="font-mono font-semibold tabular-nums text-foreground">{yoy.thisMonth}</span> vs {yoy.monthLabel} <span className="font-mono font-semibold tabular-nums text-foreground">{yoy.lastYearSold}</span></span>
      <span className={cn('font-mono text-xs font-bold tabular-nums', cls)}>{flat ? '±' : up ? '▲' : '▼'}{Math.abs(d)}%</span>
    </div>
  );
}
