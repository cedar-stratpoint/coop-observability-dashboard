'use client';

import {Fragment, useEffect, useMemo, useState, useTransition} from 'react';
import {ChevronDown} from 'lucide-react';
import {cn} from '@/lib/utils';
import {HelpTip as InfoTip} from './help-tip';
import {PLAN_HELP} from '@/src/plan-help';
import {
  GAP, GRID_LINE_LABEL, LINES, MEASURE_LINES, REQUIRED_LINE_ORDER, lineInputText, lineUnitWords, monthPhase, parseLineInput,
  type ActualCell, type ClosedMonth, type LineSeries, type PlanData, type Status,
} from '@/src/plan-compute';
import {SHEET_ROWS, actualKind, blockOf, fmtCell, isSingle, judgedAs, sheetActuals, sheetCtx, sheetStatus, shownRows, targetId, TYPED_ROW, type SheetRow} from '@/src/plan-sheet';

// BHR-06: the All months grid IS the Business Plan sheet. Rows 5 to 125 down in sheet order with the sheet's labels, months across. Every target cell is
// the workbook value. Under each row that can have an actual sits an "actual" line: an entry cell for a typed row (one per itemised sheet row), the value
// computed by the sheet's formula for a formula row (totals such as row 39 are the sum of their rows, never typed). Colour per the row's rule, on the
// actual line only (src/plan-sheet.ts). Rows with no actual show the target line only.

const MONTH_FMT = new Intl.DateTimeFormat('en-US', {month: 'short', year: '2-digit', timeZone: 'UTC'});
export const monthLabel = (m: string) => {
  const [s, y] = MONTH_FMT.format(new Date(`${m}T00:00:00Z`)).split(' ');
  return `${s}'${y}`;
};
export const STATUS_TEXT: Record<Status, string> = {ok: 'Met', bad: 'Missed', waiting: 'Waiting', live: 'Month to date', future: 'Upcoming', nosource: 'No source yet', partial: 'Partial', info: 'Typed', derived: 'Info only', modelled: 'Modelled'};
export type Actuals = Record<string, ActualCell[]>;

/** Editing: who may type, the last saved values (pesos), and how to save one cell. Read-only users get `canEdit: false` and never see an input. */
export interface Edit {
  canEdit: boolean; lines: LineSeries; closes: Record<string, ClosedMonth>; today: string;
  save: (month: string, metric: string, pesos: number | null, expected: number | null) => Promise<string | null>;
  close: (month: string) => Promise<string | null>;
  askUnlock: (month: string) => void;
  /** The oldest unclosed month that still has empty required lines: those cells are outlined amber. */
  fill: string | null;
  /** The cell carrying the accent ring and the 'Type ...' tag (set by Fill in and by Enter, cleared on blur). */
  ring: {month: string; metric: string} | null;
  clearRing: () => void;
  /** Jump to the next empty required line of `month` after `metric` (the one being saved counts as filled). False when none is left. */
  next: (month: string, metric: string, treatFilled: boolean) => boolean;
}

export const cellOf = (actuals: Actuals, id: string, i: number): ActualCell => actuals[id]?.[i] ?? GAP;
export const cellActual = (s: Status) => (s === 'ok' ? 'bg-[var(--status-good)]/15 text-[var(--status-good)]' : s === 'bad' ? 'bg-[var(--status-crit)]/15 text-[var(--status-crit)]' : 'text-muted-foreground');
export const GROUP_ROW = 'sticky left-0 z-10 whitespace-normal border-b border-border bg-muted px-2 py-[5px] text-left text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground';
export const LABEL_CELL = 'sticky left-0 z-10 max-w-[108px] whitespace-normal border-b border-r-2 border-border bg-card px-2 py-[5px] text-left leading-snug md:min-w-[150px] md:max-w-none md:whitespace-nowrap';
export const SUB_CELL = 'sticky left-0 z-10 border-b border-r-2 border-border bg-card py-[5px] pl-5 pr-2 text-left text-[11px] font-medium text-muted-foreground max-md:pl-3.5';
const SHEET_LABEL = 'sticky left-0 z-10 max-w-[108px] whitespace-normal border-b border-r-2 border-border bg-card px-2 py-[5px] text-left text-[12.5px] leading-snug md:min-w-[260px] md:max-w-[340px]';
const CLICKABLE = new Set(['gmv_total', 'gmv_events', 'gmv_website', 'gmv_marketplace', 'cash']);
const LINE_LABEL: Record<string, string> = Object.fromEntries([...LINES, ...MEASURE_LINES].map((l) => [l.id, l.label]));
const REQUIRED = new Set(REQUIRED_LINE_ORDER);
/**
 * Sheet labels as the sheet has them; leading spaces mark a sub-row, shown indented. On a phone a long label is clamped to two lines (the text in the
 * DOM, so its accessible name, stays the full sheet label; the title shows it on hover).
 */
const CLAMP = 'max-md:line-clamp-2';
const sheetLabel = (r: SheetRow) => <span className={cn('block [overflow-wrap:anywhere]', CLAMP, r.label.startsWith(' ') && 'pl-3')}>{r.label.trim()}</span>;

/**
 * One entry cell (money in thousands of pesos like the sheet; ROAS as a multiple). Saves when you leave the cell or press Enter. Empty = missing, 0 = a real 0.
 * On a rejected save (not numeric, negative cost, someone else saved first, closed month) the cell goes back to the saved value and says why.
 */
function LineCell({month, metric, saved, edit}: {month: string; metric: string; saved: number | null; edit: Edit}) {
  const show = saved === null ? '' : lineInputText(metric, saved);
  const [text, setText] = useState(show);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => { setText(show); }, [show]);
  const isTgt = edit.ring?.month === month && edit.ring.metric === metric;
  const commit = () => {
    if (text.trim() === show) { setText(show); return; }
    const p = parseLineInput(metric, text);
    if (!p.ok) { setErr('Enter a number.'); setText(show); return; }
    setErr(null);
    start(async () => {
      const e = await edit.save(month, metric, p.value, saved);
      if (e) { setErr(e); setText(show); }
    });
  };
  const label = `${LINE_LABEL[metric] ?? metric}, ${monthLabel(month)}, ${lineUnitWords(metric)}`;
  return (
    <>
      <input inputMode="decimal" value={text} aria-label={label} aria-invalid={err ? true : undefined} disabled={pending} data-line={metric} data-month={month}
        onChange={(e) => setText(e.target.value)} onFocus={(e) => e.currentTarget.select()} onBlur={() => { if (isTgt) edit.clearRing(); commit(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const el = e.target as HTMLInputElement;
            if (REQUIRED.has(metric)) { e.preventDefault(); const filled = text.trim() !== ''; el.blur(); if (edit.next(month, metric, filled)) return; }
            const all = Array.from(document.querySelectorAll<HTMLInputElement>(`input[data-month="${month}"]`));
            const next = all[all.indexOf(el) + 1];
            el.blur(); next?.focus();
          }
          if (e.key === 'Escape') { setText(show); setErr(null); }
        }}
        className={cn('block h-11 w-[72px] rounded-none border-0 bg-transparent px-2 text-right text-base font-semibold tabular-nums transition-colors hover:bg-accent focus-visible:bg-card focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary md:h-[30px] md:text-[12.5px]', pending && 'opacity-60', err && 'outline outline-2 -outline-offset-2 outline-[var(--status-crit)]')} />
      {err && <span role="alert" className="mt-0.5 block max-w-[170px] whitespace-normal text-right text-[10.5px] leading-tight text-[var(--status-crit)]">{err}</span>}
    </>
  );
}

/** One typed cell on an actual line: an input for an editor (past and current months, not closed), the saved number for everyone else. Coloured like any actual. */
function TypedCell({metric, mo, i, plan, nowKey, edit, status, col}: {metric: string; mo: string; i: number; plan: PlanData; nowKey: string; edit: Edit; status: Status; col: string}) {
  const phase = monthPhase(mo, nowKey);
  const saved = edit.lines[metric]?.[i] ?? null;
  const closed = !!edit.closes[mo];
  const editable = edit.canEdit && phase !== 'future' && !closed;
  const tgt = editable && edit.ring?.month === mo && edit.ring.metric === metric;
  const required = REQUIRED.has(metric);
  const need = saved === null && edit.fill === mo && required && !closed;
  const shade = closed ? 'bg-muted' : saved === null && phase === 'past' && required ? 'bg-[var(--amber-bg)]' : cellActual(status);
  return (
    <td data-status={status} data-typed={metric} className={cn('relative border-b border-r border-border p-0 text-right font-semibold', shade, need && !tgt && 'bhr-need', tgt && 'bhr-tgt', col)}
      data-tip={tgt ? `Type ${GRID_LINE_LABEL[metric] ?? LINE_LABEL[metric] ?? metric} for ${monthLabel(mo)}` : undefined} title={closed ? 'Closed month, locked' : undefined}>
      {editable ? <LineCell month={mo} metric={metric} saved={saved} edit={edit} />
        : phase === 'future' ? null
        : saved === null ? <span className="sr-only">waiting</span> : <span className="block px-2 py-[5px] max-md:py-3">{lineInputText(metric, saved)}</span>}
    </td>
  );
}

/** The INPUTS — DRIVERS block's toggle, rows 6 to 46 behind it. */
const INPUTS_COUNT = SHEET_ROWS.filter((r) => blockOf(r.row) === 'inputs' && r.row > 5 && r.kind !== 'header').length;

export function SheetRows({plan, nowKey, actuals, edit, col, onWhy, inputsOpen, setInputsOpen}: {plan: PlanData; nowKey: string; actuals: Actuals; edit: Edit; col: (i: number) => string; onWhy: (id: string, i: number) => void; inputsOpen: boolean; setInputsOpen: (open: boolean) => void}) {
  const sheet = useMemo(() => sheetActuals(plan, actuals, edit.lines), [plan, actuals, edit.lines]);
  const n = plan.months.length;
  const ActualLabel = ({label = 'actual'}: {label?: string}) => <th scope="row" className={cn(SUB_CELL, 'uppercase')}>{label}</th>;
  return (
    <>
      {shownRows(inputsOpen).map((r) => {
        const key = `sheet-${r.row}`;
        if (r.kind === 'section') {
          if (r.row === 5) return (
            <tr key={key} data-sheet-row={r.row}>
              <td className={cn(GROUP_ROW, 'p-0 md:max-w-[340px]')}>
                <button type="button" aria-expanded={inputsOpen} data-testid="inputs-toggle" onClick={() => setInputsOpen(!inputsOpen)}
                  className="flex min-h-8 w-full items-center gap-1.5 px-2 py-[5px] text-left uppercase tracking-[0.07em] transition-[color,transform] duration-150 ease-out hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary active:scale-[0.99] motion-reduce:transition-none max-md:min-h-11">
                  <ChevronDown className={cn('size-3.5 shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none', !inputsOpen && '-rotate-90')} aria-hidden />
                  <span className="[overflow-wrap:anywhere]">{r.label}</span>
                  <span className="ml-auto whitespace-nowrap pl-2 text-[10.5px] font-normal normal-case tracking-normal max-md:sr-only">{inputsOpen ? 'Hide' : `Show ${INPUTS_COUNT} rows`}</span>
                </button>
              </td>
              <td colSpan={n} className="border-b border-border bg-muted" />
            </tr>
          );
          const band = cn('border-b border-border', r.sub ? 'bg-muted/50' : 'bg-muted');
          return (
            <tr key={key} data-sheet-row={r.row}>
              <td title={r.label} className={cn(GROUP_ROW, 'md:max-w-[340px]', r.sub && 'bg-muted/50 normal-case tracking-normal text-foreground/80')}><span className={cn('block [overflow-wrap:anywhere]', CLAMP)}>{r.label}</span></td>
              {/* Rows 47 and 80 repeat the month headings across, as the sheet does. */}
              {r.months ? plan.months.map((mo, i) => <td key={mo} className={cn(band, 'border-r px-2 py-[5px] text-right text-[11px] font-medium tracking-[0.07em] text-muted-foreground', col(i))}>{monthLabel(mo)}</td>) : <td colSpan={n} className={band} />}
            </tr>
          );
        }
        if (r.kind === 'spacer') return <tr key={key} data-sheet-row={r.row} aria-hidden><td className="sticky left-0 h-2 border-b border-border bg-card" /><td colSpan={n} className="h-2 border-b border-border" /></tr>;
        if (r.kind === 'label') return <tr key={key} data-sheet-row={r.row}><th scope="row" title={r.label.trim()} className={cn(SHEET_LABEL, 'font-medium text-muted-foreground')}>{sheetLabel(r)}</th><td colSpan={n} className="border-b border-border" /></tr>;
        const id = targetId(r), kind = actualKind(r.row), typed = TYPED_ROW[r.row];
        const greyed = r.kind === 'static';
        const statusAt = (i: number) => sheetStatus({row: r, actual: sheet[r.row]?.[i] ?? GAP, target: plan.targets[id]?.[i] ?? null, phase: monthPhase(plan.months[i], nowKey), ctx: sheetCtx(r, plan, actuals, i)});
        const targetLine = isSingle(r) ? (
          <tr data-sheet-row={r.row} data-line-kind="target" data-greyed={greyed || undefined} className={cn(greyed && 'text-muted-foreground')}>
            <th scope="row" title={r.label.trim()} className={cn(SHEET_LABEL, 'font-normal', greyed && 'text-muted-foreground')}>{sheetLabel(r)}</th>
            <td colSpan={n} className={cn('border-b border-border px-2 py-[5px] text-left text-muted-foreground', greyed && 'bg-muted/40')}>{fmtCell(r, plan.targets[id]?.find((v) => v !== null) ?? null)}<span className="ml-2 text-[10.5px]">one value, not monthly</span></td>
          </tr>
        ) : (
          <tr data-sheet-row={r.row} data-line-kind="target" data-dir={r.dir}>
            <th scope="row" title={r.label.trim()} className={cn(SHEET_LABEL, 'font-semibold')}>{sheetLabel(r)}</th>
            {plan.months.map((mo, i) => <td key={mo} className={cn('border-b border-r border-border px-2 py-[5px] text-right text-muted-foreground', col(i))}>{fmtCell(r, plan.targets[id]?.[i], i)}</td>)}
          </tr>
        );
        // A typed line entered once (the opening balances) takes the first month only.
        const once = typed === 'opening_inventory' || typed === 'opening_customers';
        return (
          <Fragment key={key}>
            {targetLine}
            {kind === 'typed' && (
              <tr data-sheet-actual={r.row} data-actual-kind="typed">
                <ActualLabel label={REQUIRED.has(typed) ? 'actual' : once ? 'actual (typed once)' : 'actual (optional)'} />
                {plan.months.map((mo, i) => (once && i > 0) ? <td key={mo} className={cn('border-b border-r border-border', col(i))} /> : <TypedCell key={mo} metric={typed} mo={mo} i={i} plan={plan} nowKey={nowKey} edit={edit} status={statusAt(i)} col={col(i)} />)}
              </tr>
            )}
            {kind === 'computed' && (
              <tr data-sheet-actual={r.row} data-actual-kind="computed">
                <ActualLabel />
                {plan.months.map((mo, i) => {
                  const c = sheet[r.row]?.[i] ?? GAP;
                  const phase = monthPhase(mo, nowKey);
                  const s = statusAt(i);
                  const click = CLICKABLE.has(id) && s === 'bad';
                  const cls = cn('border-b border-r border-border px-2 py-[5px] text-right font-semibold', cellActual(s), s === 'live' && 'font-normal italic', click && 'cursor-pointer hover:outline hover:outline-2 hover:-outline-offset-2 hover:outline-[var(--status-crit)]', col(i));
                  const shown = phase === 'future' ? null : c.value === null ? <span className="sr-only">waiting</span>
                    : <>{fmtCell(r, c.value, i)}{c.state === 'partial' && <span className="block text-[10px] font-normal not-italic text-muted-foreground/80">partial</span>}</>;
                  const title = s === 'ok' || s === 'bad' ? `${STATUS_TEXT[s]}${judgedAs(r)}` : s === 'modelled' ? 'Modelled from plan assumptions, not judged' : c.note;
                  return click
                    ? <td key={mo} data-status={s} title={`${title}. Click to see why`} className={cls} onClick={() => onWhy(id, i)}>{shown}</td>
                    : <td key={mo} data-status={s} title={title} className={cls}>{shown}</td>;
                })}
              </tr>
            )}
            {r.row === 90 && (
              // The sheet starts cash from 0 and has no opening-cash cell: Coop asks for the bank balance at the start of the first month, once.
              <tr data-sheet-actual="opening_cash" data-actual-kind="typed">
                <th scope="row" className={cn(SUB_CELL, 'uppercase')}>opening cash<InfoTip text={PLAN_HELP.openingCash(edit.canEdit, (edit.lines.opening_cash?.[0] ?? null) !== null)} label="About opening cash" className="ml-0.5" /></th>
                {plan.months.map((mo, i) => i > 0 ? <td key={mo} className={cn('border-b border-r border-border', col(i))} /> : <TypedCell key={mo} metric="opening_cash" mo={mo} i={0} plan={plan} nowKey={nowKey} edit={edit} status="info" col={col(i)} />)}
              </tr>
            )}
          </Fragment>
        );
      })}
    </>
  );
}
