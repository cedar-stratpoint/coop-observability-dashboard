'use client';

// Shared pieces of the reconciliation pages (NICH-17): the ✓/✗ leg marks, the state
// chip, the 8-tile matrix legend (Justin's notebook, made clickable), and the section
// tabs (By store · By product · PO form).

import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {Check, FileSpreadsheet, X} from 'lucide-react';
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
 * The matrix as a short, ranked set of choices (Hick's law, Nov 24). Instead of eight
 * equal tiles, only the states that need a step AND have products get a tile, most urgent
 * first; everything else (no-action states, empty states) folds into one quiet line. Each
 * tile still shows its Watsons · Inventory · PO pattern. Clicking filters the table.
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
  const calm = AUDIT_STATES.filter((s) => !NEEDS_ACTION.has(s) && summary[s] > 0);
  const empty = AUDIT_STATES.filter((s) => summary[s] === 0);

  return (
    <div className="flex flex-col gap-3">
      {steps.length === 0 ? (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5">
          <Mark on />
          <p className="text-sm">
            <span className="font-medium">Nothing needs a step.</span> <span className="text-muted-foreground">Every product here lines up.</span>
          </p>
        </div>
      ) : (
        <div className="grid gap-2.5" style={{gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, 13.5rem), 1fr))`}}>
          {steps.map((s, i) => {
            const m = AUDIT_META[s];
            const on = active === s;
            const c = toneOf(s);
            const lead = i === 0;
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                onClick={() => onPick(on ? null : s)}
                className={cn(
                  'group relative flex flex-col gap-3 overflow-hidden rounded-xl border bg-card p-4 text-left',
                  'transition-[transform,border-color,box-shadow] duration-150 ease-out active:scale-[0.98]',
                  'focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none',
                  on ? 'border-transparent shadow-sm' : 'border-border [@media(hover:hover)]:hover:border-foreground/20',
                )}
                style={on ? {boxShadow: `0 0 0 1.5px ${c}`, background: tint(c, 8)} : lead ? {background: tint(c, 5)} : undefined}
              >
                <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{background: c}} />
                <span className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1" aria-label={`Watsons ${m.legs.watsons ? 'yes' : 'no'}, Inventory ${m.legs.inventory ? 'yes' : 'no'}, PO ${m.legs.po ? 'yes' : 'no'}`}>
                    <Mark size="sm" on={m.legs.watsons} />
                    <Mark size="sm" on={m.legs.inventory} />
                    <Mark size="sm" on={m.legs.po} />
                  </span>
                  <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{m.legs.po ? 'Active' : 'Inactive'}</span>
                </span>
                <span className="flex items-end justify-between gap-3">
                  <span className="flex flex-col">
                    <span className="font-heading text-3xl leading-none font-semibold tabular-nums">{summary[s].toLocaleString('en-US')}</span>
                    <span className="mt-1.5 text-sm font-medium" style={{color: ink(c)}}>
                      {m.label}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{color: ink(c), background: tint(c, 12)}}>
                    {m.owner === 'Admin' ? 'You' : m.owner}
                  </span>
                </span>
                <span className="sr-only">
                  {summary[s]} {unit}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {(calm.length > 0 || empty.length > 0) && (
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          {calm.length > 0 && (
            <>
              <span>No step needed:</span>
              {calm.map((s, i) => (
                <span key={s} className="inline-flex items-center">
                  <button
                    type="button"
                    aria-pressed={active === s}
                    onClick={() => onPick(active === s ? null : s)}
                    className={cn(
                      'rounded-md px-1.5 py-0.5 font-medium underline-offset-4 transition-colors duration-150',
                      active === s ? 'bg-muted text-foreground' : 'text-foreground [@media(hover:hover)]:hover:underline',
                    )}
                  >
                    {AUDIT_META[s].label} <span className="tabular-nums">{summary[s]}</span>
                  </button>
                  {i < calm.length - 1 && <span aria-hidden>·</span>}
                </span>
              ))}
            </>
          )}
          {calm.length > 0 && empty.length > 0 && <span aria-hidden className="px-1">|</span>}
          {empty.length > 0 && <span>At 0: {empty.map((s) => AUDIT_META[s].label).join(' · ')}</span>}
        </p>
      )}
    </div>
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
