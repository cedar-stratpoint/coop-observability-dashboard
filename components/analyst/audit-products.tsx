'use client';

import {Fragment, useMemo, useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {ChevronRight, Search} from 'lucide-react';
import {Card, CardContent} from '@/components/ui/card';
import {cn} from '@/lib/utils';
import {GL_PAGE, titleName} from '@/src/goldline-ui';
import {AUDIT_META, AUDIT_STATES, NEEDS_ACTION, type AuditState} from '@/src/goldline-audit';
import type {ProductAuditResult, ProductAuditRow} from '@/src/goldline-audit-data';
import {ink, LegKey, MatrixLegend, monthLabel, PoSourceBar, ReconTabs, tint, toneOf} from '@/components/analyst/audit-shared';

// Reconciliation · By product (NICH-17). Every counted store in a month, rolled up per
// product: how many stores sit in each of the 8 states, as one stacked bar per product.
// Expand a product to see which stores, grouped by state, each linking to that store.

const FIELD =
  'h-9 rounded-lg border border-border bg-card px-2.5 text-sm outline-none transition-colors duration-150 [@media(hover:hover)]:hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40';

const PAGE = 60;

export function AuditProducts({data}: {data: ProductAuditResult}) {
  const router = useRouter();
  const [pick, setPick] = useState<AuditState | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = data.rows.filter(
      (r) => (!pick || r.counts[pick] > 0) && (!needle || r.item_code.toLowerCase().includes(needle) || r.product.toLowerCase().includes(needle)),
    );
    return pick ? [...out].sort((a, b) => b.counts[pick] - a.counts[pick] || a.item_code.localeCompare(b.item_code)) : out;
  }, [data.rows, pick, q]);

  return (
    <div className={GL_PAGE}>
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <p className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">Reconciliation</p>
            <h1 className="mt-1 font-heading text-2xl font-semibold tracking-tight">Every product, across every counted store</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Each bar splits a product&apos;s stores by state. Products that need a step at the most stores come first.
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
              <select className={FIELD} value={data.month} onChange={(e) => router.push(`/stock/audit/products?month=${e.target.value}`)}>
                {data.months.map((m) => (
                  <option key={m} value={m}>
                    {monthLabel(m)}
                  </option>
                ))}
              </select>
            </label>
            <div className="ml-auto flex gap-6 text-right">
              <div>
                <p className="font-heading text-3xl leading-none font-semibold tabular-nums">{data.storeCount}</p>
                <p className="mt-1 text-xs text-muted-foreground">stores counted</p>
              </div>
              <div>
                <p className="font-heading text-3xl leading-none font-semibold tabular-nums">{data.rows.filter((r) => r.needsAction > 0).length}</p>
                <p className="mt-1 text-xs text-muted-foreground">products need a step somewhere</p>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <LegKey />
            <MatrixLegend summary={data.summary} active={pick} onPick={setPick} unit="store and product pairs" />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a product or code" aria-label="Find a product" className={cn(FIELD, 'w-64 pl-8')} />
            </div>
            {pick && (
              <button type="button" onClick={() => setPick(null)} className="text-sm font-medium text-primary underline-offset-4 [@media(hover:hover)]:hover:underline">
                Products with {AUDIT_META[pick].label} · Clear
              </button>
            )}
          </div>

          <Card className="gap-0 overflow-hidden py-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[48rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    <th className="w-8 py-2.5 pl-3" aria-label="Expand" />
                    <th className="py-2.5 pr-3 font-medium">Product</th>
                    <th className="px-2 py-2.5 font-medium">PO</th>
                    <th className="w-[38%] px-2 py-2.5 font-medium">Stores by state</th>
                    <th className="py-2.5 pr-4 pl-2 text-right font-medium">Need a step</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-12 text-center text-sm text-muted-foreground">
                        {q ? 'No product matches that search.' : 'No products in this state.'}
                      </td>
                    </tr>
                  ) : (
                    rows.slice(0, limit).map((r) => (
                      <ProductRow key={r.item_code} r={r} open={open === r.item_code} onToggle={() => setOpen(open === r.item_code ? null : r.item_code)} month={data.month!} />
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {rows.length > limit && (
              <button type="button" onClick={() => setLimit(limit + PAGE)} className="w-full border-t border-border py-2.5 text-sm font-medium text-primary transition-colors duration-150 [@media(hover:hover)]:hover:bg-muted/40">
                Show {Math.min(PAGE, rows.length - limit)} more of {rows.length - limit}
              </button>
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
            style={r.onPo ? {color: ink('var(--status-good)'), background: tint('var(--status-good)')} : undefined}
          >
            {r.onPo ? 'Active' : <span className="text-muted-foreground">Inactive</span>}
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
              {AUDIT_STATES.filter((s) => r.counts[s] > 0).map((s) => (
                <div key={s} className="flex flex-col gap-1.5 sm:flex-row sm:gap-3">
                  <span className="flex w-40 shrink-0 items-center gap-1.5 text-xs font-medium" style={{color: ink(toneOf(s))}}>
                    <span aria-hidden className="size-1.5 rounded-full" style={{background: toneOf(s)}} />
                    {AUDIT_META[s].label} · {r.counts[s]}
                  </span>
                  <span className="flex flex-wrap gap-1.5">
                    {r.storeList
                      .filter((x) => x.state === s)
                      .map((x) => (
                        <Link
                          key={x.code}
                          href={`/stock/audit?store=${encodeURIComponent(x.code)}&month=${month}`}
                          className="rounded-md border border-border bg-card px-2 py-0.5 text-xs transition-colors duration-150 [@media(hover:hover)]:hover:border-foreground/25"
                        >
                          <span className="font-mono text-muted-foreground">{x.code}</span> {x.name ? titleName(x.name) : ''}
                        </Link>
                      ))}
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
            style={{width: `${(counts[s] / Math.max(1, total)) * 100}%`, background: toneOf(s), opacity: NEEDS_ACTION.has(s) ? 1 : 0.45}}
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
