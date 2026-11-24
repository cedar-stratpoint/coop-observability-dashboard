'use client';

// Shared pieces of the reconciliation pages (NICH-17): the ✓/✗ leg marks, the state
// chip, the 8-tile matrix legend (Justin's notebook, made clickable), and the section
// tabs (By store · By product · PO form).

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {Check, ChevronLeft, ChevronRight, FileSpreadsheet, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {AUDIT_META, AUDIT_STATES, NEEDS_ACTION, type AuditState, type AuditSummary} from '@/src/goldline-audit';
import type {PoLeg} from '@/src/goldline-audit-data';

export const TONE_VAR: Record<(typeof AUDIT_META)[AuditState]['tone'], string> = {
  good: 'var(--status-good)',
  warn: 'var(--status-warn)',
  crit: 'var(--status-crit)',
  neutral: 'var(--cat-4)',
  out: 'var(--muted-foreground)',
};

export const toneOf = (s: AuditState) => TONE_VAR[AUDIT_META[s].tone];
export const tint = (color: string, pct = 14) => `color-mix(in oklab, ${color} ${pct}%, transparent)`;
export const ink = (color: string) => `color-mix(in oklab, ${color} 78%, var(--foreground))`;

export function monthLabel(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-US', {month: 'short', year: 'numeric', timeZone: 'UTC'});
}

/** A leg's check or x. `size` sm for the legend, md for the table. */
export function Mark({on, size = 'md', label}: {on: boolean; size?: 'sm' | 'md'; label?: string}) {
  const box = size === 'sm' ? 'size-4' : 'size-6';
  const icon = size === 'sm' ? 'size-2.5' : 'size-3.5';
  return (
    <span
      role="img"
      aria-label={`${label ? `${label}: ` : ''}${on ? 'yes' : 'no'}`}
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full', box, !on && 'bg-muted text-muted-foreground/70')}
      style={on ? {background: tint('var(--status-good)', 16), color: ink('var(--status-good)')} : undefined}
    >
      {on ? <Check className={icon} strokeWidth={3} /> : <X className={icon} strokeWidth={2.5} />}
    </span>
  );
}

export function StateChip({state}: {state: AuditState}) {
  const c = toneOf(state);
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap" style={{color: ink(c), background: tint(c)}}>
      <span aria-hidden className="size-1.5 rounded-full" style={{background: c}} />
      {AUDIT_META[state].label}
    </span>
  );
}

/** How urgent a state's tone is, for ordering the choices (most urgent first). */
export const URGENCY: Record<(typeof AUDIT_META)[AuditState]['tone'], number> = {crit: 0, warn: 1, out: 2, neutral: 3, good: 4};

/**
 * The matrix as ranked choices (Hick's law, Nov 24). Every state stays one click away, but
 * not every state asks for the same attention:
 *   • primary: a tile only for states that need a step AND have products, most urgent
 *     first; these are the decisions the page exists for;
 *   • secondary: every other state (no-action states, and anything at 0) as a small chip in
 *     one row, Active then Inactive, so the full notebook matrix is still there to filter.
 * Tone shows as a dot and, when picked, a soft ring and tint; no side stripes.
 */
export function MatrixLegend({
  summary,
  active,
  onPick,
  unit,
}: {
  summary: AuditSummary;
  active: AuditState | null;
  onPick: (s: AuditState | null) => void;
  unit: string;
}) {
  const rank = (a: AuditState, b: AuditState) => URGENCY[AUDIT_META[a].tone] - URGENCY[AUDIT_META[b].tone] || summary[b] - summary[a];
  const steps = AUDIT_STATES.filter((s) => NEEDS_ACTION.has(s) && summary[s] > 0).sort(rank);
  const rest = AUDIT_STATES.filter((s) => !steps.includes(s));
  const restActive = rest.filter((s) => AUDIT_META[s].legs.po);
  const restInactive = rest.filter((s) => !AUDIT_META[s].legs.po);
  const pick = (s: AuditState) => onPick(active === s ? null : s);

  return (
    <div className="flex flex-col gap-3">
      {steps.length === 0 ? (
        <div className="flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3.5">
          <Mark on />
          <p className="text-sm">
            <span className="font-medium">Nothing needs a step.</span> <span className="text-muted-foreground">Every product here lines up.</span>
          </p>
        </div>
      ) : (
        <div className="grid gap-3" style={{gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, 14rem), 1fr))`}}>
          {steps.map((s) => (
            <StateTile key={s} state={s} n={summary[s]} on={active === s} onClick={() => pick(s)} unit={unit} />
          ))}
        </div>
      )}

      {rest.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
          <span className="mr-1 text-xs text-muted-foreground">{steps.length ? 'Everything else' : 'All states'}</span>
          {[restActive, restInactive].map((group, gi) =>
            group.length ? (
              <span key={gi} className="flex flex-wrap items-center gap-1.5">
                {gi === 1 && restActive.length > 0 && <span aria-hidden className="mx-1 h-4 w-px bg-border" />}
                <span className="text-[10px] font-medium tracking-[0.08em] text-muted-foreground/80 uppercase">{gi === 0 ? 'Active' : 'Inactive'}</span>
                {group.map((s) => (
                  <StateChipButton key={s} state={s} n={summary[s]} on={active === s} onClick={() => pick(s)} />
                ))}
              </span>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

/** A primary choice: the count leads, the state reads under it with its tone dot. */
function StateTile({state, n, on, onClick, unit}: {state: AuditState; n: number; on: boolean; onClick: () => void; unit: string}) {
  const m = AUDIT_META[state];
  const c = toneOf(state);
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'group flex flex-col gap-4 rounded-2xl border bg-card p-4 text-left',
        'transition-[transform,border-color,background-color,box-shadow] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.98]',
        'focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none',
        on ? 'shadow-sm' : 'border-border [@media(hover:hover)]:hover:border-foreground/20 [@media(hover:hover)]:hover:shadow-sm',
      )}
      style={on ? {borderColor: `color-mix(in oklab, ${c} 55%, transparent)`, background: tint(c, 6), boxShadow: `0 0 0 3px ${tint(c, 12)}`} : undefined}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1" aria-label={`Watsons ${m.legs.watsons ? 'yes' : 'no'}, Inventory ${m.legs.inventory ? 'yes' : 'no'}, PO ${m.legs.po ? 'yes' : 'no'}`}>
          <Mark size="sm" on={m.legs.watsons} />
          <Mark size="sm" on={m.legs.inventory} />
          <Mark size="sm" on={m.legs.po} />
        </span>
        <span className="text-[11px] text-muted-foreground">
          {m.legs.po ? 'Active' : 'Inactive'} · <span className="font-medium text-foreground/80">{m.owner === 'Admin' ? 'You' : m.owner}</span>
        </span>
      </span>
      <span className="flex flex-col gap-1.5">
        <span className="font-heading text-[2rem] leading-none font-semibold tracking-tight tabular-nums">{n.toLocaleString('en-US')}</span>
        <span className="flex items-center gap-2 text-sm font-medium">
          <span aria-hidden className="relative flex size-2">
            <span className="absolute inset-0 rounded-full opacity-30" style={{background: c, transform: 'scale(2)'}} />
            <span className="relative size-2 rounded-full" style={{background: c}} />
          </span>
          {m.label}
        </span>
      </span>
      <span className="sr-only">
        {n} {unit}
      </span>
    </button>
  );
}

/** A secondary choice: small, still clickable, still shows its count (0 included). */
function StateChipButton({state, n, on, onClick}: {state: AuditState; n: number; on: boolean; onClick: () => void}) {
  const c = toneOf(state);
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      title={AUDIT_META[state].action}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium',
        'transition-[transform,border-color,background-color,color] duration-150 ease-out active:scale-[0.97]',
        'focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none',
        on ? 'text-foreground' : 'border-border bg-card text-muted-foreground [@media(hover:hover)]:hover:border-foreground/20 [@media(hover:hover)]:hover:text-foreground',
      )}
      style={on ? {borderColor: `color-mix(in oklab, ${c} 55%, transparent)`, background: tint(c, 10)} : undefined}
    >
      <span aria-hidden className="size-1.5 rounded-full" style={{background: c, opacity: n ? 1 : 0.4}} />
      {AUDIT_META[state].label}
      <span className={cn('tabular-nums', n ? 'text-foreground' : 'text-muted-foreground/70')}>{n.toLocaleString('en-US')}</span>
    </button>
  );
}

/** W · I · P key, shown once above the choices so the dots read. */
export function LegKey() {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>
        Dots read <strong className="font-medium text-foreground">Watsons · Inventory · PO</strong>
      </span>
      <span className="inline-flex items-center gap-1">
        <Mark size="sm" on /> yes
      </span>
      <span className="inline-flex items-center gap-1">
        <Mark size="sm" on={false} /> no
      </span>
    </p>
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
          <span className="font-medium">No PO form yet.</span> <span className="text-muted-foreground">Until one is uploaded, every product that isn&apos;t retired counts as on the PO.</span>
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
        {from} to {to} of {total}
      </span>
    </nav>
  );
}
