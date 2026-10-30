'use client';

import {useEffect, useId, useMemo, useRef, useState} from 'react';
import {CalendarRange, ChevronDown, X} from 'lucide-react';
import {allMonths, monthLabel, monthRows, presence, presenceText, spread, type Presence, type SkuMonths} from '@/src/goldline-sku-months';
import {ModalShell, useModalExit} from './modal-shell';
import {cn} from '@/lib/utils';

// Watsons SKUs month by month on SKU linking (Oct 29). Each Watsons SKU gets a pointer
// ("Only in Dec 2025" or "In 9 of 12 months") that opens the monthly Watsons files as
// tabs, like the inventory form view: every SKU in that month's file, with this one
// outlined and scrolled into view, and a dot on the months it is in. A foldable panel
// sums up the files: SKUs per file, first and last seen, and how many files each SKU is in.

export type SkuInfo = {name: string; linked: string | null};

const n = (v: number) => v.toLocaleString('en-US');

/** The pointer under a Watsons SKU's code. One-month SKUs stand out. */
export function MonthsPointer({p, total, onClick}: {p: Presence; total: number; onClick: () => void}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Show this SKU in the monthly Watsons files"
      className={cn(
        'inline-flex w-fit items-center gap-1 rounded-sm text-left text-xs tabular-nums outline-none underline decoration-dotted underline-offset-4 transition-colors focus-visible:outline-2 focus-visible:outline-ring',
        p.only ? 'font-medium decoration-[var(--status-warn)]' : 'text-muted-foreground decoration-border hover:text-foreground hover:decoration-foreground',
      )}
      style={p.only ? {color: 'var(--status-warn)'} : undefined}
    >
      <CalendarRange className="size-3 shrink-0" aria-hidden />
      {presenceText(p, total)}
    </button>
  );
}

/** One monthly Watsons file on screen, with one SKU pinpointed; months flip without closing. */
export function WatsonsMonthDialog({data, skus, at, onClosed}: {data: SkuMonths; skus: Record<string, SkuInfo>; at: {sku: string | null; month: string}; onClosed: () => void}) {
  const {closing, close} = useModalExit(onClosed);
  const months = useMemo(() => allMonths(data), [data]);
  const [month, setMonth] = useState(at.month);
  const titleId = useId();
  const mark = useRef<HTMLTableRowElement>(null);
  const p = at.sku ? presence(data[at.sku]) : null;
  const inMonth = new Set(p && at.sku ? data[at.sku].map((c) => String(c[0]).slice(0, 10)) : []);

  const rows = useMemo(
    () =>
      Object.entries(data)
        .flatMap(([sku, cells]) => {
          const c = cells.find((x) => String(x[0]).slice(0, 10) === month);
          return c ? [{sku, units: Number(c[1]) || 0, stores: Number(c[2]) || 0}] : [];
        })
        .sort((a, b) => b.units - a.units || a.sku.localeCompare(b.sku)),
    [data, month],
  );
  const total = rows.reduce((a, r) => a + r.units, 0);
  const hereNow = at.sku != null && inMonth.has(month);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  useEffect(() => {
    if (!hereNow) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => mark.current?.scrollIntoView({block: 'center', behavior: reduced ? 'auto' : 'smooth'}));
  }, [month, hereNow]);

  return (
    <ModalShell closing={closing} onBackdropClick={close} labelledBy={titleId} panelClassName="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-lg">
      <header className="flex flex-col gap-3 border-b px-5 pt-4 pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 id={titleId} className="font-heading text-base font-semibold tracking-tight">
              Watsons sales file · {monthLabel(month)}
            </h2>
            {at.sku && p ? (
              <p className="truncate text-sm text-muted-foreground">
                <span className="font-mono text-xs">{at.sku}</span> <span className="text-foreground">{skus[at.sku]?.name ?? ''}</span>:{' '}
                {p.only ? (
                  <span className="font-medium" style={{color: 'var(--status-warn)'}}>
                    only in {monthLabel(p.first)}
                  </span>
                ) : (
                  <>
                    in {p.count} of {months.length} months, {monthLabel(p.first)} to {monthLabel(p.last)}
                  </>
                )}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {n(rows.length)} Watsons SKUs in this file · {n(total)} units
              </p>
            )}
          </div>
          <button type="button" onClick={close} aria-label="Close" className="-mr-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        <div role="tablist" aria-label="Month" className="-mx-1 flex flex-wrap gap-1 px-1">
          {months.map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={month === m}
              onClick={() => setMonth(m)}
              className={cn(
                'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-xs whitespace-nowrap tabular-nums transition-colors duration-150',
                month === m ? 'bg-foreground font-medium text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {monthLabel(m)}
              {inMonth.has(m) && <span className="size-1.5 rounded-full bg-[var(--status-warn)]" aria-label="has this SKU" />}
            </button>
          ))}
        </div>
      </header>

      {at.sku && !hereNow && (
        <p className="border-b bg-muted/40 px-5 py-2 text-xs text-muted-foreground">
          <span className="font-mono">{at.sku}</span> isn&apos;t in the {monthLabel(month)} file. The dotted months have it.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-popover">
            <tr className="border-b text-left text-[11px] font-medium text-muted-foreground">
              <th className="px-3 py-2 font-medium whitespace-nowrap">Watsons SKU</th>
              <th className="px-3 py-2 font-medium">Name in the file</th>
              <th className="px-3 py-2 text-right font-medium">Units</th>
              <th className="px-3 py-2 text-right font-medium max-sm:hidden">Stores</th>
              <th className="px-3 py-2 font-medium max-md:hidden">Our item</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const hit = r.sku === at.sku;
              const info = skus[r.sku];
              const only = presence(data[r.sku])?.only;
              return (
                <tr
                  key={r.sku}
                  ref={hit ? mark : undefined}
                  aria-current={hit ? 'true' : undefined}
                  className={cn('border-b border-border/60', hit && 'bg-[color-mix(in_oklab,var(--status-warn)_16%,transparent)] outline-2 -outline-offset-2 outline-[var(--status-warn)]')}
                >
                  <td className={cn('px-3 py-2 font-mono text-xs', hit ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{r.sku}</td>
                  <td className={cn('w-full max-w-0 px-3 py-2', hit && 'font-medium')}>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{info?.name ?? r.sku}</span>
                      {only && (
                        <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10.5px] font-medium" style={{color: 'var(--status-warn)', background: 'color-mix(in oklab, var(--status-warn) 14%, transparent)'}}>
                          only this month
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{n(r.units)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground max-sm:hidden">{n(r.stores)}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground max-md:hidden">{info?.linked ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <footer className="border-t px-5 py-2.5 text-xs text-muted-foreground">
        Watsons&apos; own file for the month, biggest sellers first.<span className="max-md:hidden"> A SKU is listed when it had any sales or returns that month.</span>
      </footer>
    </ModalShell>
  );
}

const MONTHS_KEY = 'coop.skus.monthsOpen';

/** "Watsons files by month": a foldable summary under the numbers table. */
export function WatsonsMonthsPanel({data, onOpenMonth}: {data: SkuMonths; onOpenMonth: (month: string) => void}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(MONTHS_KEY) === '1') setOpen(true);
    } catch {}
  }, []);
  const toggle = () =>
    setOpen((v) => {
      try {
        localStorage.setItem(MONTHS_KEY, v ? '0' : '1');
      } catch {}
      return !v;
    });
  const rows = useMemo(() => monthRows(data), [data]);
  const groups = useMemo(() => spread(data), [data]);
  if (!rows.length) return null;
  const busiest = rows.reduce((a, r) => (r.skus > a.skus ? r : a), rows[0]);
  const last = rows[rows.length - 1].month;
  // Every SKU is first seen in exactly one file, so both totals are the Watsons SKU count.
  const totalSkus = rows.reduce((a, r) => a + r.firstSeen, 0);

  return (
    <section aria-label="Watsons files by month" className="overflow-hidden rounded-xl border">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 bg-muted/40 px-4 py-3 sm:px-6">
        <span className="text-xs font-medium text-muted-foreground">Watsons files by month</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {rows.length} files, {monthLabel(rows[0].month)} to {monthLabel(last)} · {groups[0]?.skus ?? 0} SKUs in every file
        </span>
      </div>
      <div className={cn('grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div className="min-h-0 overflow-hidden" aria-hidden={!open}>
          <div className="grid gap-6 border-t px-4 py-4 sm:px-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b text-left text-[11px] font-medium text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Month</th>
                    <th className="py-2 pr-3 text-right font-medium">SKUs in the file</th>
                    <th className="py-2 pr-3 text-right font-medium">First time seen</th>
                    <th className="py-2 text-right font-medium">Last time seen</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.month} className="border-b border-border/60 last:border-0">
                      <td className="py-1.5 pr-3">
                        <button
                          type="button"
                          tabIndex={open ? undefined : -1}
                          onClick={() => onOpenMonth(r.month)}
                          title={`Show the ${monthLabel(r.month)} file`}
                          className="rounded-sm underline decoration-border decoration-dotted underline-offset-4 outline-none transition-colors hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {monthLabel(r.month)}
                        </button>
                      </td>
                      <td className={cn('py-1.5 pr-3 text-right tabular-nums', r.month === busiest.month && 'font-semibold')}>
                        {n(r.skus)}
                        {r.month === busiest.month && <span className="ml-1 text-xs font-normal text-muted-foreground">most</span>}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">{i === 0 ? `${n(r.firstSeen)} (first file)` : n(r.firstSeen)}</td>
                      <td className="py-1.5 text-right tabular-nums text-muted-foreground">{r.month === last ? '(latest file)' : n(r.lastSeen)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 text-sm font-semibold">
                    <td className="py-2 pr-3">Total</td>
                    <td className="py-2 pr-3" />
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {n(totalSkus)}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">SKUs</span>
                    </td>
                    <td className="py-2" />
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="flex flex-col gap-3">
              <p className="text-[11px] font-medium text-muted-foreground">How many files each SKU is in</p>
              <ul className="flex flex-col divide-y overflow-hidden rounded-lg border">
                {groups.map((g) => (
                  <li key={g.label} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className={cn(g.from === 1 && g.to === 1 && 'font-medium')} style={g.from === 1 && g.to === 1 ? {color: 'var(--status-warn)'} : undefined}>
                      {g.label}
                    </span>
                    <span className="tabular-nums">{n(g.skus)}</span>
                  </li>
                ))}
                <li className="flex items-center justify-between gap-3 bg-muted/40 px-3 py-2 text-sm font-semibold">
                  <span>Total</span>
                  <span className="tabular-nums">
                    {n(groups.reduce((a, g) => a + g.skus, 0))}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">SKUs</span>
                  </span>
                </li>
              </ul>
              <p className="text-xs leading-relaxed text-muted-foreground">
                A monthly file lists the SKUs that sold or were returned that month, so a SKU can skip months. One-month SKUs are often seasonal sets or old stock; the SKUs with no units sold are among them.
              </p>
            </div>
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-center gap-1.5 border-t border-primary/25 bg-primary/15 py-3 text-sm font-semibold text-primary outline-none transition-colors duration-150 hover:bg-primary/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {open ? 'Hide the months' : `Show the months · ${rows.length} files`}
        <ChevronDown aria-hidden className={cn('size-4 transition-transform duration-200 ease-out motion-reduce:transition-none', open && 'rotate-180')} />
      </button>
    </section>
  );
}
