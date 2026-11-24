'use client';

import {Fragment, useMemo, useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {ChevronRight, Search, X} from 'lucide-react';
import {Card, CardContent} from '@/components/ui/card';
import {cn} from '@/lib/utils';
import {NativeSelect} from '@/components/ui/native-select';
import {GL_PAGE} from '@/src/goldline-ui';
import {ALL_STORES, AUDIT_META, AUDIT_STATES, NEEDS_ACTION, openingState, patternState, type AuditState} from '@/src/goldline-audit';
import type {ProductAuditResult, ProductAuditRow} from '@/src/goldline-audit-data';
import {CoverageNote, ink, LegKey, MatrixLegend, monthLabel, Pager, PoSourceBar, ReconTabs, StateChip, tint, toneOf} from '@/components/analyst/audit-shared';

// Reconciliation · By product (NICH-17). Every counted store in a month, rolled up per
// product: how many stores sit in each of the 8 states, as one stacked bar per product.
// Expand a product to see which stores, grouped by state, each linking to that store.

const FIELD =
  'h-9 rounded-lg border border-border bg-card px-2.5 text-sm outline-none transition-colors duration-150 [@media(hover:hover)]:hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40';

// The store / month pickers: NativeSelect draws an inset chevron (the browser's own arrow sits
// flush against the right edge), sized to match FIELD.
const SELECT = 'h-9 rounded-lg bg-card pr-9 pl-3 duration-150';

const PAGE = 25;

export function AuditProducts({data}: {data: ProductAuditResult}) {
  const router = useRouter();
  // The tiles are the only filter: one state is always selected, opening on the most urgent.
  const [pick, setPick] = useState<AuditState>(() => openingState(data.summary));
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const asState = q.trim() ? patternState(q) : null;
  const state = asState ?? pick;
  const searching = Boolean(q.trim()) && !asState;
  const rows = useMemo(() => {
    const needle = searching ? q.trim().toLowerCase() : '';
    // Search looks across every product; otherwise the selected state's products, most stores first.
    if (needle) return data.rows.filter((r) => r.item_code.toLowerCase().includes(needle) || r.product.toLowerCase().includes(needle));
    return data.rows.filter((r) => r.counts[state] > 0).sort((a, b) => b.counts[state] - a.counts[state] || a.item_code.localeCompare(b.item_code));
  }, [data.rows, state, q, searching]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const at = Math.min(page, pages - 1);
  const filter = (fn: () => void) => {
    fn();
    setPage(0);
  };

  return (
    <div className={GL_PAGE}>
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <p className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">Reconciliation</p>
            <h1 className="mt-1 font-heading text-2xl font-semibold tracking-tight">Every product, across every store</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Each bar splits a product&apos;s stores by recommendation. Open a product to see its stores.
            </p>
          </div>
          <ReconTabs query={data.month ? `month=${data.month}` : undefined} />
        </div>
        <PoSourceBar po={data.po} />
      </header>

      {data.mock && (
        <div className="rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">Sample view. Connect the database to see real counts.</div>
      )}

      {!data.month ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-1 px-6 py-14 text-center">
            <p className="font-heading text-sm font-semibold">No counts to reconcile yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">Commit an inventory form first.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Month
              {/* A month is a filter, not a step: replace, so Back leaves the page. */}
              <NativeSelect className={SELECT} value={data.month} onChange={(e) => router.replace(`/stock/audit/products?month=${e.target.value}`, {scroll: false})}>
                {data.months.map((m) => (
                  <option key={m.month} value={m.month}>
                    {monthLabel(m.month)}
                    {!m.loaded ? ' (no sales yet)' : !m.counted ? ' (no forms)' : ''}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <div className="ml-auto flex gap-6 text-right">
              <div>
                <p className="font-heading text-3xl leading-none font-semibold tabular-nums">{data.storeCount}</p>
                <p className="mt-1 text-xs text-muted-foreground">stores, {data.coverage.storesCounted} with a form</p>
              </div>
              <div>
                <p className="font-heading text-3xl leading-none font-semibold tabular-nums">{data.rows.filter((r) => r.needsAction > 0).length}</p>
                <p className="mt-1 text-xs text-muted-foreground">products need a step somewhere</p>
              </div>
            </div>
          </div>

          <CoverageNote month={data.month} coverage={data.coverage} all />

          <div className="flex flex-col gap-3">
            <LegKey />
            <MatrixLegend
              summary={data.summary}
              active={searching ? null : state}
              onPick={(s) =>
                filter(() => {
                  setPick(s);
                  setQ('');
                })
              }
              unit="store and product pairs"
            />
          </div>

          <Card className="gap-0 overflow-hidden py-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
              {searching ? (
                <p className="text-sm">
                  <span className="font-semibold tabular-nums">{rows.length}</span> {rows.length === 1 ? 'product matches' : 'products match'}{' '}
                  <span className="font-medium">“{q.trim()}”</span> <span className="text-muted-foreground">across every recommendation</span>
                </p>
              ) : (
                <>
                  <StateChip state={state} />
                  <span className="text-sm">
                    <span className="font-heading font-semibold tabular-nums">{rows.length}</span>{' '}
                    <span className="text-muted-foreground">{rows.length === 1 ? 'product is' : 'products are'} here in at least one store</span>
                  </span>
                </>
              )}
              <div className="relative ml-auto">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <input value={q} onChange={(e) => filter(() => setQ(e.target.value))} placeholder="Product or YYX" aria-label="Search products, or type a pattern like YYX" className={cn(FIELD, 'w-60 pl-8', q && 'pr-8')} />
                {q && (
                  <button type="button" onClick={() => filter(() => setQ(''))} aria-label="Clear search" className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 [@media(hover:hover)]:hover:bg-muted">
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[48rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    <th className="w-8 py-2.5 pl-3" aria-label="Expand" />
                    <th className="py-2.5 pr-3 font-medium">Product</th>
                    <th className="px-2 py-2.5 font-medium">PO</th>
                    <th className="w-[38%] px-2 py-2.5 font-medium">Stores by recommendation</th>
                    <th className="py-2.5 pr-4 pl-2 text-right font-medium">Need a step</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-12 text-center text-sm text-muted-foreground">
                        {searching ? 'No product matches that search.' : `No product is at “${AUDIT_META[state].label}” at any store.`}
                      </td>
                    </tr>
                  ) : (
                    rows.slice(at * PAGE, at * PAGE + PAGE).map((r) => (
                      <ProductRow key={r.item_code} r={r} open={open === r.item_code} onToggle={() => setOpen(open === r.item_code ? null : r.item_code)} month={data.month!} />
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {pages > 1 && (
              <div className="border-t border-border px-4 py-2.5">
                <Pager page={at} pages={pages} total={rows.length} size={PAGE} onPage={setPage} label="Products" />
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function ProductRow({r, open, onToggle, month}: {r: ProductAuditRow; open: boolean; onToggle: () => void; month: string}) {
  return (
    <Fragment>
      <tr className={cn('border-b border-border/60 transition-colors duration-150', open ? 'bg-muted/40' : '[@media(hover:hover)]:hover:bg-muted/30')}>
        <td className="py-2.5 pl-3">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} stores for ${r.product}`}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-[transform,background-color] duration-150 ease-out active:scale-[0.94] [@media(hover:hover)]:hover:bg-muted"
          >
            <ChevronRight className={cn('size-4 transition-transform duration-200 ease-out', open && 'rotate-90')} />
          </button>
        </td>
        <td className="py-2.5 pr-3">
          <button type="button" onClick={onToggle} className="text-left text-foreground">
            <span className="block max-w-[24rem] truncate font-medium" title={r.product}>
              {r.shade ?? r.product}
            </span>
            <span className="block max-w-[24rem] truncate text-[11px] text-muted-foreground">
              {r.shade && r.line ? `${r.line} · ` : ''}
              <span className="font-mono">{r.item_code}</span>
              {r.retired && ' · retired'}
            </span>
          </button>
        </td>
        <td className="px-2 py-2.5">
          <span
            className="inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium"
            style={r.po === 'yes' ? {color: ink('var(--status-good)'), background: tint('var(--status-good)')} : undefined}
          >
            {r.po === 'yes' ? 'Active' : <span className="text-muted-foreground">{r.po === 'no' ? 'Inactive' : 'Not known'}</span>}
          </span>
        </td>
        <td className="px-2 py-2.5">
          <StackBar counts={r.counts} total={r.stores} />
        </td>
        <td className="py-2.5 pr-4 pl-2 text-right tabular-nums">
          <span className={cn('font-heading text-base font-semibold', !r.needsAction && 'text-muted-foreground')}>{r.needsAction}</span>
          <span className="text-xs text-muted-foreground"> / {r.stores}</span>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border/60 bg-muted/20">
          <td />
          <td colSpan={4} className="py-3 pr-4">
            <div className="flex flex-col gap-3">
              <Link
                href={`/stock/${encodeURIComponent(r.item_code)}`}
                className="inline-flex w-fit items-center gap-1 text-xs font-medium text-primary underline-offset-4 [@media(hover:hover)]:hover:underline"
              >
                Open the product page (all stores)
                <ChevronRight className="size-3.5" aria-hidden />
              </Link>
              <Link
                href={`/stock/audit?${new URLSearchParams({store: ALL_STORES, month, q: r.item_code})}`}
                className="inline-flex w-fit items-center gap-1 text-xs font-medium text-primary underline-offset-4 [@media(hover:hover)]:hover:underline"
              >
                See its stores, line by line
                <ChevronRight className="size-3.5" aria-hidden />
              </Link>
              {AUDIT_STATES.filter((s) => r.counts[s] > 0).map((s) => (
                <div key={s} className="flex flex-col gap-1.5 sm:flex-row sm:gap-3">
                  <span className="flex w-40 shrink-0 items-center gap-1.5 text-xs font-medium" style={{color: ink(toneOf(s))}}>
                    <span aria-hidden className="size-1.5 rounded-full" style={{background: toneOf(s)}} />
                    {AUDIT_META[s].label} · {r.counts[s]}
                  </span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/** One bar per product: its stores split by state, in the notebook's order. */
function StackBar({counts, total}: {counts: Record<AuditState, number>; total: number}) {
  const parts = AUDIT_STATES.filter((s) => counts[s] > 0);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={parts.map((s) => `${counts[s]} ${AUDIT_META[s].label}`).join(', ')}>
        {parts.map((s, i) => (
          <span
            key={s}
            title={`${AUDIT_META[s].label}: ${counts[s]} of ${total}`}
            className={cn('h-full', i > 0 && 'border-l-2 border-card')}
            style={{width: `${(counts[s] / Math.max(1, total)) * 100}%`, background: toneOf(s), opacity: NEEDS_ACTION.has(s) ? 1 : s === 'unknown' ? 0.3 : 0.45}}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-2.5 text-[11px] text-muted-foreground tabular-nums">
        {parts.map((s) => (
          <span key={s}>
            {counts[s]} {AUDIT_META[s].label.toLowerCase()}
          </span>
        ))}
      </div>
    </div>
  );
}
