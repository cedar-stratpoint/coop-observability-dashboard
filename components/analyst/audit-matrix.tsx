'use client';

import {useMemo, useState} from 'react';
import {useRouter} from 'next/navigation';
import Link from 'next/link';
import {ChevronRight, Search, X} from 'lucide-react';
import {Card, CardContent} from '@/components/ui/card';
import {cn} from '@/lib/utils';
import {NativeSelect} from '@/components/ui/native-select';
import {GL_PAGE, titleName} from '@/src/goldline-ui';
import {AUDIT_META, type AuditState} from '@/src/goldline-audit';
import type {AuditResult, AuditRow} from '@/src/goldline-audit-data';
import {defaultState, ink, LegKey, Mark, MatrixLegend, monthLabel, Pager, PoSourceBar, ReconTabs, StateChip, toneOf} from '@/components/analyst/audit-shared';

// Reconciliation · By store (NICH-17). One store and month: every product's three legs
// (Watsons · Inventory · PO), the state and what to do. The tiles are the only filter
// (Nov 24): one state at a time, opening on the most urgent; search looks across all.

const FIELD =
  'h-9 rounded-lg border border-border bg-card px-2.5 text-sm outline-none transition-colors duration-150 [@media(hover:hover)]:hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40';

// The store / month pickers: NativeSelect draws an inset chevron (the browser's own arrow sits
// flush against the right edge), sized to match FIELD.
const SELECT = 'h-9 rounded-lg bg-card pr-9 pl-3 duration-150';

export function AuditMatrix({data}: {data: AuditResult}) {
  const router = useRouter();
  // One filter, the tiles: exactly one state is always selected. The page opens on the most
  // urgent step. Search is the only other control, and it looks across every state.
  const [pick, setPick] = useState<AuditState>(() => defaultState(data.summary));
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const sel = data.selected;
  const needle = q.trim().toLowerCase();

  const rows = useMemo(() => {
    if (needle) return data.rows.filter((r) => r.item_code.toLowerCase().includes(needle) || (r.product ?? '').toLowerCase().includes(needle));
    return data.rows.filter((r) => r.state === pick);
  }, [data.rows, pick, needle]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const at = Math.min(page, pages - 1);

  const choose = (s: AuditState) => {
    setPick(s);
    setQ('');
    setPage(0);
  };
  const setParam = (key: 'store' | 'month', value: string) => {
    const sp = new URLSearchParams();
    sp.set('store', key === 'store' ? value : (sel?.code ?? ''));
    sp.set('month', key === 'month' ? value : (sel?.month ?? ''));
    // A store or month is a filter on this page, not a step: replace, so Back leaves Reconcile.
    router.replace(`/stock/audit?${sp.toString()}`, {scroll: false});
  };
  const query = sel ? `month=${sel.month}` : undefined;
  const m = AUDIT_META[pick];
  const c = toneOf(pick);

  return (
    <div className={GL_PAGE}>
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <p className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">Reconciliation</p>
            <h1 className="mt-1 font-heading text-2xl font-semibold tracking-tight">Watsons, inventory and PO, side by side</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              For one store and month, each product gets a yes or no on three legs and the step that follows. Pick a state to see its products.
            </p>
          </div>
          <ReconTabs query={query} />
        </div>
        <PoSourceBar po={data.po} />
      </header>

      {data.mock && (
        <div className="rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Sample view. Example rows for one store; connect the database to see real counts.
        </div>
      )}

      {!sel ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-1 px-6 py-14 text-center">
            <p className="font-heading text-sm font-semibold">No counts to reconcile yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">Commit an inventory form first. Its products are then checked against Watsons sales and the PO form here.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Store
              <NativeSelect wrapperClassName="min-w-[16rem]" className={SELECT} value={sel.code} onChange={(e) => setParam('store', e.target.value)}>
                {data.stores.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name ? `${s.code} · ${titleName(s.name)}` : s.code}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Month
              <NativeSelect className={SELECT} value={sel.month} onChange={(e) => setParam('month', e.target.value)}>
                {data.months.map((mo) => (
                  <option key={mo} value={mo}>
                    {monthLabel(mo)}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <div className="ml-auto text-right">
              <p className="font-heading text-3xl leading-none font-semibold tabular-nums">{data.summary.needsAction}</p>
              <p className="mt-1 text-xs text-muted-foreground">of {data.summary.total} products need a step</p>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <LegKey />
            <MatrixLegend summary={data.summary} active={needle ? null : pick} onPick={choose} unit="products" />
          </div>

          <Card className="gap-0 overflow-hidden py-0">
            {/* The table's header says what it shows: the selected state, who acts and the step,
                or the search across every state. No second filter here. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
              {needle ? (
                <p className="text-sm">
                  <span className="font-semibold tabular-nums">{rows.length}</span> {rows.length === 1 ? 'product matches' : 'products match'}{' '}
                  <span className="font-medium">“{q.trim()}”</span> <span className="text-muted-foreground">across every state</span>
                </p>
              ) : (
                <>
                  <StateChip state={pick} />
                  <span className="font-heading text-sm font-semibold tabular-nums">{rows.length}</span>
                  <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                    {m.owner !== 'None' && (
                      <span className="font-medium" style={{color: ink(c)}}>
                        {m.owner === 'Admin' ? 'You' : m.owner} ·{' '}
                      </span>
                    )}
                    {m.action}
                  </span>
                </>
              )}
              <div className="relative ml-auto">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <input
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setPage(0);
                  }}
                  placeholder="Search every product"
                  aria-label="Search every product at this store"
                  className={cn(FIELD, 'w-60 pl-8', q && 'pr-8')}
                />
                {q && (
                  <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 [@media(hover:hover)]:hover:bg-muted">
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            </div>

            {rows.length === 0 ? (
              <p className="px-4 py-12 text-center text-sm text-muted-foreground">
                {needle ? 'No product at this store matches that search.' : `No products are at “${m.label}” at this store.`}
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[40rem] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                        <th className="py-2 pr-3 pl-4 font-medium">Product</th>
                        {needle && <th className="px-2 py-2 font-medium">State</th>}
                        <th className="w-28 px-2 py-2 text-center font-medium">Watsons</th>
                        <th className="w-28 px-2 py-2 text-center font-medium">Inventory</th>
                        <th className="w-20 px-2 py-2 text-center font-medium">PO</th>
                        <th className="w-10 py-2 pr-3" aria-label="Open" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(at * PAGE, at * PAGE + PAGE).map((r) => (
                        <ProductRow key={r.item_code} r={r} store={sel.code} showState={Boolean(needle)} />
                      ))}
                    </tbody>
                  </table>
                </div>
                {pages > 1 && (
                  <div className="border-t border-border px-4 py-2.5">
                    <Pager page={at} pages={pages} total={rows.length} size={PAGE} onPage={setPage} label={needle ? 'Search results' : m.label} />
                  </div>
                )}
              </>
            )}
          </Card>
          <p className="text-xs text-muted-foreground">
            Inventory counts as yes only with stock on hand; a counted zero is a no. This page flags only. Retiring a product is a separate step and keeps its history.
          </p>
        </>
      )}
    </div>
  );
}

const PAGE = 12;

/** One product. The row opens its inventory page for this store; the name is the real link. */
function ProductRow({r, store, showState}: {r: AuditRow; store: string; showState: boolean}) {
  const router = useRouter();
  const href = `/stock/${encodeURIComponent(r.item_code)}?store=${encodeURIComponent(store)}`;
  return (
    <tr
      onClick={() => router.push(href)}
      className="group/row cursor-pointer border-b border-border/60 transition-colors duration-150 last:border-0 focus-within:bg-muted/40 [@media(hover:hover)]:hover:bg-muted/40"
    >
      <td className="py-2.5 pr-3 pl-4">
        <Link href={href} onClick={(e) => e.stopPropagation()} className="block max-w-[28rem] truncate font-medium outline-none focus-visible:underline">
          {r.shade ?? r.product ?? r.item_code}
        </Link>
        <span className="block max-w-[28rem] truncate text-[11px] text-muted-foreground">
          {r.shade && r.line ? `${r.line} · ` : ''}
          <span className="font-mono">{r.item_code}</span>
          {r.retired && ' · retired'}
        </span>
      </td>
      {showState && (
        <td className="px-2 py-2.5">
          <StateChip state={r.state} />
        </td>
      )}
      <td className="px-2 py-2.5">
        <Leg on={r.inWatsons} detail={r.inWatsons ? `${r.units} sold` : null} label="Watsons" />
      </td>
      <td className="px-2 py-2.5">
        <Leg on={r.inInventory} detail={r.onForm ? (r.onHand == null ? 'blank on form' : `${r.onHand} on hand`) : 'not on form'} label="Inventory" />
      </td>
      <td className="px-2 py-2.5">
        <Leg on={r.onPo} label="PO" />
      </td>
      <td className="py-2.5 pr-3 text-right">
        <ChevronRight
          aria-hidden
          className="ml-auto size-4 text-muted-foreground/40 transition-[transform,color] duration-150 ease-out group-hover/row:translate-x-0.5 group-hover/row:text-foreground group-focus-within/row:text-foreground"
        />
      </td>
    </tr>
  );
}

function Leg({on, detail, label}: {on: boolean; detail?: string | null; label: string}) {
  return (
    <span className="flex flex-col items-center gap-0.5">
      <Mark on={on} label={label} />
      {detail && <span className="text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">{detail}</span>}
    </span>
  );
}
