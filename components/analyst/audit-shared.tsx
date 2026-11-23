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

/**
 * The notebook matrix as 8 filter tiles, in two groups. Each tile shows its W · I · P
 * pattern, the count and the label. Clicking filters the table (click again to clear).
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
  const groups: Array<{title: string; hint: string; states: AuditState[]}> = [
    {title: 'Active', hint: 'On the PO form', states: AUDIT_STATES.slice(0, 4)},
    {title: 'Inactive', hint: 'Not on the PO form', states: AUDIT_STATES.slice(4)},
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {groups.map((g) => (
        <section key={g.title} aria-label={`${g.title} products`} className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2 px-0.5">
            <h2 className="font-heading text-sm font-semibold">{g.title}</h2>
            <span className="text-xs text-muted-foreground">{g.hint}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {g.states.map((s) => {
              const m = AUDIT_META[s];
              const on = active === s;
              const n = summary[s];
              const c = toneOf(s);
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onPick(on ? null : s)}
                  className={cn(
                    'group relative flex flex-col gap-2.5 overflow-hidden rounded-xl border bg-card p-3 text-left',
                    'transition-[transform,border-color,box-shadow] duration-150 ease-out active:scale-[0.98]',
                    'focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none',
                    on ? 'border-transparent shadow-sm' : 'border-border [@media(hover:hover)]:hover:border-foreground/20',
                    n === 0 && !on && 'opacity-60',
                  )}
                  style={on ? {boxShadow: `0 0 0 1.5px ${c}`, background: tint(c, 7)} : undefined}
                >
                  <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{background: c, opacity: NEEDS_ACTION.has(s) ? 1 : 0.35}} />
                  <span className="flex items-center gap-1" aria-label={`Watsons ${m.legs.watsons ? 'yes' : 'no'}, Inventory ${m.legs.inventory ? 'yes' : 'no'}, PO ${m.legs.po ? 'yes' : 'no'}`}>
                    <Mark size="sm" on={m.legs.watsons} />
                    <Mark size="sm" on={m.legs.inventory} />
                    <Mark size="sm" on={m.legs.po} />
                  </span>
                  <span className="flex flex-col">
                    <span className="font-heading text-2xl leading-none font-semibold tabular-nums">{n.toLocaleString('en-US')}</span>
                    <span className="mt-1 text-xs font-medium" style={{color: n ? ink(c) : undefined}}>
                      {m.label}
                    </span>
                  </span>
                  <span className="sr-only">
                    {n} {unit}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/** W · I · P column key, shown once above the legend so the dots read. */
export function LegKey() {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        Each tile reads <strong className="font-medium text-foreground">Watsons · Inventory · PO</strong>
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
