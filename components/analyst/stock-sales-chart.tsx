'use client';

// Bespoke two-panel SVG chart for the product detail page. Top: pieces sold per
// month (solid bars = real, dashed = forecast) with a connecting line + value
// labels. Bottom: a stock-on-hand strip with the blue line running down, delivery
// triangles, a "last counted" note, and the "runs out" marker. A dotted divider
// splits the 3 real months from the 3 forecast months. Colours come through
// currentColor + theme tokens so both light and dark render correctly. Recharts is
// too rigid for this composition, so it is hand-drawn.

import {useState} from 'react';
import {cn} from '@/lib/utils';
import type {ChartMonth} from '@/src/pos-product-detail';

const W = 760;
const H = 412;
const PAD_L = 38;
const PAD_R = 18;
const SOLD_TOP = 44; // y at the sold-axis max
const SOLD_BOTTOM = 236; // y at sold = 0
const STOCK_LABEL_Y = 262;
const STOCK_TOP = 288; // y at stock max
const STOCK_BOTTOM = 340; // y at stock = 0
const AXIS_Y = 376;

type Tone = 'green' | 'blue' | 'red' | 'grey';
type Hover = {xPct: number; yPct: number; title: string; lines: string[]; tone: Tone} | null;

export function StockSalesChart({data, vsLastYear, lastCountedWeeksAgo}: {
  data: ChartMonth[];
  vsLastYear: boolean;
  lastCountedWeeksAgo: number | null;
}) {
  const [hover, setHover] = useState<Hover>(null);
  const n = data.length;
  const plotL = PAD_L;
  const plotW = W - PAD_L - PAD_R;
  const colW = plotW / n;
  const cx = (i: number) => plotL + colW * (i + 0.5);
  const firstForecast = Math.max(1, data.findIndex((d) => d.isForecast));
  const dividerX = plotL + colW * firstForecast;

  // Sold axis: nice max rounded up to a multiple of 20, five gridlines.
  const soldVals = data.flatMap((d) => [d.sold ?? 0, d.soldForecast ?? 0, vsLastYear ? d.soldLastYear ?? 0 : 0]);
  const niceMax = Math.max(20, Math.ceil(Math.max(...soldVals) / 20) * 20);
  const sy = (v: number) => SOLD_BOTTOM - (v / niceMax) * (SOLD_BOTTOM - SOLD_TOP);
  const gridVals = Array.from({length: 6}, (_, k) => Math.round((niceMax * k) / 5));

  // Stock axis: fills the thin bottom band.
  const stockMax = Math.max(1, ...data.map((d) => d.stockEnd ?? d.stockForecast ?? 0));
  const ky = (v: number) => STOCK_BOTTOM - (Math.min(stockMax, Math.max(0, v)) / stockMax) * (STOCK_BOTTOM - STOCK_TOP);

  const barW = colW * 0.4;
  const show = (i: number, y: number, title: string, lines: string[], tone: Tone) =>
    setHover({xPct: (cx(i) / W) * 100, yPct: (y / H) * 100, title, lines, tone});
  const clear = () => setHover(null);

  // Sold connecting line: solid across real, dashed across forecast (sharing the
  // last real point as the junction).
  // A null value is "no data" (e.g. a month nobody counted): no bar, no point.
  const soldVal = (d: ChartMonth) => (d.isForecast ? d.soldForecast : d.sold);
  const pts = (from: number, to: number) =>
    data
      .slice(from, to)
      .map((d, k) => [from + k, soldVal(d)] as const)
      .filter(([, v]) => v != null)
      .map(([i, v]) => `${cx(i)},${sy(v as number)}`)
      .join(' ');
  const realPts = pts(0, firstForecast);
  const fcPts = pts(firstForecast - 1, n);

  // Stock lines.
  const realStock = data.filter((d) => !d.isForecast && d.stockEnd != null);
  const realStockPts = realStock.map((d) => `${cx(data.indexOf(d))},${ky(d.stockEnd as number)}`).join(' ');
  const fcStock = data.slice(firstForecast - 1).filter((d) => (d.stockForecast ?? d.stockEnd) != null); // last real = junction
  const fcStockPts = fcStock
    .map((d) => `${cx(data.indexOf(d))},${ky((d.stockForecast ?? d.stockEnd) as number)}`)
    .join(' ');
  const firstStockX = realStock.length ? cx(data.indexOf(realStock[0])) : 0;
  const lastStockX = realStock.length ? cx(data.indexOf(realStock[realStock.length - 1])) : 0;
  const areaPath = realStock.length
    ? `M ${firstStockX},${ky(realStock[0].stockEnd as number)} ` +
      realStock.map((d) => `L ${cx(data.indexOf(d))},${ky(d.stockEnd as number)}`).join(' ') +
      ` L ${lastStockX},${STOCK_BOTTOM} L ${firstStockX},${STOCK_BOTTOM} Z`
    : '';

  return (
    <div className="relative w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
        aria-label="Pieces sold and stock on hand over the last three months and the next three forecast months">
        {/* Sold gridlines + y labels */}
        <g className="text-border">
          {gridVals.map((v) => (
            <line key={v} x1={plotL} x2={W - PAD_R} y1={sy(v)} y2={sy(v)} stroke="currentColor" strokeWidth={1} strokeOpacity={0.6} />
          ))}
        </g>
        <g className="fill-muted-foreground text-[10px]" style={{fontVariantNumeric: 'tabular-nums'}}>
          {gridVals.map((v) => (
            <text key={v} x={plotL - 6} y={sy(v) + 3} textAnchor="end">{v}</text>
          ))}
        </g>

        {/* Forecast divider */}
        <line x1={dividerX} x2={dividerX} y1={SOLD_TOP - 18} y2={STOCK_BOTTOM} className="text-border" stroke="currentColor" strokeWidth={1} strokeDasharray="3 4" />
        <text x={dividerX + 6} y={SOLD_TOP - 8} className="fill-muted-foreground text-[10px] font-medium">forecast →</text>

        {/* vs-last-year: a "same month last year" bar behind each month's bar. Drawn
            first so this year's solid/dashed bar sits in front; it's a touch wider so
            a sliver always peeks out and stays hoverable even where they overlap. */}
        {vsLastYear && (
          <g className="text-muted-foreground">
            {data.map((d, i) => {
              if (d.soldLastYear == null) return null;
              const y = sy(d.soldLastYear);
              const w = barW + colW * 0.22;
              return (
                <rect key={d.key} x={cx(i) - w / 2} y={y} width={w} height={Math.max(0, SOLD_BOTTOM - y)} rx={2.5}
                  fill="currentColor" fillOpacity={0.3} className="cursor-pointer"
                  onMouseEnter={() => show(i, y, `${d.label} last year`, [`${d.soldLastYear} pcs sold`], 'grey')} onMouseLeave={clear} />
              );
            })}
          </g>
        )}

        {/* Sold bars */}
        <g className="text-emerald-600 dark:text-emerald-400">
          {data.map((d, i) => {
            const v = soldVal(d);
            if (v == null) return null;
            const y = sy(v);
            const h = SOLD_BOTTOM - y;
            const title = d.isForecast ? `${d.label} forecast` : d.label;
            const lines = d.isForecast ? [`~${v} pcs`, 'recent pace, adjusted by last year'] : [`${v} pcs sold`];
            return (
              <rect key={d.key} x={cx(i) - barW / 2} y={y} width={barW} height={Math.max(0, h)} rx={2.5}
                fill="currentColor" fillOpacity={d.isForecast ? 0.12 : 0.9}
                stroke="currentColor" strokeWidth={d.isForecast ? 1.5 : 0} strokeDasharray={d.isForecast ? '4 3' : undefined}
                className="cursor-pointer"
                onMouseEnter={() => show(i, y, title, lines, 'green')} onMouseLeave={clear} />
            );
          })}
        </g>

        {/* Sold connecting line + value labels */}
        <g className="text-emerald-600 dark:text-emerald-400">
          <polyline points={realPts} fill="none" stroke="currentColor" strokeWidth={2} />
          <polyline points={fcPts} fill="none" stroke="currentColor" strokeWidth={2} strokeDasharray="5 4" strokeOpacity={0.8} />
        </g>
        <g className="fill-foreground text-[11px] font-semibold" style={{fontVariantNumeric: 'tabular-nums'}}>
          {data.map((d, i) => {
            const v = soldVal(d);
            if (v == null) return null;
            return <text key={d.key} x={cx(i)} y={sy(v) - 8} textAnchor="middle" className={d.isForecast ? 'fill-muted-foreground' : ''}>{d.isForecast ? `~${v}` : v}</text>;
          })}
        </g>

        {/* Stock panel label */}
        <text x={plotL} y={STOCK_LABEL_Y} className="fill-foreground text-[11px] font-semibold">Stock on hand</text>

        {/* Stock area + lines */}
        <g className="text-blue-600 dark:text-blue-400">
          {areaPath && <path d={areaPath} fill="currentColor" fillOpacity={0.08} stroke="none" />}
          <polyline points={realStockPts} fill="none" stroke="currentColor" strokeWidth={2.5} />
          <polyline points={fcStockPts} fill="none" stroke="currentColor" strokeWidth={2.5} strokeDasharray="2 5" strokeLinecap="round" strokeOpacity={0.85} />
          {/* real points (filled) */}
          {realStock.map((d) => {
            const i = data.indexOf(d);
            const y = ky(d.stockEnd as number);
            return (
              <g key={d.key} className="cursor-pointer"
                onMouseEnter={() => show(i, y, `End of ${title(d.label)}`, [`${d.stockEnd} pcs on hand`], 'blue')} onMouseLeave={clear}>
                <circle cx={cx(i)} cy={y} r={4} fill="currentColor" />
                <circle cx={cx(i)} cy={y} r={11} fill="transparent" />
              </g>
            );
          })}
          {/* forecast points (hollow) */}
          {data.filter((d) => d.isForecast && d.stockForecast != null).map((d) => {
            const i = data.indexOf(d);
            const y = ky(d.stockForecast ?? 0);
            return (
              <g key={d.key} className="cursor-pointer"
                onMouseEnter={() => show(i, y, `End of ${title(d.label)} (projected)`, [`~${d.stockForecast} pcs left if nothing is ordered`], 'blue')} onMouseLeave={clear}>
                <circle cx={cx(i)} cy={y} r={4} className="fill-card" stroke="currentColor" strokeWidth={2} />
                <circle cx={cx(i)} cy={y} r={11} fill="transparent" />
              </g>
            );
          })}
        </g>

        {/* Delivery triangles + labels */}
        <g className="text-blue-600 dark:text-blue-400">
          {data.map((d, i) => {
            if (!d.delivery) return null;
            const y = ky(d.stockEnd ?? 0);
            const ty = y - 13;
            return (
              <g key={d.key} className="cursor-pointer"
                onMouseEnter={() => show(i, ty, `Delivery ${d.delivery!.dateLabel}`, [`${d.delivery!.qty} pcs arrived at the store`], 'blue')} onMouseLeave={clear}>
                <path d={`M ${cx(i)} ${ty - 5} L ${cx(i) + 6} ${ty + 5} L ${cx(i) - 6} ${ty + 5} Z`} fill="currentColor" />
                <text x={cx(i)} y={y + 15} textAnchor="middle" className="fill-current text-[10px] font-semibold" style={{fontVariantNumeric: 'tabular-nums'}}>+{d.delivery.qty}</text>
                <circle cx={cx(i)} cy={ty} r={12} fill="transparent" />
              </g>
            );
          })}
        </g>

        {/* last counted note */}
        {lastCountedWeeksAgo != null && (
          <text x={cx(0)} y={STOCK_BOTTOM + 14} textAnchor="middle" className="fill-muted-foreground text-[10px]">
            {lastCountedWeeksAgo === 0 ? 'last counted this week' : `last counted ~${lastCountedWeeksAgo} ${lastCountedWeeksAgo === 1 ? 'wk' : 'wks'} ago`}
          </text>
        )}
        {/* runs out marker */}
        {data.map((d, i) => d.runsOut ? (
          <text key={d.key} x={cx(i)} y={STOCK_BOTTOM + 14} textAnchor="middle" className="fill-red-600 text-[10px] font-semibold dark:fill-red-400">runs out</text>
        ) : null)}

        {/* X axis month labels (current month boxed) */}
        <g style={{fontVariantNumeric: 'tabular-nums'}}>
          {data.map((d, i) => (
            <g key={d.key}>
              {d.isCurrent && (
                <rect x={cx(i) - 22} y={AXIS_Y - 13} width={44} height={20} rx={5} className="fill-none stroke-foreground" strokeWidth={1.2} />
              )}
              <text x={cx(i)} y={AXIS_Y} textAnchor="middle"
                className={cn('text-[11px] font-semibold', d.isForecast ? 'fill-muted-foreground' : 'fill-foreground')}>
                {d.label}
              </text>
            </g>
          ))}
        </g>
      </svg>

      {hover && (
        <div className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full rounded-lg bg-neutral-900 px-3 py-2 text-left shadow-lg dark:bg-neutral-800"
          style={{left: `${hover.xPct}%`, top: `calc(${hover.yPct}% - 10px)`}}>
          <div className="text-[11px] font-semibold text-neutral-50">{hover.title}</div>
          {hover.lines.map((l, k) => (
            <div key={k} className="whitespace-nowrap text-[11px] text-neutral-300">{l}</div>
          ))}
        </div>
      )}

      {/* Legend */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-[3px] bg-emerald-600 dark:bg-emerald-400" /> Sold this year</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-[3px] border border-dashed border-emerald-600 dark:border-emerald-400" /> Forecast</span>
        {vsLastYear && <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-[3px] bg-muted-foreground/30" /> Same month last year</span>}
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-blue-600 dark:bg-blue-400" /> Stock on hand</span>
        <span className="inline-flex items-center gap-1.5"><Triangle /> Delivery arrived</span>
      </div>
    </div>
  );
}

function title(label: string): string {
  return label.charAt(0) + label.slice(1).toLowerCase();
}

function Triangle() {
  return (
    <svg width="11" height="10" viewBox="0 0 11 10" aria-hidden className="text-blue-600 dark:text-blue-400">
      <path d="M5.5 0 L11 10 L0 10 Z" fill="currentColor" />
    </svg>
  );
}
