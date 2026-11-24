'use client';

// Hand-drawn SVG for the Restock product page: the product's last 12 months of POS Sales
// Data (last year's window solid, the rest faded, safety month tagged, a month that isn't
// loaded dashed in amber), a divider, then the run's months as dashed bars copied from last
// year's same months. Underneath, a stock strip: on hand now, the projection with the send
// (solid) and without it (dotted), and a triangle where the send lands. Same colours and
// approach as stock-sales-chart.tsx, whose copy is about recent pace, so it isn't reused.

import {useState} from 'react';
import {cn} from '@/lib/utils';
import type {ProjectionMonth, YearMonth} from '@/src/goldline-restock-item';

const W = 760;
const H = 392;
const PAD_L = 38;
const PAD_R = 14;
const GAP = 14; // between the year and the run
const SOLD_TOP = 46;
const SOLD_BOTTOM = 220;
const STOCK_LABEL_Y = 248;
const STOCK_TOP = 272;
const STOCK_BOTTOM = 330;
const AXIS_Y = 362;

type Hover = {xPct: number; yPct: number; title: string; lines: string[]} | null;

const short = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {month: 'short', timeZone: 'UTC'});
};
const long = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {month: 'short', year: 'numeric', timeZone: 'UTC'});
};
const fmt = (n: number) => n.toLocaleString('en-US');

export function RestockYearChart({year, projection, have, send}: {year: YearMonth[]; projection: ProjectionMonth[]; have: number | null; send: number | null}) {
  const [hover, setHover] = useState<Hover>(null);
  const n = year.length + projection.length;
  const colW = (W - PAD_L - PAD_R - GAP) / n;
  const cx = (i: number) => PAD_L + colW * (i + 0.5) + (i >= year.length ? GAP : 0);
  const dividerX = PAD_L + colW * year.length + GAP / 2;
  const barW = colW * 0.56;

  const soldVals = [...year.map((m) => m.units ?? 0), ...projection.map((m) => m.units ?? 0)];
  const niceMax = Math.max(10, Math.ceil(Math.max(...soldVals) / 10) * 10);
  const sy = (v: number) => SOLD_BOTTOM - (v / niceMax) * (SOLD_BOTTOM - SOLD_TOP);
  const gridVals = Array.from({length: 5}, (_, k) => Math.round((niceMax * k) / 4));

  const withSend = have != null && send != null && send > 0;
  const stockPeak = Math.max(1, have ?? 0, withSend ? have! + send! : 0, ...projection.map((m) => Math.max(m.stockWith ?? 0, m.stockWithout ?? 0)));
  const ky = (v: number) => STOCK_BOTTOM - (Math.max(0, v) / stockPeak) * (STOCK_BOTTOM - STOCK_TOP);
  const nowX = dividerX;
  const withPts = withSend ? [`${nowX},${ky(have!)}`, `${nowX + 3},${ky(have! + send!)}`, ...projection.flatMap((m, j) => (m.stockWith == null ? [] : [`${cx(year.length + j)},${ky(m.stockWith)}`]))] : [];
  const withoutPts = have != null ? [`${nowX},${ky(have)}`, ...projection.flatMap((m, j) => (m.stockWithout == null ? [] : [`${cx(year.length + j)},${ky(m.stockWithout)}`]))] : [];
  const outAt = have != null ? projection.findIndex((m) => m.stockWithout === 0) : -1;

  const show = (i: number, y: number, title: string, lines: string[]) => setHover({xPct: (cx(i) / W) * 100, yPct: (y / H) * 100, title, lines});
  const clear = () => setHover(null);

  return (
    <div className="relative w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Pieces sold in each of the last 12 months, then the run's months forecast from last year, with stock on hand below">
        <g className="text-border">
          {gridVals.map((v) => (
            <line key={v} x1={PAD_L} x2={W - PAD_R} y1={sy(v)} y2={sy(v)} stroke="currentColor" strokeWidth={1} strokeOpacity={0.6} />
          ))}
        </g>
        <g className="fill-muted-foreground text-[10px]" style={{fontVariantNumeric: 'tabular-nums'}}>
          {gridVals.map((v) => (
            <text key={v} x={PAD_L - 6} y={sy(v) + 3} textAnchor="end">
              {v}
            </text>
          ))}
        </g>

        <line x1={dividerX} x2={dividerX} y1={SOLD_TOP - 26} y2={STOCK_BOTTOM} className="text-border" stroke="currentColor" strokeWidth={1} strokeDasharray="3 4" />
        <text x={dividerX - 6} y={SOLD_TOP - 14} textAnchor="end" className="fill-muted-foreground text-[10px] font-medium">
          Last 12 months
        </text>
        <text x={dividerX + 6} y={SOLD_TOP - 14} className="fill-[var(--primary)] text-[10px] font-semibold">
          This run
        </text>

        {/* The year */}
        {year.map((m, i) => {
          if (m.units == null) {
            return (
              <g key={m.month} className="cursor-pointer" onMouseEnter={() => show(i, SOLD_BOTTOM - 40, long(m.month), ["POS Sales Data isn't loaded"])} onMouseLeave={clear}>
                <rect x={cx(i) - barW / 2} y={SOLD_BOTTOM - 40} width={barW} height={40} rx={2.5} fill="var(--status-warn)" fillOpacity={0.1} stroke="var(--status-warn)" strokeWidth={1.2} strokeDasharray="3 3" />
                <text x={cx(i)} y={SOLD_BOTTOM - 46} textAnchor="middle" className="fill-[var(--status-warn)] text-[10px] font-semibold">
                  ?
                </text>
              </g>
            );
          }
          const y = sy(m.units);
          const lines = [`${fmt(m.units)} pcs sold`, m.safety ? "In last year's window, and the safety month" : m.inWindow ? "In last year's window" : 'Shown for context'];
          return (
            <g key={m.month} className="cursor-pointer" onMouseEnter={() => show(i, y, long(m.month), lines)} onMouseLeave={clear}>
              <rect x={cx(i) - barW / 2} y={y} width={barW} height={Math.max(0, SOLD_BOTTOM - y)} rx={2.5} fill="var(--primary)" fillOpacity={m.inWindow ? 0.95 : 0.3} />
              <text x={cx(i)} y={y - 6} textAnchor="middle" className={cn('text-[10px] font-semibold', m.inWindow ? 'fill-foreground' : 'fill-muted-foreground')} style={{fontVariantNumeric: 'tabular-nums'}}>
                {fmt(m.units)}
              </text>
            </g>
          );
        })}

        {/* The run */}
        {projection.map((m, j) => {
          const i = year.length + j;
          const units = m.units;
          if (units == null) return null;
          const y = sy(units);
          return (
            <g key={m.month} className="cursor-pointer" onMouseEnter={() => show(i, y, `${long(m.month)} forecast`, [`~${fmt(units)} pcs`, `what ${long(m.lastYear)} sold`])} onMouseLeave={clear}>
              <rect x={cx(i) - barW / 2} y={y} width={barW} height={Math.max(0, SOLD_BOTTOM - y)} rx={2.5} fill="var(--primary)" fillOpacity={0.12} stroke="var(--primary)" strokeWidth={1.5} strokeDasharray="4 3" />
              <text x={cx(i)} y={y - 6} textAnchor="middle" className="fill-muted-foreground text-[10px] font-semibold" style={{fontVariantNumeric: 'tabular-nums'}}>
                ~{fmt(units)}
              </text>
            </g>
          );
        })}

        {/* Stock strip */}
        <text x={PAD_L} y={STOCK_LABEL_Y} className="fill-foreground text-[11px] font-semibold">
          Stock on hand
        </text>
        <line x1={PAD_L} x2={W - PAD_R} y1={STOCK_BOTTOM} y2={STOCK_BOTTOM} className="text-border" stroke="currentColor" strokeWidth={1} />
        {have == null ? (
          <text x={dividerX + 8} y={STOCK_BOTTOM - 8} className="fill-muted-foreground text-[10px]">
            No stock figure, so no projection
          </text>
        ) : (
          <>
            {withoutPts.length > 1 && <polyline points={withoutPts.join(' ')} fill="none" stroke="var(--status-crit)" strokeWidth={1.8} strokeDasharray="2 4" strokeLinecap="round" />}
            {withPts.length > 1 && <polyline points={withPts.join(' ')} fill="none" className="text-blue-600 dark:text-blue-400" stroke="currentColor" strokeWidth={2.5} />}
            <circle cx={nowX} cy={ky(have)} r={4} className="fill-foreground" />
            <text x={nowX - 7} y={ky(have) + 4} textAnchor="end" className="fill-foreground text-[10px] font-semibold" style={{fontVariantNumeric: 'tabular-nums'}}>
              {fmt(have)} now
            </text>
            {withSend && (
              <g className="text-blue-600 dark:text-blue-400">
                <path d={`M ${nowX + 3} ${ky(have + send!) - 6} l 6 -10 h -12 z`} fill="currentColor" />
                <text x={nowX + 13} y={ky(have + send!) - 8} className="fill-current text-[10px] font-semibold" style={{fontVariantNumeric: 'tabular-nums'}}>
                  send {fmt(send!)}
                </text>
              </g>
            )}
            {withSend &&
              projection.map((m, j) =>
                m.stockWith == null ? null : (
                  <g key={m.month} className="cursor-pointer text-blue-600 dark:text-blue-400" onMouseEnter={() => show(year.length + j, ky(m.stockWith!), `End of ${long(m.month)}`, [`~${fmt(m.stockWith!)} pcs with the send`, `~${fmt(m.stockWithout ?? 0)} without it`])} onMouseLeave={clear}>
                    <circle cx={cx(year.length + j)} cy={ky(m.stockWith!)} r={4} fill="currentColor" />
                    <text x={cx(year.length + j)} y={ky(m.stockWith!) - 8} textAnchor="middle" className="fill-current text-[10px] font-semibold" style={{fontVariantNumeric: 'tabular-nums'}}>
                      {fmt(m.stockWith!)}
                    </text>
                    <circle cx={cx(year.length + j)} cy={ky(m.stockWith!)} r={11} fill="transparent" />
                  </g>
                ),
              )}
            {outAt >= 0 && (
              <text x={cx(year.length + outAt)} y={STOCK_BOTTOM + 13} textAnchor="middle" className="fill-[var(--status-crit)] text-[10px] font-semibold">
                {withSend ? 'out without it' : 'runs out'}
              </text>
            )}
          </>
        )}

        {/* Month labels */}
        <g style={{fontVariantNumeric: 'tabular-nums'}}>
          {year.map((m, i) => (
            <g key={m.month}>
              <text x={cx(i)} y={AXIS_Y} textAnchor="middle" className={cn('text-[10.5px]', m.inWindow ? 'fill-foreground font-semibold' : 'fill-muted-foreground')}>
                {short(m.month)}
              </text>
              {(i === 0 || m.month.endsWith('-01')) && (
                <text x={cx(i)} y={AXIS_Y + 13} textAnchor="middle" className="fill-muted-foreground text-[9.5px]">
                  {m.month.slice(0, 4)}
                </text>
              )}
              {m.safety && (
                <text x={cx(i)} y={AXIS_Y + 25} textAnchor="middle" className="fill-[var(--primary)] text-[9.5px] font-semibold">
                  Safety
                </text>
              )}
            </g>
          ))}
          {projection.map((m, j) => (
            <g key={m.month}>
              <text x={cx(year.length + j)} y={AXIS_Y} textAnchor="middle" className="fill-[var(--primary)] text-[10.5px] font-semibold">
                {short(m.month)}
              </text>
              {(j === 0 || m.month.endsWith('-01')) && (
                <text x={cx(year.length + j)} y={AXIS_Y + 13} textAnchor="middle" className="fill-muted-foreground text-[9.5px]">
                  {m.month.slice(0, 4)}
                </text>
              )}
            </g>
          ))}
        </g>
      </svg>

      {hover && (
        <div
          className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full rounded-lg bg-neutral-900 px-3 py-2 text-left shadow-lg dark:bg-neutral-800"
          style={{left: `${hover.xPct}%`, top: `calc(${hover.yPct}% - 10px)`}}
        >
          <div className="text-[11px] font-semibold text-neutral-50">{hover.title}</div>
          {hover.lines.map((l, k) => (
            <div key={k} className="whitespace-nowrap text-[11px] text-neutral-300">
              {l}
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-primary" /> Last year&apos;s window
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-primary/30" /> Other months
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] border border-dashed border-primary" /> Forecast, same month last year
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-blue-600 dark:bg-blue-400" /> Stock with the send
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-4 border-t-2 border-dotted border-[var(--status-crit)]" /> Without it
        </span>
      </div>
    </div>
  );
}
