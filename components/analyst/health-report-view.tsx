'use client';

import {Fragment, useCallback, useEffect, useMemo, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {Check, ChevronDown, ChevronLeft, ChevronRight, Lock, Rows3, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {HelpTip as InfoTip} from './help-tip';
import {axisTicks, fmtAxisTick} from '@/src/plan-axis';
import {PLAN_HELP} from '@/src/plan-help';
import type {PlanVersionInfo} from '@/src/plan-data';
import {closeMonthAction, savePlanLineAction, unlockMonthAction} from '@/src/plan-actions';
import {
  METRICS, cardMonths, currentIndex, fmtPlan, metricStatus, monthPhase, runwayMonths, stepWindow, windowStart,
  GAP, GRID_LINE_LABEL, LINES, MEASURE_LINES, REQUIRED_COUNT, derivedActuals, applySnapshots, closeQueue, closeWaiting, closeWaitingWho, earlierUnclosed, lastPastMonths, daysSinceMonthEnd, nextEmptyLine, REQUIRED_LINE_ORDER, filledCount, monthComplete, monthEnded, closeAction, closeBlocker, monthTag, stockOrderSeries, withTotals, type ActualCell, type ClosedMonth, type LineSeries, type MetricDef, type PlanData, type Status,
} from '@/src/plan-compute';
import {SHEET_ROWS, blockOf, rowOfLine} from '@/src/plan-sheet';
import {GROUP_ROW, LABEL_CELL, SheetRows, STATUS_TEXT, cellActual, cellOf, monthLabel, type Actuals, type Edit} from './plan-sheet-rows';

// Business Health Report: the workbook plan month by month beside the actuals. GMV actuals (BHR-02) come from Coop's readers; a month with
// no data is an empty cell that says waiting, never PHP 0 and never red. Green = met or beat, red = missed, grey = waiting, partial,
// month in progress, or no source.
const WINDOW = 3;
/** Chart axis: every month is labelled; the year shows on the first month and each January so 17 labels still fit. */
const axisLabel = (m: string, i: number) => (i === 0 || m.slice(5, 7) === '01' ? monthLabel(m).replace("'", '’') : monthLabel(m).split("'")[0]);
const shortMonth = (m: string) => monthLabel(m).split("'")[0];

const EMPTY_CLOSES: Record<string, ClosedMonth> = {};
const EMPTY_ACTUALS: Actuals = {};
const EMPTY_LINES: LineSeries = {};
const NO_EDIT: Edit = {canEdit: false, lines: {}, closes: EMPTY_CLOSES, today: '', save: async () => 'Read only.', close: async () => 'Read only.', askUnlock: () => {}, ring: null, clearRing: () => {}, next: () => false};
const NEUTRAL = new Set<string>(['coverage']);
function statusOf(m: MetricDef, plan: PlanData, i: number, nowKey: string, actuals: Actuals): Status {
  return metricStatus({direction: m.direction, actual: cellOf(actuals, m.id, i).value, partial: cellOf(actuals, m.id, i).state === 'partial', target: plan.targets[m.id]?.[i] ?? null, phase: monthPhase(plan.months[i], nowKey), hasSource: m.source !== 'none', informational: NEUTRAL.has(m.id), modelled: m.modelled});
}

/** Mark beside a status in a card header: a drawn icon, never a text glyph. */
function StatusMark({status}: {status: Status}) {
  if (status === 'ok') return <Check className="size-3" strokeWidth={2.5} aria-hidden />;
  if (status === 'bad') return <X className="size-3" strokeWidth={2.5} aria-hidden />;
  return null;
}
const pctText = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(0)}%`;
const CARDS = 'grid grid-cols-3 gap-2.5 max-[1000px]:grid-cols-2 max-[560px]:-mx-4 max-[560px]:flex max-[560px]:snap-x max-[560px]:snap-mandatory max-[560px]:overflow-x-auto max-[560px]:px-4 max-[560px]:pb-3 max-[560px]:[scrollbar-width:none]';
/** The month a card leads with: the last month that has ended (the current month is still in progress and shows in the chart and the grid). */
const leadIndex = (months: readonly string[], nowKey: string) => Math.max(0, currentIndex(months, nowKey) - 1);

type PastMonth = {month: string; value: string; target?: string; chip: string; status: Status};
/** The past-3-months view on a card: each of the last three ended months with its own label, value and status chip, most recent last. No data reads waiting, never 0. */
function PastMonths({label, items}: {label: string; items: PastMonth[]}) {
  if (!items.length) return null;
  return (
    <ul className="mt-1.5 grid grid-cols-3 gap-1.5" aria-label={`${label}, past 3 months`} data-testid="past-months">
      {items.map((it) => (
        <li key={it.month} data-month={it.month} data-status={it.chip} className="min-w-0 rounded-md bg-muted/60 px-2 py-1">
          <span className="block text-[10.5px] font-medium uppercase tracking-[0.06em] text-muted-foreground">{shortMonth(it.month)}</span>
          <span className={cn('block truncate text-[13px] font-medium tabular-nums', it.value === '—' && 'text-muted-foreground')}>{it.value}</span>
          {it.target && <span className="block truncate text-[10.5px] tabular-nums text-muted-foreground">target {it.target}</span>}
          <span className={cn('block truncate text-[11px] font-semibold', it.status === 'ok' ? 'text-[var(--status-good)]' : it.status === 'bad' ? 'text-[var(--status-crit)]' : 'font-medium text-muted-foreground')}>{it.chip}</span>
        </li>
      ))}
    </ul>
  );
}

/** One card: label and status top, the last closed month's figure, its target, then the actual-against-target line. The top rule carries the status colour. */
function Tile({label, status, chip, value, sub, why, tip, foot, months, children}: {months?: PastMonth[]; label: string; status: Status; chip: string; value: string; sub: string; why?: () => void; tip?: string; foot?: React.ReactNode; children: React.ReactNode}) {
  return (
    <article className={cn('min-w-0 rounded-lg border border-border border-t-2 bg-card px-3.5 pb-2 pt-2.5 max-[560px]:shrink-0 max-[560px]:basis-[84%] max-[560px]:snap-center', status === 'ok' ? 'border-t-[var(--status-good)]' : status === 'bad' ? 'border-t-[var(--status-crit)]' : 'border-t-muted')} aria-label={label}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">{label}</h3>
        <span className={cn('inline-flex items-center gap-1 text-[12.5px] font-semibold tabular-nums', status === 'ok' && 'text-[var(--status-good)]', status === 'bad' && 'text-[var(--status-crit)]', status !== 'ok' && status !== 'bad' && 'font-medium text-muted-foreground')}><StatusMark status={status} />{chip}{tip && <InfoTip text={tip} label={`About ${label}`} className="-my-2 -mr-1.5" />}</span>
      </div>
      <div className={cn('mt-0.5 font-serif text-xl leading-tight tabular-nums max-[560px]:text-[22px]', value === '—' && 'text-muted-foreground')}>{value}</div>
      <div className="flex h-[18px] items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground"><span className="truncate" title={sub}>{sub}</span>{why && <button type="button" onClick={why} className="text-primary underline underline-offset-2">Why?</button>}</div>
      {months && <PastMonths label={label} items={months} />}
      {children}
      {foot}
    </article>
  );
}

function KeyCard({m, plan, nowKey, actuals, onWhy, tip, foot}: {foot?: React.ReactNode; m: MetricDef; plan: PlanData; nowKey: string; actuals: Actuals; onWhy: (id: string, i: number) => void; tip?: string}) {
  const i = leadIndex(plan.months, nowKey);
  const st = statusOf(m, plan, i, nowKey, actuals);
  const c = cellOf(actuals, m.id, i), t = plan.targets[m.id]?.[i] ?? null;
  const chip = c.value === null ? 'waiting' : (st === 'ok' || st === 'bad') && t ? pctText(((c.value - t) / Math.abs(t)) * 100) : STATUS_TEXT[st].toLowerCase();
  return (
    <Tile label={m.label} status={st} chip={chip} value={c.value === null ? '—' : fmtPlan(m.unit, c.value)} sub={`${shortMonth(plan.months[i])} · target ${fmtPlan(m.unit, t)}${c.state === 'partial' ? ' · partial' : ''}`} why={st === 'bad' ? () => onWhy(m.id, i) : undefined} foot={foot} months={lastPastMonths(plan.months, nowKey).map((k) => { const cc = cellOf(actuals, m.id, k), ss = statusOf(m, plan, k, nowKey, actuals); return {month: plan.months[k], value: cc.value === null ? '—' : fmtPlan(m.unit, cc.value), target: fmtPlan(m.unit, plan.targets[m.id]?.[k]), chip: cc.value === null ? 'waiting' : (ss === 'ok' || ss === 'bad') && plan.targets[m.id]?.[k] ? pctText(((cc.value - (plan.targets[m.id]?.[k] as number)) / Math.abs(plan.targets[m.id]?.[k] as number)) * 100) : STATUS_TEXT[ss].toLowerCase(), status: cc.value === null ? 'waiting' as Status : ss}; })} tip={tip ?? (c.value === null ? PLAN_HELP.cardWaiting : m.modelled ? PLAN_HELP.modelled : undefined)}>
      <Spark label={m.label} months={plan.months} cur={currentIndex(plan.months, nowKey)} getT={(k) => plan.targets[m.id]?.[k] ?? null}
        getA={(k) => (monthPhase(plan.months[k], nowKey) === 'past' ? cellOf(actuals, m.id, k).value : null)} st={(k) => statusOf(m, plan, k, nowKey, actuals)}
        tip={(k) => `${monthLabel(plan.months[k])}: ${fmtPlan(m.unit, cellOf(actuals, m.id, k).value)} against target ${fmtPlan(m.unit, plan.targets[m.id]?.[k])}`}
        onWhy={(k) => onWhy(m.id, k)} />
    </Tile>
  );
}

/** Actual (solid, closed months only) against target (dashed) for the last six months. A dot carries its status; a red dot opens the breakdown. */
function Spark({label, months, cur, getA, getT, st, tip, onWhy, minActs = 1}: {label: string; months: readonly string[]; cur: number; getA: (i: number) => number | null; getT: (i: number) => number | null; st: (i: number) => Status; tip: (i: number) => string; onWhy?: (i: number) => void; minActs?: number}) {
  const a = Math.max(0, cur - 5), b = Math.min(months.length - 1, cur + 1);
  const idx = Array.from({length: b - a + 1}, (_, k) => a + k);
  const acts = idx.filter((i) => getA(i) !== null);
  const tgs = idx.filter((i) => getT(i) !== null);
  const vals = [...tgs.map((i) => getT(i) as number), ...acts.map((i) => getA(i) as number)];
  if (b === a || vals.length === 0 || acts.length < minActs) return <div className="h-[65px]" data-testid="spark-empty" aria-hidden />;
  const W = 340, H = 65, L = 8, R = 8, T = 6, B = 16;
  let mn = Math.min(...vals), mx = Math.max(...vals);
  if (mx === mn) { mx += 1; mn -= 1; }
  const pad = (mx - mn) * 0.14; mn -= pad; mx += pad;
  const x = (i: number) => L + ((i - a) / (b - a)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - mn) / (mx - mn)) * (H - T - B);
  const line = (ids: number[], f: (i: number) => number | null) => ids.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)} ${y(f(i) as number).toFixed(1)}`).join(' ');
  const dot = (s: Status) => (s === 'ok' ? 'var(--status-good)' : s === 'bad' ? 'var(--status-crit)' : 'var(--muted)');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: actual against target by month`} className="mt-0.5 block h-[65px] w-full overflow-visible" data-testid="spark">
      {tgs.length > 1 && <path d={line(tgs, getT)} fill="none" stroke="var(--muted-foreground)" strokeWidth="1.5" strokeDasharray="4 4" opacity="0.8" />}
      {acts.length > 1 && <path d={line(acts, getA)} fill="none" stroke="var(--foreground)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
      {acts.map((i) => {
        const s = st(i), cx = x(i), cy = y(getA(i) as number);
        const solid = s === 'ok' || s === 'bad';
        return s === 'bad' && onWhy ? (
          <g key={i} role="button" tabIndex={0} aria-label={`${tip(i)}. Missed. See why`} className="cursor-pointer outline-none [&:focus-visible_circle:nth-child(2)]:stroke-[var(--foreground)]" onClick={() => onWhy(i)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onWhy(i); } }}>
            <circle cx={cx} cy={cy} r="13" fill="transparent" /><circle cx={cx} cy={cy} r="4.5" fill={dot(s)} stroke="var(--card)" strokeWidth="2" /><title>{tip(i)}</title>
          </g>
        ) : <circle key={i} cx={cx} cy={cy} r="4.5" fill={dot(s)} stroke={solid ? 'var(--card)' : 'var(--muted-foreground)'} strokeWidth="2"><title>{tip(i)}</title></circle>;
      })}
      {idx.map((i) => <text key={i} x={x(i)} y={H - 3} textAnchor="middle" fontSize="10" fontWeight={i === cur - 1 ? 600 : 500} fill={i === cur - 1 ? 'var(--foreground)' : 'var(--muted-foreground)'}>{shortMonth(months[i])}{i === cur ? ' ◔' : ''}</text>)}
      {tgs.length > 0 && getT(b) !== null && <text x={W - R} y={y(getT(b) as number) - 5} textAnchor="end" fontSize="10" fontWeight="500" fill="var(--muted-foreground)">target</text>}
    </svg>
  );
}

const GMV_CHANNELS = ['gmv_events', 'gmv_website', 'gmv_marketplace'] as const;

/** Why a month missed: Total GMV breaks into its channels (actual against each channel's plan); a channel shows itself. Gaps are named, never zeroed. */
function Drilldown({id, i, plan, actuals, onClose}: {id: string; i: number; plan: PlanData; actuals: Actuals; onClose: () => void}) {
  const rows = (id === 'gmv_total' ? GMV_CHANNELS : [id]).map((mid) => {
    const def = METRICS.find((x) => x.id === mid) as MetricDef;
    const c = cellOf(actuals, mid, i);
    const t = plan.targets[mid]?.[i] ?? null;
    return {def, c, t, gap: c.value !== null && t !== null ? c.value - t : null};
  });
  const mx = Math.max(1, ...rows.map((r) => Math.abs(r.gap ?? 0)));
  const head = METRICS.find((x) => x.id === id) as MetricDef;
  return (
    <section className="mt-4 rounded-lg border border-border border-t-2 border-t-[var(--status-crit)] bg-card p-4" data-testid="drilldown" aria-label="Why the month missed">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-serif text-xl leading-tight">{head.label} missed plan in {monthLabel(plan.months[i])}</h2>
        <button type="button" onClick={onClose} className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-sm">Close</button>
      </div>
      <p className="mt-1 text-[13px] text-muted-foreground">Actual against target, {id === 'gmv_total' ? 'by channel' : 'for this metric'}. Bars grow right when ahead of target, left when behind.</p>
      {rows.map((r) => (
        <div key={r.def.id} className="mt-2.5 grid grid-cols-[96px_minmax(0,1fr)_112px] items-center gap-2.5 text-[13px] max-sm:grid-cols-[76px_minmax(0,1fr)_92px]">
          <span>{r.def.label.replace(' GMV', '')}</span>
          <span className="relative h-[18px] rounded bg-muted after:absolute after:inset-y-[-3px] after:left-1/2 after:w-px after:bg-muted-foreground/60">
            {r.gap !== null && <i className="absolute inset-y-0 rounded-[3px]" style={{[r.gap < 0 ? 'right' : 'left']: '50%', width: `${(Math.abs(r.gap) / mx) * 50}%`, background: r.gap < 0 ? 'var(--status-crit)' : 'var(--status-good)'}} />}
          </span>
          <span className="text-right tabular-nums">{r.c.value === null ? <span className="text-muted-foreground">waiting</span> : `${fmtPlan(r.def.unit, r.c.value)}${r.c.state === 'partial' ? ' (partial)' : ''}`}<span className="block text-xs text-muted-foreground">target {fmtPlan(r.def.unit, r.t)}</span></span>
          {r.c.note && r.c.state === 'ok' && <p className="col-span-full text-xs text-muted-foreground" data-testid="cell-note">{r.c.note}</p>}
        </div>
      ))}
    </section>
  );
}

function RunwayCard({plan, nowKey, actuals, opening}: {plan: PlanData; nowKey: string; actuals: Actuals; opening: number | null}) {
  const cash = plan.months.map((_, i) => cellOf(actuals, 'cash', i).value);
  const cur = currentIndex(plan.months, nowKey), i = leadIndex(plan.months, nowKey);
  const r = runwayMonths(cash, opening, i);
  const series = (k: number) => { if (monthPhase(plan.months[k], nowKey) !== 'past') return null; const v = runwayMonths(cash, opening, k); return typeof v === 'number' ? v : null; };
  const text = (k: number) => { const v = runwayMonths(cash, opening, k); return v === null ? 'waiting' : v === 'not-burning' ? 'not burning' : `${v.toFixed(1)} months`; };
  return (
    <Tile label="Rough runway" status="derived" tip={PLAN_HELP.runway} chip={r === null ? 'waiting' : r === 'not-burning' ? 'cash rising' : 'info only'} value={r === null ? '—' : r === 'not-burning' ? 'Not burning' : `${r.toFixed(1)} mo`} sub={shortMonth(plan.months[i])} months={lastPastMonths(plan.months, nowKey).map((k) => { const v = runwayMonths(cash, opening, k); return {month: plan.months[k], value: v === null ? '—' : v === 'not-burning' ? 'Not burning' : `${v.toFixed(1)} mo`, chip: v === null ? 'waiting' : 'info only', status: (v === null ? 'waiting' : 'derived') as Status}; })}>
      <Spark label="Rough runway" months={plan.months} cur={cur} getT={() => null} getA={series} st={() => 'derived'} tip={(k) => `${monthLabel(plan.months[k])} runway: ${text(k)}`} minActs={2} />
    </Tile>
  );
}

const DEF_BY_ID = Object.fromEntries(METRICS.map((m) => [m.id, m])) as Record<string, MetricDef>;
/** Cash plan (dashed, from the workbook) against cash actual (solid, only months whose cash is calculated). Money in thousands of pesos. */
function CashChart({plan, nowKey, actuals}: {plan: PlanData; nowKey: string; actuals: Actuals}) {
  const n = plan.months.length;
  const tgt = plan.targets.cash ?? [];
  const act = plan.months.map((_, i) => cellOf(actuals, 'cash', i).value);
  const vals = [...tgt, ...act].filter((v): v is number => v !== null);
  if (n < 2 || vals.length === 0) return null;
  const W = 720, H = 240, L = 52, R = 14, T = 14, B = 30;
  const {lo, hi, ticks} = axisTicks(Math.min(...vals), Math.max(...vals));
  const step = ticks[1] - ticks[0];
  const x = (i: number) => L + (i * (W - L - R)) / (n - 1);
  const y = (v: number) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const path = (ids: number[], f: (i: number) => number | null) => ids.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)} ${y(f(i) as number).toFixed(1)}`).join(' ');
  const planIds = plan.months.map((_, i) => i).filter((i) => tgt[i] !== null && tgt[i] !== undefined);
  const actIds = plan.months.map((_, i) => i).filter((i) => act[i] !== null);
  const cur = currentIndex(plan.months, nowKey);
  const def = DEF_BY_ID.cash, last = Math.max(0, cur - 1);
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card p-4" data-testid="cash-chart">
      <h3 className="font-serif text-base leading-tight">Cash: target vs actual{actIds.length === 0 && <InfoTip text={PLAN_HELP.cashChart} label="About the cash chart" className="ml-1" />}</h3>
      <div className="mb-1.5 mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><svg aria-hidden viewBox="0 0 22 8" className="h-2 w-[22px]"><line x1="0" x2="22" y1="4" y2="4" stroke="var(--foreground)" strokeWidth="2.5" /></svg>Actual</span>
        <span className="inline-flex items-center gap-1.5"><svg aria-hidden viewBox="0 0 22 8" className="h-2 w-[22px]"><line x1="0" x2="22" y1="4" y2="4" stroke="var(--muted-foreground)" strokeWidth="2" strokeDasharray="5 4" /></svg>Target from workbook</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cash at month end, target against actual, by month" className="block h-auto w-full" fontSize="11" fill="var(--muted-foreground)">
        {ticks.map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--border)" /><text x={L - 6} y={y(v) + 4} textAnchor="end">{fmtAxisTick(v, step)}</text></g>)}
        {plan.months.map((mo, i) => <text key={mo} x={x(i)} y={H - 10} textAnchor="middle" fontSize={n > 12 ? 9.5 : 11} fontWeight={i === last ? 600 : 400} fill={i === last ? 'var(--foreground)' : undefined}>{axisLabel(mo, i)}</text>)}
        <rect x={x(last) - 9} y={T} width={18} height={H - T - B} fill="var(--accent)" />
        {planIds.length > 1 && <path d={path(planIds, (i) => tgt[i])} fill="none" stroke="var(--muted-foreground)" strokeWidth="2" strokeDasharray="6 5" />}
        {actIds.length > 1 && <path d={path(actIds, (i) => act[i])} fill="none" stroke="var(--foreground)" strokeWidth="2.5" strokeLinejoin="round" />}
        {actIds.map((i) => {
          const st = metricStatus({direction: def.direction, actual: act[i], partial: false, target: tgt[i] ?? null, phase: monthPhase(plan.months[i], nowKey), hasSource: true});
          const fill = st === 'ok' ? 'var(--status-good)' : st === 'bad' ? 'var(--status-crit)' : 'var(--muted-foreground)';
          return <circle key={i} cx={x(i)} cy={y(act[i] as number)} r="6" fill={fill} stroke="var(--card)" strokeWidth="2"><title>{`${monthLabel(plan.months[i])}: actual ${fmtPlan('php', act[i])} against target ${fmtPlan('php', tgt[i])}`}</title></circle>;
        })}
      </svg>
    </div>
  );
}

/** The plan's inventory purchases by month: the stock orders needed to hold the coverage target. Plan only, there is no actual for it. */
function StockChart({plan, nowKey}: {plan: PlanData; nowKey: string}) {
  const series = stockOrderSeries(plan);
  const vals = series.filter((v): v is number => v !== null);
  if (vals.length === 0) return null;
  const cov = plan.targets.coverage?.find((v) => v !== null) ?? null;
  const n = plan.months.length, lastClosed = Math.max(0, currentIndex(plan.months, nowKey) - 1);
  const W = 720, H = 220, L = 52, R = 10, T = 14, B = 30;
  const {hi: mx, ticks: yTicks} = axisTicks(0, Math.max(...vals, 1), 2), bw = (W - L - R) / n;
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card p-4" data-testid="stock-chart">
      <h3 className="mb-1.5 font-serif text-base leading-tight">Target stock orders<InfoTip text={PLAN_HELP.stockChart(cov)} label="About target stock orders" className="ml-1" /></h3>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Planned inventory purchases by month" className="block h-auto w-full" fontSize="11" fill="var(--muted-foreground)">
        {yTicks.map((v) => { const yy = T + (1 - v / mx) * (H - T - B); return <g key={v}><line x1={L} x2={W - R} y1={yy} y2={yy} stroke="var(--border)" /><text x={L - 6} y={yy + 4} textAnchor="end">{fmtAxisTick(v, yTicks[1] - yTicks[0])}</text></g>; })}
        {plan.months.map((mo, k) => {
          const v = series[k];
          const h = v === null || v === undefined ? 0 : (v / mx) * (H - T - B), bx = L + k * bw + 3;
          return (
            <g key={mo}>
              {v !== null && v !== undefined && <rect x={bx} y={H - B - h} width={bw - 6} height={Math.max(h, 0)} rx="2" fill={k === lastClosed ? 'var(--primary)' : 'var(--muted-foreground)'} opacity={k === lastClosed ? 1 : 0.55}><title>{`${monthLabel(mo)}: ${fmtPlan('php', v)} planned`}</title></rect>}
              <text x={bx + (bw - 6) / 2} y={H - 10} textAnchor="middle" fontSize={n > 12 ? 9.5 : 11}>{axisLabel(mo, k)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Grid({plan, nowKey, actuals, edit, reveal, onWhy, inputsOpen, setInputsOpen}: {plan: PlanData; nowKey: string; actuals: Actuals; edit: Edit; reveal: {month: string; n: number} | null; onWhy: (id: string, i: number) => void; inputsOpen: boolean; setInputsOpen: (open: boolean) => void}) {
  const total = plan.months.length;
  const cur = currentIndex(plan.months, nowKey);
  const [start, setStart] = useState(() => windowStart(total, WINDOW, cur));
  const [touchX, setTouchX] = useState<number | null>(null);
  // "Fill in now" / "Monthly close": bring that month into the 3-month phone window.
  useEffect(() => {
    if (!reveal) return;
    const i = plan.months.indexOf(reveal.month);
    if (i >= 0) setStart((s) => (i >= s && i < s + WINDOW ? s : windowStart(total, WINDOW, i)));
  }, [reveal, plan.months, total]);
  const inWindow = (i: number) => i >= start && i < start + WINDOW;
  const col = (i: number) => (inWindow(i) ? '' : 'max-md:hidden');
  const last = Math.min(start + WINDOW, total) - 1;
  const swipe = (x: number) => {
    if (touchX === null || Math.abs(x - touchX) < 40) return;
    setStart((s) => stepWindow(s, x < touchX ? 1 : -1, total, WINDOW));
  };
  const closed = plan.months.filter((m) => edit.closes[m]);
  return (
    <div>
      {closed.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground" data-testid="lock-note">
          <span className="inline-flex items-center gap-1.5"><Lock className="size-3.5" aria-hidden />{closed.map(shortMonth).join(', ')} closed and locked.</span>
          {edit.canEdit && <button type="button" onClick={() => edit.askUnlock(closed[closed.length - 1])} className="min-h-8 rounded-full border border-border bg-card px-3 text-[13px] font-medium transition-colors hover:border-primary max-md:min-h-11 max-md:px-4">Unlock to edit</button>}
        </div>
      )}
      <div className="sticky top-14 z-30 flex items-center justify-between gap-2 border-b border-border bg-card py-2 md:hidden">
        <button type="button" aria-label="Earlier months" disabled={start === 0} onClick={() => setStart((s) => stepWindow(s, -1, total, WINDOW))}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-border bg-background transition-transform active:scale-[0.97] disabled:opacity-35"><ChevronLeft className="size-4" /></button>
        <div className="text-center leading-tight"><div className="text-[15px] font-semibold tabular-nums">{monthLabel(plan.months[start])} to {monthLabel(plan.months[last])}</div><div className="text-xs text-muted-foreground">Swipe the table or tap the arrows</div></div>
        <button type="button" aria-label="Later months" disabled={start + WINDOW >= total} onClick={() => setStart((s) => stepWindow(s, 1, total, WINDOW))}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-border bg-background transition-transform active:scale-[0.97] disabled:opacity-35"><ChevronRight className="size-4" /></button>
      </div>
      <div className="relative max-h-[620px] overflow-auto max-md:max-h-none max-md:overflow-visible" onTouchStart={(e) => setTouchX(e.touches[0].clientX)} onTouchEnd={(e) => { swipe(e.changedTouches[0].clientX); setTouchX(null); }}>
        <table className="w-full border-separate border-spacing-0 text-[12.5px] tabular-nums md:w-max md:min-w-full" data-testid="plan-grid">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 min-w-[108px] border-b border-r-2 border-border bg-card px-2 py-2 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground max-md:top-[117px] md:min-w-[150px]">{SHEET_ROWS[0].label}</th>
              {plan.months.map((mo, i) => {
                const phase = monthPhase(mo, nowKey);
                return (
                  <th key={mo} className={cn('sticky top-0 z-20 border-b border-r border-border bg-card min-w-[76px] max-md:min-w-[80px] px-2 py-1.5 text-center text-[10.5px] uppercase leading-tight text-muted-foreground max-md:top-[117px]', phase === 'future' ? 'font-normal' : 'font-medium', col(i))}>
                    {monthLabel(mo)}{edit.closes[mo] && <Lock aria-label="Closed" className="ml-1 inline size-3 align-[-1px] text-muted-foreground" />}
                    {phase !== 'past' && <span className="block text-[10.5px] font-normal">{phase === 'current' ? 'MTD' : 'Target'}</span>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            <CloseRow plan={plan} col={col} edit={edit} actuals={actuals} />
            <SheetRows plan={plan} nowKey={nowKey} actuals={actuals} edit={edit} col={col} win={{start, toFirst: () => setStart(0)}} onWhy={onWhy} inputsOpen={inputsOpen} setInputsOpen={setInputsOpen} />
          </tbody>
        </table>
      </div>
    </div>
  );
}

const HEAD_BTN = 'inline-flex min-h-9 items-center justify-center rounded-full border border-border bg-card px-3.5 text-[13px] font-medium transition-[border-color,transform] duration-200 hover:border-primary active:scale-[0.97] motion-reduce:transition-none max-sm:min-h-11';
const dateFmt = new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric', timeZone: 'Asia/Manila'});
/** What blocks closing a month, or null: it must have ended, every earlier month must be closed (oldest first), and all three GMV channels must be complete. */
const earlierOf = (edit: Edit, months: readonly string[], mo: string) => earlierUnclosed(mo, months, edit.closes, edit.today);
const blockerOf = (edit: Edit, actuals: Actuals, mo: string, i: number, months: readonly string[]) => closeBlocker({month: mo, today: edit.today, tag: monthTag(mo), earlier: ((e) => (e ? monthTag(e) : null))(earlierOf(edit, months, mo)), gmv: {gmv_events: cellOf(actuals, 'gmv_events', i), gmv_website: cellOf(actuals, 'gmv_website', i), gmv_marketplace: cellOf(actuals, 'gmv_marketplace', i)}});

/** Per month: Close month (only after the month has ended, with all three GMV channels complete and every typed line filled; what blocks it stays visible under the button), or the lock with who closed it and Unlock. */
function CloseRow({plan, col, edit, actuals}: {plan: PlanData; col: (i: number) => string; edit: Edit; actuals: Actuals}) {
  return (
    <>
      <tr><td className={GROUP_ROW}>Close</td><td colSpan={plan.months.length} className="border-b border-border bg-muted" /></tr>
      <tr data-testid="close-row">
        <th scope="row" className={cn(LABEL_CELL, 'text-[12.5px] font-normal')}>Close month<InfoTip text={PLAN_HELP.closeMonth(REQUIRED_COUNT)} label="About closing a month" className="ml-0.5" /></th>
        {plan.months.map((mo, i) => <CloseCell key={mo} month={mo} filled={filledCount(edit.lines, i)} complete={monthComplete(edit.lines, i)} blocker={blockerOf(edit, actuals, mo, i, plan.months)} short={earlierOf(edit, plan.months, mo) && monthEnded(mo, edit.today) ? `Close ${monthTag(earlierOf(edit, plan.months, mo) as string)} first.` : undefined} className={cn('border-b border-r border-border px-2 py-1 text-center align-top', col(i))} edit={edit} />)}
      </tr>
    </>
  );
}

function CloseCell({month, filled, complete, blocker, short, className, edit}: {month: string; filled: number; complete: boolean; blocker: string | null; short?: string; className: string; edit: Edit}) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const closed = edit.closes[month];
  const ended = monthEnded(month, edit.today);
  if (closed) {
    return (
      <td className={className}>
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" title={`Closed by ${closed.by}`}><Lock className="size-3" aria-hidden />Closed {dateFmt.format(new Date(closed.at))}</span>
        {edit.canEdit && <button type="button" onClick={() => edit.askUnlock(month)} aria-label={`Unlock ${monthLabel(month)}`} className="mt-0.5 block w-full text-center text-[11px] text-primary underline underline-offset-2 max-md:min-h-9">Unlock</button>}
      </td>
    );
  }
  if (!ended || !edit.canEdit) return <td className={className}><span className="text-[11px] text-muted-foreground">{ended ? `${filled} of ${REQUIRED_COUNT}` : ''}</span></td>;
  return (
    <td className={className}>
      <button type="button" data-close-month={month} disabled={!complete || !!blocker || pending} aria-label={`Close month ${monthLabel(month)}`} title={blocker ?? (complete ? 'Lock this month' : `${filled} of ${REQUIRED_COUNT} lines entered`)}
        onClick={() => start(async () => { setErr(null); setErr(await edit.close(month)); })}
        className="min-h-7 rounded-full border border-border bg-card px-3 text-xs font-medium transition-[border-color,transform] duration-200 enabled:hover:border-primary enabled:active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none max-md:min-h-11 max-md:px-4">Close</button>
      {!complete && <span className="mt-0.5 block w-0 min-w-full text-[10.5px] text-[var(--bhr-warn)]">{filled} of {REQUIRED_COUNT}</span>}
      {blocker && <span data-testid="close-blocker" className="mx-auto mt-0.5 block w-0 min-w-full whitespace-normal text-[10.5px] leading-tight text-[var(--bhr-warn)]" title={blocker}>{short ?? blocker}</span>}
      {err && <span role="alert" className="mx-auto block w-0 min-w-full whitespace-normal text-[10.5px] leading-tight text-[var(--status-crit)]">{err}</span>}
    </td>
  );
}

export function HealthReportView({plan, nowKey, gmv = EMPTY_ACTUALS, lines: savedLines = EMPTY_LINES, canEdit = false, linesNotice = null, closes = EMPTY_CLOSES, today = '', versions = []}: {versions?: PlanVersionInfo[]; plan: PlanData; nowKey: string; gmv?: Actuals; lines?: LineSeries; canEdit?: boolean; linesNotice?: string | null; closes?: Record<string, ClosedMonth>; today?: string}) {
  const [gmvOpen, setGmvOpen] = useState(false);
  const [reveal, setReveal] = useState<{month: string; n: number} | null>(null);
  const [lines, setLines] = useState<LineSeries>(savedLines);
  useEffect(() => { setLines(savedLines); }, [savedLines]);
  // The INPUTS — DRIVERS block (rows 5 to 46) starts collapsed; Fill in and Enter open it when the next line to type lives there.
  const [inputsOpen, setInputsOpen] = useState(false);
  const router = useRouter();
  const [unlocking, setUnlocking] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [unlockErr, setUnlockErr] = useState<string | null>(null);
  const [unlockPending, startUnlock] = useTransition();
  // Typed lines and the margins computed from them: recalculated here the moment a save succeeds, so the grid never waits on a refresh.
  // The itemised rows are typed; their totals (overhead row 39, COGS row 55, content and other) are their sums, never typed (withTotals).
  const summed = useMemo(() => withTotals(lines), [lines]);
  const actuals = useMemo<Actuals>(() => {
    const typed: Actuals = {};
    for (const id of [...LINES.map((l) => l.id), ...MEASURE_LINES.map((l) => l.id), 'overhead', 'cogs', 'content_other']) typed[id] = plan.months.map((_, i): ActualCell => { const v = summed[id]?.[i] ?? null; return v === null ? GAP : {value: v, state: 'ok'}; });
    const live = applySnapshots(gmv, plan.months, closes); // a closed month's GMV is its snapshot, never live
    return {...live, ...typed, ...derivedActuals(plan, live, summed)}; // margins, cash, coverage, customers and CAC are derived, never typed
  }, [gmv, summed, plan, closes]);
  const queue = useMemo(() => closeQueue(plan.months, closes, today), [plan.months, closes, today]);
  const waiting = closeWaiting(plan.months, closes, today); // the oldest unclosed month: the header Close button starts here
  const fill = queue.find((m) => REQUIRED_COUNT - filledCount(lines, plan.months.indexOf(m)) > 0) ?? null; // the oldest one that still has lines to type: Fill in starts here
  const [ring, setRing] = useState<{month: string; metric: string} | null>(null);
  const clearRing = useCallback(() => setRing(null), []);
  // Fill in / Enter: bring the month into the phone window, put the ring and the tag on the cell, scroll it into view and focus it (Enter focuses at once, Fill in after the scroll).
  const goCell = useCallback((month: string, metric: string, smooth: boolean) => {
    setReveal((r) => ({month, n: (r?.n ?? 0) + 1}));
    if (blockOf(rowOfLine(metric) ?? 999) === 'inputs') setInputsOpen(true);
    setRing({month, metric});
    const go = (tries: number) => requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`#all-months [data-month="${month}"][data-line="${metric}"]`); // an input, or the button of a consolidated line
      if (el && el.offsetParent !== null) {
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (smooth) { el.scrollIntoView({behavior: reduce ? 'auto' : 'smooth', block: 'center', inline: 'center'}); setTimeout(() => el.focus({preventScroll: true}), reduce ? 0 : 350); } else el.focus();
      } else if (tries > 0) go(tries - 1);
      else document.getElementById('all-months')?.scrollIntoView({behavior: 'smooth', block: 'start'});
    });
    go(6);
  }, []);
  const edit = useMemo<Edit>(() => canEdit ? {
    canEdit: true, lines: summed, closes, today, ring, clearRing,
    next: (month, metric, treatFilled) => {
      const nx = nextEmptyLine(lines, plan.months.indexOf(month), metric, treatFilled ? metric : undefined);
      if (!nx) return false;
      goCell(month, nx, false);
      return true;
    },
    close: async (month) => { const r = await closeMonthAction({month}); if (!r.ok) router.refresh(); return r.ok ? null : r.error; },
    askUnlock: (month) => { setUnlocking(month); setReason(''); setUnlockErr(null); },
    save: async (month, metric, pesos, expected) => {
      const r = await savePlanLineAction({month, metric, amountPhp: pesos, expected});
      if (!r.ok) { router.refresh(); return r.error; }
      const i = plan.months.indexOf(month);
      setLines((prev) => ({...prev, [metric]: (prev[metric] ?? plan.months.map(() => null)).map((v, k) => (k === i ? pesos : v))}));
      return null;
    },
  } : {...NO_EDIT, lines: summed, closes, today}, [canEdit, lines, summed, closes, today, ring, clearRing, goCell, plan.months, router]);
  const fillIn = (month: string) => goCell(month, nextEmptyLine(lines, plan.months.indexOf(month)) ?? REQUIRED_LINE_ORDER[0], true);
  const unlock = () => {
    if (!unlocking) return;
    startUnlock(async () => {
      const r = await unlockMonthAction({month: unlocking, reason});
      if (!r.ok) { setUnlockErr(r.error); router.refresh(); return; }
      setUnlocking(null);
    });
  };
  const [drill, setDrill] = useState<{id: string; i: number} | null>(null);
  const onWhy = (id: string, i: number) => { setDrill({id, i}); requestAnimationFrame(() => document.querySelector('[data-testid="drilldown"]')?.scrollIntoView({behavior: 'smooth', block: 'nearest'})); };
  const keys = METRICS.filter((m) => m.key);
  const wi = waiting ? plan.months.indexOf(waiting) : -1;
  const closeBtn = closeAction({waiting, tag: waiting ? monthTag(waiting) : '', blocker: waiting ? blockerOf(edit, actuals, waiting, wi, plan.months) : null, filled: wi >= 0 ? filledCount(lines, wi) : 0, required: REQUIRED_COUNT});
  const cur = versions.find((v) => v.id === plan.versionId) ?? versions[0];
  const versionTip = cur ? `Every target on this page comes from this version. ${cur.reason ?? 'Initial target'} (${cur.by ?? 'seed'}). All targets are calculated from the plan, so they are not editable here.` : 'Every target on this page comes from this version. All targets are calculated from the plan, so they are not editable here.';
  // Header close button: bring that month into view, then focus its Close button in the grid's Close row (a blocked one stays put and explains itself in its tooltip).
  const goClose = (month: string | null = waiting) => {
    if (!month) return;
    setReveal((r) => ({month, n: (r?.n ?? 0) + 1}));
    const go = (tries: number) => requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`#all-months [data-testid="close-row"] button[data-close-month="${month}"]`) ?? document.querySelector<HTMLElement>('#all-months [data-testid="close-row"]');
      if (el && el.offsetParent !== null) { el.scrollIntoView({behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center', inline: 'center'}); if (el.tagName === 'BUTTON') (el as HTMLButtonElement).focus({preventScroll: true}); }
      else if (tries > 0) go(tries - 1);
    });
    go(6);
  };
  return (
    <div className="w-full max-w-none px-4 py-4 md:px-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h1 className="font-serif text-[clamp(22px,3vw,28px)] font-normal leading-tight tracking-tight">Business Health Report</h1>
          <InfoTip text={PLAN_HELP.sources} label="Where do these numbers come from?" className="-ml-2" />
          <span className="inline-flex items-center rounded-full bg-muted py-0.5 pl-2.5 pr-1 text-xs font-medium text-muted-foreground" data-testid="target-version">Target {plan.label}<InfoTip text={versionTip} label="About the target version" className="size-6 max-md:size-8" /></span>
          {!canEdit && !linesNotice && <span data-testid="read-only" className="inline-flex items-center text-muted-foreground"><Lock className="size-3.5" aria-hidden /><InfoTip text={PLAN_HELP.readOnly} label="View only" /></span>}
        </div>
        {canEdit && closeBtn && (
          <span className="flex items-center gap-1">
            <button type="button" data-testid="header-close" aria-disabled={closeBtn.blocked || undefined} data-blocked={closeBtn.blocked || undefined} onClick={() => goClose()}
              className={cn(HEAD_BTN, !closeBtn.blocked && 'border-primary bg-primary text-primary-foreground hover:border-primary', closeBtn.blocked && 'text-muted-foreground')}>{closeBtn.label}</button>
            {closeBtn.reason && <InfoTip text={closeBtn.reason} label={`Why ${closeBtn.label} is not ready`} />}
          </span>
        )}
      </div>
      {linesNotice && <p role="status" className="mb-3 rounded-lg bg-[var(--amber-bg)] px-3.5 py-2 text-[13px] text-[var(--bhr-warn)]">{linesNotice}</p>}
      {plan.notice && <p role="status" className="mb-3 rounded-lg bg-[var(--amber-bg)] px-3.5 py-2 text-[13px] text-[var(--bhr-warn)]">{plan.notice}</p>}

      {waiting && (() => {
        const fi = fill ? plan.months.indexOf(fill) : -1;
        const nxId = fi >= 0 ? nextEmptyLine(lines, fi) : null;
        const nx = nxId ? GRID_LINE_LABEL[nxId] : null;
        const leftOf = (m: string) => REQUIRED_COUNT - filledCount(lines, plan.months.indexOf(m));
        const ready = queue.filter((m) => leftOf(m) === 0), needy = queue.filter((m) => leftOf(m) > 0);
        const headline = [ready.length ? `${ready.length} month${ready.length === 1 ? '' : 's'} ready to close` : '', needy.length === 1 ? `${monthLabel(needy[0])} needs ${leftOf(needy[0])} line${leftOf(needy[0]) === 1 ? '' : 's'}` : needy.length ? `${needy.length} months need data` : ''].filter(Boolean).join(' · ');
        const since = daysSinceMonthEnd(fill ?? waiting, today);
        return (
          <div role="status" data-testid="close-waiting" className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg bg-[var(--amber-bg)] px-3.5 py-2.5 text-sm text-[var(--bhr-warn)]">
            <div>
              <b data-testid="close-headline">{headline}</b>{' '}
              <ul className="my-1 flex flex-wrap items-center gap-x-4 gap-y-1 tabular-nums" data-testid="close-queue">
                {queue.map((m) => { const left = leftOf(m); return <li key={m} data-testid="close-queue-item" data-month={m} data-ready={left === 0 || undefined}>{left === 0 ? (canEdit ? <button type="button" onClick={() => goClose(m)} className="rounded-full border border-current px-2.5 py-0.5 text-[12.5px] font-medium max-sm:min-h-11">{monthLabel(m)} ready to close</button> : `${monthLabel(m)} ready to close`) : `${monthLabel(m)} · ${left} line${left === 1 ? '' : 's'} left`}</li>; })}
              </ul>
              <span className="tabular-nums" data-testid="close-next">{nx ? <>Next: <b>{nx}</b> for {monthLabel(fill as string)} · {monthLabel(fill as string)} ended {since} day{since === 1 ? '' : 's'} ago</> : `All ${REQUIRED_COUNT} lines entered. Close ${monthLabel(waiting)} in the grid · ${monthLabel(waiting)} ended ${since} day${since === 1 ? '' : 's'} ago`}</span>
              {!canEdit && <> <span data-testid="close-waiting-who">{closeWaitingWho(monthLabel(fill ?? waiting))}</span></>}
            </div>
            {canEdit && nx && fill && <button type="button" onClick={() => fillIn(fill)} data-testid="fill-in" className="rounded-full bg-primary px-3.5 py-1.5 text-[13px] font-semibold text-primary-foreground transition-transform active:scale-[0.97] max-sm:min-h-11 max-sm:w-full">Fill in {nx} for {shortMonth(fill)}</button>}
          </div>
        );
      })()}
      <div className={CARDS} data-testid="key-cards">
        {[keys.find((m) => m.id === 'gmv_total'), keys.find((m) => m.id === 'cash')].map((m) => m && <KeyCard key={m.id} m={m} plan={plan} nowKey={nowKey} actuals={actuals} onWhy={onWhy} foot={m.id === 'gmv_total' ? <button type="button" aria-expanded={gmvOpen} aria-controls="gmv-details" onClick={() => setGmvOpen((v) => !v)} data-testid="gmv-toggle" className="-mb-1 mt-0.5 inline-flex min-h-8 items-center gap-1 self-start rounded text-xs font-medium text-muted-foreground transition-colors hover:text-primary focus-visible:text-primary focus-visible:outline-2 focus-visible:outline-primary max-md:min-h-11">{gmvOpen ? 'Hide channels' : 'Show channels'}<ChevronDown className={cn('size-3.5 transition-transform motion-reduce:transition-none', gmvOpen && 'rotate-180')} aria-hidden /></button> : undefined} tip={m.id === 'cash' ? ((lines.opening_cash?.[0] ?? null) === null ? PLAN_HELP.cashNoOpening : PLAN_HELP.cashCheckBank) : undefined} />)}
        <RunwayCard plan={plan} nowKey={nowKey} actuals={actuals} opening={lines.opening_cash?.[0] ?? null} />
      </div>
      {gmvOpen && (
        <div id="gmv-details" className={cn(CARDS, 'mt-2.5')} data-testid="gmv-cards">
          {keys.filter((m) => ['gmv_events', 'gmv_website', 'gmv_marketplace'].includes(m.id)).map((m) => <KeyCard key={m.id} m={m} plan={plan} nowKey={nowKey} actuals={actuals} onWhy={onWhy} />)}
        </div>
      )}
      {drill && <Drilldown id={drill.id} i={drill.i} plan={plan} actuals={actuals} onClose={() => setDrill(null)} />}

      <section className="mt-6">
        {(
          <div id="all-months" className="">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-3.5">
              <CashChart plan={plan} nowKey={nowKey} actuals={actuals} />
              <StockChart plan={plan} nowKey={nowKey} />
            </div>
            <div className="mt-3.5 rounded-lg border border-border bg-card p-4 max-md:px-0">
              <div className="mb-2 flex items-center justify-between gap-2 max-md:px-3">
                <h3 className="font-serif text-base leading-tight">All months<InfoTip text={PLAN_HELP.grid(REQUIRED_COUNT)} label="How to fill the grid" className="ml-1" /><InfoTip text={PLAN_HELP.sheet} label="How the Business Plan rows are judged" className="ml-0.5" /></h3>
              </div>
              {unlocking && (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2" data-testid="unlock-panel">
                  <label className="text-[13px] font-medium" htmlFor="unlock-reason">Unlock</label>
                  <select aria-label="Month to unlock" value={unlocking} onChange={(e) => { setUnlocking(e.target.value); setUnlockErr(null); }} className="rounded-md border border-border bg-background px-2 py-1.5 text-base md:text-sm">
                    {plan.months.filter((m) => closes[m]).map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
                  </select>
                  <input id="unlock-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why change a closed month? (required)" maxLength={500}
                    className="min-w-[220px] flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-base md:text-sm" />
                  <button type="button" onClick={unlock} disabled={!reason.trim() || unlockPending} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">Unlock</button>
                  <button type="button" onClick={() => setUnlocking(null)} className="rounded-md border border-border px-3 py-1.5 text-sm">Cancel</button>
                  {unlockErr && <p role="alert" className="w-full text-xs text-[var(--status-crit)]">{unlockErr}</p>}
                  <p className="w-full text-xs text-muted-foreground">Every change to a closed month is logged with your reason. The month needs Close month again afterwards, which takes a new GMV snapshot.</p>
                </div>
              )}

              <Grid plan={plan} nowKey={nowKey} actuals={actuals} edit={edit} reveal={reveal} onWhy={onWhy} inputsOpen={inputsOpen} setInputsOpen={setInputsOpen} />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
