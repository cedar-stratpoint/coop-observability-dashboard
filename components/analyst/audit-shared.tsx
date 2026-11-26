'use client';

// Shared pieces of the reconciliation pages (NICH-17): the leg marks and letters, the state
// chip, the notebook grid of the eight recommendations (the page's only filter), the
// "Can't tell yet" reasons, the no-sales notice, and the section tabs.

import {useEffect, useId, useRef, useState, type ReactNode} from 'react';
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {AlertTriangle, ArrowDown, Check, ChevronDown, ChevronLeft, ChevronRight, FileSpreadsheet, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {AUDIT_META, MATRIX_STATES, NEEDS_ACTION, RECO_LETTERS, RECO_META, WHY_LABEL, WHY_ORDER, type AuditState, type AuditSummary, type Leg, type RecoLetter, type WhyUnknown} from '@/src/goldline-audit';
import type {AuditCoverage, PoLeg} from '@/src/goldline-audit-data';
import {InfoTip} from '@/components/analyst/info-tip';

export const TONE_VAR: Record<(typeof AUDIT_META)[AuditState]['tone'], string> = {
  good: 'var(--status-good)',
  warn: 'var(--status-warn)',
  crit: 'var(--status-crit)',
  neutral: 'var(--cat-4)',
  out: 'var(--muted-foreground)',
  unknown: 'var(--chart-5)',
};

export const toneOf = (s: AuditState) => TONE_VAR[AUDIT_META[s].tone];
export const tint = (color: string, pct = 14) => `color-mix(in oklab, ${color} ${pct}%, transparent)`;
export const ink = (color: string) => `color-mix(in oklab, ${color} 78%, var(--foreground))`;

export function monthLabel(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-US', {month: 'short', year: 'numeric', timeZone: 'UTC'});
}

const LEG_WORD: Record<Leg, string> = {yes: 'yes', no: 'no', unknown: 'not known'};

/** A leg's check, x or ?. `size` sm for the legend, md for the table. */
export function Mark({leg, size = 'md', label}: {leg: Leg; size?: 'xs' | 'sm' | 'md'; label?: string}) {
  const box = size === 'xs' ? 'size-3.5' : size === 'sm' ? 'size-4' : 'size-6';
  const icon = size === 'xs' ? 'size-2' : size === 'sm' ? 'size-2.5' : 'size-3.5';
  return (
    <span
      role="img"
      aria-label={`${label ? `${label}: ` : ''}${LEG_WORD[leg]}`}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full',
        box,
        leg === 'no' && 'bg-muted text-muted-foreground/70',
        leg === 'unknown' && 'border border-dashed border-muted-foreground/45 text-[0.6em] leading-none font-semibold text-muted-foreground',
        leg === 'unknown' && (size === 'md' ? 'text-xs' : 'text-[9px]'),
      )}
      style={leg === 'yes' ? {background: tint('var(--status-good)', 16), color: ink('var(--status-good)')} : undefined}
    >
      {leg === 'yes' ? <Check className={icon} strokeWidth={3} /> : leg === 'no' ? <X className={icon} strokeWidth={2.5} /> : <span aria-hidden>?</span>}
    </span>
  );
}

export function StateChip({state, label}: {state: AuditState; label?: string}) {
  const c = toneOf(state);
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap" style={{color: ink(c), background: tint(c)}}>
      <span aria-hidden className="size-1.5 rounded-full" style={{background: c}} />
      {label ?? AUDIT_META[state].label}
    </span>
  );
}

/** A leg as a letter: W, I or P. Green for yes, struck grey for no, dashed for not known. */
export function LegLetter({leg, letter, name}: {leg: Leg; letter: 'W' | 'I' | 'P'; name?: string}) {
  return (
    <span
      role="img"
      aria-label={`${name ?? letter}: ${LEG_WORD[leg]}`}
      className={cn(
        'inline-grid size-5 shrink-0 place-items-center rounded-md text-[10.5px] leading-none font-semibold',
        leg === 'no' && 'bg-muted text-muted-foreground line-through decoration-muted-foreground/60',
        leg === 'unknown' && 'border border-dashed border-muted-foreground/50 text-muted-foreground',
      )}
      style={leg === 'yes' ? {background: tint('var(--status-good)', 18), color: ink('var(--status-good)')} : undefined}
    >
      {letter}
    </span>
  );
}

/** The two columns' facts and the two rows' fact, as the notebook reads them. */
const GRID_COLS: Array<{w: Leg; i: Leg; label: string}> = [
  {w: 'yes', i: 'yes', label: 'Sold + counted'},
  {w: 'yes', i: 'no', label: 'Sold, not counted'},
  {w: 'no', i: 'yes', label: 'Counted, no sale'},
  {w: 'no', i: 'no', label: 'Neither'},
];
const GRID_ROWS: Array<{po: Leg; label: string; hint: string}> = [
  {po: 'yes', label: 'On the PO', hint: 'Still delivered'},
  {po: 'no', label: 'Not on the PO', hint: 'Phasing out'},
];
const stateAt = (w: Leg, i: Leg, po: Leg) => MATRIX_STATES.find((s) => {
  const l = AUDIT_META[s].legs;
  return l.watsons === w && l.inventory === i && l.po === po;
})!;

/**
 * The eight recommendations as Justin's notebook lays them out (Nov 25): rows are the PO
 * form, columns are what Watsons and the inventory form say. It is the page's only filter:
 * click a box to list its products. Boxes that need a step are tinted, empty ones fade but
 * stay clickable; hover or focus explains a box. Hick's law by layout: one grid to scan.
 */
export function NotebookGrid({
  summary,
  active,
  onPick,
  unit,
}: {
  summary: AuditSummary;
  /** One state, or every box a Reco letter covers. */
  active: AuditState | AuditState[] | null;
  onPick: (s: AuditState) => void;
  unit: string;
}) {
  return (
    <section aria-label="Recommendations" className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-heading text-base font-semibold">Recommendations</h2>
        <span className="flex items-center gap-2.5">
          <span className="hidden text-xs text-muted-foreground sm:inline">Click a box to see its products</span>
          <HowToRead />
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-[8.5rem_repeat(4,minmax(0,1fr))]">
        <span aria-hidden className="hidden sm:block" />
        {GRID_COLS.map((c) => (
          <span key={c.label} className="hidden flex-col gap-1.5 px-1 pb-1 sm:flex">
            <span className="flex gap-1">
              <LegLetter leg={c.w} letter="W" name="Watsons" />
              <LegLetter leg={c.i} letter="I" name="Inventory" />
            </span>
            <span className="text-xs text-muted-foreground">{c.label}</span>
          </span>
        ))}
        {GRID_ROWS.map((r) => (
          <GridRow key={r.label} row={r} summary={summary} active={active} onPick={onPick} unit={unit} />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Rows are the PO form. Columns are what Watsons and the inventory form say. Faint boxes have nothing this month.</p>
    </section>
  );
}

function GridRow({row, summary, active, onPick, unit}: {row: (typeof GRID_ROWS)[number]; summary: AuditSummary; active: AuditState | AuditState[] | null; onPick: (s: AuditState) => void; unit: string}) {
  return (
    <>
      <span className="col-span-2 flex items-baseline gap-2 px-1 pt-2 sm:col-span-1 sm:flex-col sm:justify-center sm:gap-0.5 sm:pt-0">
        <span className="text-sm font-semibold">{row.label}</span>
        <span className="text-xs text-muted-foreground">{row.hint}</span>
      </span>
      {GRID_COLS.map((c) => {
        const s = stateAt(c.w, c.i, row.po);
        return <GridCell key={s} state={s} n={summary[s]} on={Array.isArray(active) ? active.includes(s) : active === s} onClick={() => onPick(s)} unit={unit} col={c.label} />;
      })}
    </>
  );
}

function GridCell({state, n, on, onClick, unit, col}: {state: AuditState; n: number; on: boolean; onClick: () => void; unit: string; col: string}) {
  const m = AUDIT_META[state];
  const c = toneOf(state);
  const tip = useId();
  const step = n > 0 && NEEDS_ACTION.has(state);
  return (
    <div className="group/tip relative">
      <button
        type="button"
        aria-pressed={on}
        aria-describedby={tip}
        onClick={onClick}
        className={cn(
          'relative flex h-full min-h-[5.75rem] w-full flex-col gap-1.5 rounded-xl border px-3.5 pt-3 pb-3 text-left',
          'transition-[transform,border-color,background-color,box-shadow,opacity] duration-150 ease-out active:scale-[0.98]',
          'focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none',
          !on && 'border-border [@media(hover:hover)]:hover:border-foreground/25',
          n === 0 && !on && 'opacity-45',
        )}
        style={
          on
            ? {borderColor: `color-mix(in oklab, ${c} 60%, transparent)`, background: tint(c, 11), boxShadow: `0 0 0 3px ${tint(c, 16)}`}
            : {background: step ? `color-mix(in oklab, ${c} 6%, var(--card))` : 'color-mix(in oklab, var(--muted) 35%, var(--card))'}
        }
      >
        {m.owner !== 'None' && <span className="absolute top-2.5 right-3 text-[10.5px] text-muted-foreground">{m.owner === 'Admin' ? 'You' : m.owner}</span>}
        <span className="font-heading text-2xl leading-none font-semibold tabular-nums">{n.toLocaleString('en-US')}</span>
        <span className="flex items-center gap-2 text-[13px] font-medium">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{background: c}} />
          {m.label}
        </span>
        <span className="sr-only">
          {n} {unit}, {col}, {m.legs.po === 'yes' ? 'on the PO' : 'not on the PO'}
        </span>
      </button>
      <StateTip id={tip} state={state} fit />
    </div>
  );
}

/** What each kind of missing data asks someone to do. */
const WHY_FIX: Partial<Record<WhyUnknown, {label: string; href: string}>> = {
  month_not_loaded: {label: 'Upload POS sales', href: '/uploads'},
  no_count: {label: 'Upload a form', href: '/uploads'},
  page_missing: {label: 'Upload the page', href: '/uploads'},
  blank: {label: 'Open the scan', href: '/uploads/forms'},
  not_linked: {label: 'Link SKUs', href: '/stock/skus'},
  no_po_form: {label: 'Upload the PO form', href: '/stock/po-form'},
};

/**
 * "Can't tell yet", broken down by what is missing (Nov 25). The lead lists every such
 * line; each reason lists just its lines and links to the fix. Hidden when nothing is missing.
 */
export function UnknownReasons({
  summary,
  active,
  activeWhy,
  onPick,
  hrefFor,
}: {
  summary: AuditSummary;
  /** True when the table shows "Can't tell yet". */
  active: boolean;
  activeWhy: WhyUnknown | null;
  /** Without it the chips are links (By product goes to All stores). */
  onPick?: (why: WhyUnknown | null) => void;
  hrefFor?: (why: WhyUnknown | null) => string;
}) {
  const reasons = WHY_ORDER.filter((w) => summary.why[w] > 0);
  if (!summary.unknown) return null;
  const Pick = ({why, on, children, className}: {why: WhyUnknown | null; on: boolean; children: ReactNode; className?: string}) => (
    <ReasonChip on={on} onClick={onPick ? () => onPick(why) : undefined} href={onPick ? undefined : hrefFor!(why)} className={className}>
      {children}
    </ReasonChip>
  );
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="What the unknown lines are missing">
      <Pick why={null} on={active && !activeWhy} className="font-medium">
        <span aria-hidden className="inline-grid size-5 place-items-center rounded-md border border-dashed border-muted-foreground/50 text-[10.5px] font-semibold text-muted-foreground">?</span>
        <span className="tabular-nums">{summary.unknown.toLocaleString('en-US')}</span> can&apos;t tell yet
      </Pick>
      {reasons.map((w) => {
        const fix = WHY_FIX[w];
        return (
          <span key={w} className="inline-flex items-center gap-1">
            <Pick why={w} on={active && activeWhy === w}>
              {WHY_LABEL[w]} <span className="font-semibold tabular-nums">{summary.why[w].toLocaleString('en-US')}</span>
            </Pick>
            {fix && (
              <Link href={fix.href} className="rounded-md px-1.5 py-1 text-xs font-medium text-primary underline-offset-4 [@media(hover:hover)]:hover:underline">
                {fix.label}
              </Link>
            )}
          </span>
        );
      })}
    </div>
  );
}

const CHIP = 'inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] transition-[transform,border-color,background-color] duration-150 ease-out active:scale-[0.97] focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none';
const CHIP_ON = {borderColor: 'color-mix(in oklab, var(--muted-foreground) 55%, transparent)', background: tint('var(--muted-foreground)', 10)};

/** A reason chip: filters the table (onClick), or links to the lines (href). */
function ReasonChip({on, onClick, href, className, children}: {on: boolean; onClick?: () => void; href?: string; className?: string; children: ReactNode}) {
  if (href)
    return (
      <Link href={href} className={cn(CHIP, 'border-border bg-card [@media(hover:hover)]:hover:border-foreground/25', className)}>
        {children}
      </Link>
    );
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={cn(CHIP, !on && 'border-border bg-card [@media(hover:hover)]:hover:border-foreground/25', className)} style={on ? CHIP_ON : undefined}>
      {children}
    </button>
  );
}

/**
 * A month whose Watsons sales aren't in can't be judged at all: say so once, plainly, with
 * the fix and a way to a month that can be (Nov 25). Replaces the grid for that month.
 */
export function NoSalesNotice({month, total, unit, otherMonth, otherHref}: {month: string; total: number; unit: string; otherMonth: string | null; otherHref: string | null}) {
  const warn = 'var(--status-warn)';
  return (
    <section className="flex gap-4 rounded-2xl border border-border bg-card p-5 sm:p-6" aria-label="Nothing to recommend yet">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl" style={{background: tint(warn, 14), color: ink(warn)}}>
        <AlertTriangle className="size-5" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="text-base font-semibold">Nothing to recommend for {monthLabel(month)} yet</h2>
        <p className="text-sm text-muted-foreground">
          Watsons sales for {monthLabel(month)} aren&apos;t loaded, so whether each product sold can&apos;t be known.{' '}
          <span className="tabular-nums">{total.toLocaleString('en-US')}</span> {unit} are waiting.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href="/uploads" className="inline-flex h-9 items-center rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-transform duration-150 ease-out active:scale-[0.97]">
            Upload POS sales
          </Link>
          {otherMonth && otherHref && (
            <Link href={otherHref} className="inline-flex h-9 items-center rounded-lg border border-border bg-card px-3.5 text-sm font-medium transition-[transform,border-color] duration-150 ease-out active:scale-[0.97] [@media(hover:hover)]:hover:border-foreground/25">
              See {monthLabel(otherMonth)} instead
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}

/** The legend and the pattern tip, on demand instead of a line above the grid. */
export function HowToRead() {
  const tip = useId();
  return (
    <span className="group/tip relative inline-flex">
      <button
        type="button"
        aria-describedby={tip}
        aria-label="How to read this"
        className="grid size-6 place-items-center rounded-full border border-border bg-card text-xs font-semibold text-muted-foreground transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none [@media(hover:hover)]:hover:text-foreground"
      >
        ?
      </button>
      <span
        role="tooltip"
        id={tip}
        className={cn(
          'pointer-events-none absolute top-[calc(100%+8px)] right-0 z-40 flex w-72 max-w-[calc(100vw-2rem)] origin-top-right flex-col gap-2 rounded-xl border border-border bg-popover p-3.5 text-xs text-popover-foreground shadow-lg',
          'invisible scale-[0.97] opacity-0 transition-[opacity,transform,visibility] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]',
          'group-hover/tip:visible group-hover/tip:scale-100 group-hover/tip:opacity-100 group-has-[:focus-visible]/tip:visible group-has-[:focus-visible]/tip:scale-100 group-has-[:focus-visible]/tip:opacity-100 motion-reduce:scale-100',
        )}
      >
        <span className="text-sm font-semibold">How to read this</span>
        <span className="text-muted-foreground">Each product gets one recommendation from three facts:</span>
        <span className="flex items-center gap-2"><LegLetter leg="yes" letter="W" /> Watsons sold it this month</span>
        <span className="flex items-center gap-2"><LegLetter leg="yes" letter="I" /> It&apos;s counted on the inventory form, with stock</span>
        <span className="flex items-center gap-2"><LegLetter leg="yes" letter="P" /> It&apos;s on the PO form (still delivered)</span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2 text-muted-foreground">
          <span className="inline-flex items-center gap-1"><LegLetter leg="yes" letter="W" /> yes</span>
          <span className="inline-flex items-center gap-1"><LegLetter leg="no" letter="W" /> no</span>
          <span className="inline-flex items-center gap-1"><LegLetter leg="unknown" letter="W" /> not known</span>
        </span>
        <span className="text-muted-foreground">
          Tip: type a pattern like <span className="font-mono font-medium text-foreground">YYX</span> in search to jump to it.
        </span>
      </span>
    </span>
  );
}

const LEG_TEXT: Record<'watsons' | 'inventory' | 'po', Record<Leg, string>> = {
  watsons: {yes: 'Sold at Watsons this month', no: 'No Watsons sale this month', unknown: 'Sales not loaded, or no SKU link'},
  inventory: {yes: 'Counted, with stock', no: 'Not on the form, or counted zero', unknown: 'No count, blank, or page not uploaded'},
  po: {yes: 'On the PO form, so still delivered', no: 'Not on the PO form, being phased out', unknown: 'No PO form in use'},
};

/**
 * What a state means, on hover (after a short delay, so passing over the tiles doesn't
 * flash cards) or on keyboard focus (at once). Reads the three marks out in words, then
 * the step and who takes it. Scales in from its top-left corner, next to the trigger.
 */
function StateTip({id, state, fit}: {id: string; state: AuditState; fit?: boolean}) {
  const m = AUDIT_META[state];
  const c = toneOf(state);
  return (
    <span
      role="tooltip"
      id={id}
      className={cn(
        'pointer-events-none absolute top-[calc(100%+8px)] left-0 z-40 flex origin-top-left flex-col gap-2.5 rounded-xl border border-border bg-popover p-3.5 text-left text-popover-foreground shadow-lg',
        'invisible translate-y-[-2px] scale-[0.97] opacity-0 transition-[opacity,transform,visibility] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]',
        'group-hover/tip:visible group-hover/tip:translate-y-0 group-hover/tip:scale-100 group-hover/tip:opacity-100 group-hover/tip:delay-300',
        'group-has-[:focus-visible]/tip:visible group-has-[:focus-visible]/tip:translate-y-0 group-has-[:focus-visible]/tip:scale-100 group-has-[:focus-visible]/tip:opacity-100 group-has-[:focus-visible]/tip:delay-0',
        'motion-reduce:translate-y-0 motion-reduce:scale-100',
        fit ? 'right-0' : 'w-72 max-w-[calc(100vw-2rem)]',
      )}
    >
      <span className="flex items-center gap-2 text-sm font-semibold">
        <span aria-hidden className="size-2 rounded-full" style={{background: c}} />
        {m.label}
        <span className="ml-auto text-[11px] font-normal text-muted-foreground">{state === 'unknown' ? 'Any of these' : m.legs.po === 'yes' ? 'Active' : 'Inactive'}</span>
      </span>
      <span className="flex flex-col gap-1.5">
        {(['watsons', 'inventory', 'po'] as const).map((leg) => (
          <span key={leg} className="flex items-center gap-2 text-xs">
            <Mark size="xs" leg={m.legs[leg]} />
            <span className={m.legs[leg] === 'yes' ? 'text-foreground' : 'text-muted-foreground'}>{LEG_TEXT[leg][m.legs[leg]]}</span>
          </span>
        ))}
      </span>
      <span className="border-t border-border pt-2.5 text-xs leading-relaxed text-muted-foreground">
        {m.owner !== 'None' && (
          <span className="font-medium" style={{color: ink(c)}}>
            {m.owner === 'Admin' ? 'You' : m.owner}:{' '}
          </span>
        )}
        {m.action}
      </span>
    </span>
  );
}

const TABS = [
  {href: '/stock/audit', label: 'By store'},
  {href: '/stock/audit/products', label: 'By product'},
  {href: '/stock/po-form', label: 'PO form'},
];

/** Section tabs shared by the three reconciliation pages. */
export function ReconTabs({query}: {query?: string}) {
  const path = usePathname();
  return (
    <nav aria-label="Reconciliation views" className="inline-flex w-fit rounded-lg bg-muted p-1">
      {TABS.map((t) => {
        const on = path === t.href;
        return (
          <Link
            key={t.href}
            href={`${t.href}${query && t.href !== '/stock/po-form' ? `?${query}` : ''}`}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-150',
              on ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground [@media(hover:hover)]:hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Where the PO leg comes from: the active PO form, or a nudge to upload one. */
export function PoSourceBar({po}: {po: PoLeg}) {
  if (po.source === 'none') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed px-4 py-3" style={{borderColor: tint('var(--status-warn)', 60), background: tint('var(--status-warn)', 6)}}>
        <p className="text-sm">
          <span className="font-medium">No PO form yet.</span> <span className="text-muted-foreground">Until one is in use, nothing can be recommended.</span>
        </p>
        <Link href="/stock/po-form" className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-transform duration-150 ease-out active:scale-[0.97]">
          Upload the PO form
        </Link>
      </div>
    );
  }
  const when = po.activatedAt ? new Date(po.activatedAt).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'}) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <FileSpreadsheet className="size-4" aria-hidden />
        PO leg from <span className="font-medium text-foreground">{po.fileName}</span>
      </span>
      <span aria-hidden>·</span>
      <span>
        <span className="font-medium text-foreground tabular-nums">{po.onPo}</span> active products
      </span>
      {when && (
        <>
          <span aria-hidden>·</span>
          <span>since {when}</span>
        </>
      )}
      <Link href="/stock/po-form" className="font-medium text-primary underline-offset-4 [@media(hover:hover)]:hover:underline">
        Update
      </Link>
    </div>
  );
}

/** Compact pager: ‹ 11 to 20 of 236 ›, plus page numbers when there are a few. */
export function Pager({page, pages, total, size, onPage, label}: {page: number; pages: number; total: number; size: number; onPage: (p: number) => void; label: string}) {
  const from = page * size + 1;
  const to = Math.min(total, from + size - 1);
  const btn =
    'inline-flex size-7 items-center justify-center rounded-md text-xs font-medium tabular-nums transition-[transform,background-color,color] duration-150 ease-out active:scale-[0.94] disabled:pointer-events-none disabled:opacity-35 focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none';
  // Up to 7 page buttons: first, last, and the pages around the current one.
  const nums = [...new Set([0, pages - 1, page - 1, page, page + 1].filter((n) => n >= 0 && n < pages))].sort((a, b) => a - b);
  return (
    <nav aria-label={`${label} pages`} className="flex items-center gap-1">
      <button type="button" className={cn(btn, 'text-muted-foreground [@media(hover:hover)]:hover:bg-muted')} disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Previous page">
        <ChevronLeft className="size-4" />
      </button>
      {nums.map((n, i) => (
        <span key={n} className="flex items-center gap-1">
          {i > 0 && n - nums[i - 1] > 1 && <span className="px-0.5 text-xs text-muted-foreground">…</span>}
          <button
            type="button"
            aria-current={n === page ? 'page' : undefined}
            onClick={() => onPage(n)}
            className={cn(btn, n === page ? 'bg-foreground text-background' : 'text-muted-foreground [@media(hover:hover)]:hover:bg-muted [@media(hover:hover)]:hover:text-foreground')}
          >
            {n + 1}
          </button>
        </span>
      ))}
      <button type="button" className={cn(btn, 'text-muted-foreground [@media(hover:hover)]:hover:bg-muted')} disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label="Next page">
        <ChevronRight className="size-4" />
      </button>
      <span className="ml-2 text-xs text-muted-foreground tabular-nums">
        {from.toLocaleString('en-US')} to {to.toLocaleString('en-US')} of {total.toLocaleString('en-US')}
      </span>
    </nav>
  );
}

// ── Compact page top (Nov 26, owner: "too many before the table") ────────────────────────────
// Hick's Law: one control row and one quiet context line instead of a banner, four cards and
// a chip row. Von Restorff: the count that needs a step is the one thing in colour, and it
// jumps to the table, which is what the page is for.

const EASE = 'ease-[cubic-bezier(0.23,1,0.32,1)]';

/** Syl's Reco A to D as small letter pills (control row and the pinned bar). The label and
 *  owner are in the tooltip and the table header; the grid below names every group. */
export function RecoPills({summary, active, onPick, size = 'md'}: {summary: AuditSummary; active: RecoLetter | null; onPick: (l: RecoLetter) => void; size?: 'sm' | 'md'}) {
  return (
    <span role="group" aria-label="Reco A to D" className="flex gap-1.5">
      {RECO_LETTERS.map((l) => {
        const m = RECO_META[l];
        const tone = toneOf(m.states[0]);
        const on = active === l;
        const n = summary.letters[l];
        return (
          <button
            key={l}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(l)}
            title={`Reco ${l} · ${m.label} · ${m.owner}`}
            aria-label={`Reco ${l}, ${m.label}: ${n.toLocaleString('en-US')}`}
            className={cn(
              'inline-flex items-center gap-1.5 border tabular-nums outline-none',
              size === 'md' ? 'h-10 rounded-xl px-3 text-sm' : 'h-8 rounded-lg px-2 text-xs',
              'transition-[scale,border-color,background-color] duration-150 active:scale-[0.97] motion-reduce:active:scale-100',
              EASE,
              'focus-visible:ring-3 focus-visible:ring-ring/40',
              on ? 'border-transparent' : 'border-border bg-card [@media(hover:hover)]:hover:border-foreground/25',
              n === 0 && !on && 'opacity-50',
            )}
            style={on ? {background: tint(tone, 16), color: ink(tone), boxShadow: `0 0 0 3px ${tint(tone, 12)}`} : undefined}
          >
            <span className="font-mono font-semibold" style={on ? undefined : {color: ink(tone)}}>
              {l}
            </span>
            <span>{n.toLocaleString('en-US')}</span>
          </button>
        );
      })}
    </span>
  );
}

/** The page's headline count, the only coloured figure up top; pressing it scrolls to `target`. */
export function NeedsStepStat({n, of, unit, target}: {n: number; of?: number; unit: string; target: string}) {
  return (
    <button
      type="button"
      onClick={() => {
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        document.getElementById(target)?.scrollIntoView({behavior: reduce ? 'auto' : 'smooth', block: 'start'});
      }}
      className={cn(
        'group/need ml-auto flex items-center gap-3 rounded-xl py-1 pr-1 pl-3 text-right outline-none',
        'transition-[background-color,scale] duration-150 active:scale-[0.98] motion-reduce:active:scale-100',
        EASE,
        'focus-visible:ring-3 focus-visible:ring-ring/40 [@media(hover:hover)]:hover:bg-primary/8',
      )}
    >
      <span className="flex flex-col items-end">
        <span className="font-heading text-4xl leading-none font-semibold text-primary tabular-nums">{n.toLocaleString('en-US')}</span>
        <span className="mt-1.5 text-xs text-muted-foreground">
          {of != null ? `of ${of.toLocaleString('en-US')} ${unit} need a step` : `${unit} need a step`}
        </span>
      </span>
      <span
        aria-hidden
        className={cn(
          'grid size-8 place-items-center rounded-full bg-primary/12 text-primary transition-[translate,background-color] duration-200',
          EASE,
          'group-hover/need:translate-y-0.5 group-hover/need:bg-primary/20 motion-reduce:group-hover/need:translate-y-0',
        )}
      >
        <ArrowDown className="size-4" />
      </span>
    </button>
  );
}

/** Page title with its explainer behind a ? (the tabs say which view), and the tabs. */
export function ReconHeader({title, help, tabsQuery}: {title: string; help: string; tabsQuery?: string}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <h1 className="flex items-center gap-2 font-heading text-2xl font-semibold tracking-tight">
        {title}
        <InfoTip text={help} />
      </h1>
      <ReconTabs query={tabsQuery} />
    </header>
  );
}

/**
 * One quiet line under the controls: where the PO leg comes from, how much the month covers,
 * and how many lines can't be told yet. The reasons (and their fixes) open below it on demand,
 * and stay open while the table shows "Can't tell yet". A missing PO form keeps its banner:
 * nothing can be recommended without it.
 */
export function ReconContext({po, month, coverage, all, summary, reasonsOpen, children}: {
  po: PoLeg;
  month: string | null;
  coverage: AuditCoverage | null;
  all: boolean;
  summary: AuditSummary | null;
  /** Open the reasons from the start (the table is on "Can't tell yet"). */
  reasonsOpen?: boolean;
  /** The reason chips (UnknownReasons). */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(Boolean(reasonsOpen));
  useEffect(() => {
    if (reasonsOpen) setOpen(true);
  }, [reasonsOpen]);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (panel.current) panel.current.inert = !open;
  }, [open]);
  const id = useId();
  const form = po.source === 'form' ? po : null;
  const when = form?.activatedAt ? new Date(form.activatedAt).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'}) : null;
  const unknown = summary?.unknown ?? 0;
  const facts: ReactNode[] = [];
  if (form)
    facts.push(
      <span key="po" className="inline-flex items-center gap-1.5" title={`${form.fileName}${when ? `, in use since ${when}` : ''}`}>
        <FileSpreadsheet className="size-3.5" aria-hidden />
        PO form, <span className="text-foreground/85 tabular-nums">{form.onPo}</span> products
        <Link href="/stock/po-form" className="font-medium text-primary underline-offset-4 [@media(hover:hover)]:hover:underline">
          Update
        </Link>
      </span>,
    );
  if (coverage?.loaded && month) {
    if (coverage.storesCounted === 0) facts.push(<span key="cov">No inventory form for {monthLabel(month)}, so stock isn&apos;t known</span>);
    else if (all && coverage.storesCounted < coverage.storesSold)
      facts.push(
        <span key="cov" title="At stores without a form only products that sold are listed, and their stock isn't known.">
          Forms from <span className="text-foreground/85 tabular-nums">{coverage.storesCounted}</span> of {coverage.storesSold} stores
        </span>,
      );
  }
  if (coverage && coverage.unlinkedUnits > 0)
    facts.push(
      <span key="unl" className="inline-flex items-center gap-1.5" title="Units sold on Watsons SKUs with no product link can't show here.">
        <span className="text-foreground/85 tabular-nums">{coverage.unlinkedUnits.toLocaleString('en-US')}</span> units on unlinked SKUs
        <Link href="/stock/skus" className="font-medium text-primary underline-offset-4 [@media(hover:hover)]:hover:underline">
          Link SKUs
        </Link>
      </span>,
    );
  return (
    <div className="flex flex-col">
      {po.source === 'none' && (
        <div className="mb-3">
          <PoSourceBar po={po} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground max-sm:flex-col max-sm:items-start">
        {facts.map((f, i) => (
          <span key={i} className="inline-flex items-center gap-3">
            {i > 0 && <span aria-hidden className="text-border max-sm:hidden">·</span>}
            {f}
          </span>
        ))}
        {unknown > 0 && children && (
          <>
            {facts.length > 0 && <span aria-hidden className="text-border max-sm:hidden">·</span>}
            <button
              type="button"
              aria-expanded={open}
              aria-controls={id}
              onClick={() => setOpen((o) => !o)}
              className={cn(
                'group/why inline-flex h-7 items-center gap-1.5 rounded-full border border-dashed px-2.5 outline-none',
                'transition-[border-color,background-color,color,scale] duration-150 active:scale-[0.97] motion-reduce:active:scale-100',
                EASE,
                'focus-visible:ring-3 focus-visible:ring-ring/40',
                open ? 'border-muted-foreground/50 bg-muted text-foreground' : 'border-muted-foreground/35 [@media(hover:hover)]:hover:border-muted-foreground/60 [@media(hover:hover)]:hover:text-foreground',
              )}
            >
              <span className="font-medium text-foreground/90 tabular-nums">{unknown.toLocaleString('en-US')}</span> can&apos;t tell yet
              <ChevronDown aria-hidden className={cn('size-3.5 transition-transform duration-200', EASE, open && 'rotate-180')} />
            </button>
          </>
        )}
      </div>
      {unknown > 0 && children && (
        <div
          id={id}
          ref={panel}
          className={cn('grid transition-[grid-template-rows,opacity,margin] duration-300 motion-reduce:transition-none', EASE, open ? 'mt-3 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}
        >
          <div className="-m-1 min-h-0 overflow-hidden p-1">{children}</div>
        </div>
      )}
    </div>
  );
}
