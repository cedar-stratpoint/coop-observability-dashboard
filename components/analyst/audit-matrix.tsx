'use client';

import {useEffect, useMemo, useRef, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import Link from 'next/link';
import {ArrowDown, ArrowUp, ChevronRight, ChevronsUpDown, Download, Search, X} from 'lucide-react';
import {Card, CardContent} from '@/components/ui/card';
import {cn} from '@/lib/utils';
import {MonthPicker, StorePicker} from '@/components/analyst/audit-pickers';
import {GL_PAGE, titleName} from '@/src/goldline-ui';
import {ALL_PAGE, ALL_STORES, AUDIT_META, auditRows, parsePattern, patternState, recoAction, WHY_LABEL, type AuditQuery, type AuditSort, type AuditState, type Leg} from '@/src/goldline-audit';
import type {AuditResult, AuditRow} from '@/src/goldline-audit-data';
import {CoverageNote, ink, Mark, monthLabel, NoSalesNotice, NotebookGrid, Pager, PoSourceBar, ReconTabs, StateChip, toneOf, UnknownReasons} from '@/components/analyst/audit-shared';

// Reconciliation · By store (NICH-17). One store (or every store) and month: every product's
// three legs (Watsons · Inventory · PO) and its recommendation on the line. The tiles are the
// only filter (Nov 24): one state at a time, opening on the most urgent; search looks across
// all, and a pattern like YYX opens its tile. One store is filtered in the browser; every
// store is filtered, sorted and paged on the server. The URL carries it all, so a view can be
// shared.

const FIELD =
  'h-9 rounded-lg border border-border bg-card px-2.5 text-sm outline-none transition-colors duration-150 [@media(hover:hover)]:hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40';


const STORE_PAGE = 12;

/** The query as URL params, leaving out whatever is already the default. */
function toParams(store: string, month: string, query: AuditQuery): URLSearchParams {
  const sp = new URLSearchParams({store, month, state: query.state});
  if (query.state === 'unknown' && query.why) sp.set('why', query.why);
  if (query.q.trim()) sp.set('q', query.q.trim());
  if (query.sort !== 'reco') sp.set('sort', query.sort);
  if (query.dir !== 'asc') sp.set('dir', query.dir);
  if (query.page > 0) sp.set('page', String(query.page));
  return sp;
}

export function AuditMatrix({data}: {data: AuditResult}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [query, setQuery] = useState<AuditQuery>(data.query);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const sel = data.selected;
  const all = sel?.code === ALL_STORES;

  const go = (next: Partial<AuditQuery>, wait = 0) => {
    if (!sel) return;
    const q = {...query, page: 0, ...next};
    setQuery(q);
    const url = `/stock/audit?${toParams(sel.code, sel.month, q)}`;
    if (timer.current) clearTimeout(timer.current);
    // One store: the rows are here, so only the address changes. Every store: ask the server.
    if (!all) window.history.replaceState(null, '', url);
    else timer.current = setTimeout(() => start(() => router.replace(url, {scroll: false})), wait);
  };

  // A full pattern (YYX) is a tile, so it reads as that tile being picked.
  const typed = query.q.trim();
  const asState = typed ? patternState(typed) : null;
  const state: AuditState = asState ?? query.state;
  const searching = Boolean(typed) && !asState;
  const pattern = searching ? parsePattern(typed) : null;

  const hits = useMemo(() => (all ? data.rows : auditRows(data.rows, query)), [all, data.rows, query]);
  const size = all ? ALL_PAGE : STORE_PAGE;
  const total = all ? data.total : hits.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const at = Math.min(all ? data.query.page : query.page, pages - 1);
  const shown = all ? hits : hits.slice(at * size, at * size + size);

  const setParam = (key: 'store' | 'month', value: string) => {
    const sp = new URLSearchParams({store: sel?.code ?? '', month: sel?.month ?? ''});
    sp.set(key, value);
    // Widening to every store keeps what you were looking at; anything else opens on its own
    // most urgent state. A filter, not a step: replace, so Back leaves Reconcile.
    if (key === 'store' && value === ALL_STORES) {
      sp.set('state', state);
      if (searching) sp.set('q', typed);
    }
    router.replace(`/stock/audit?${sp}`, {scroll: false});
  };
  const sortBy = (sort: AuditSort) => {
    // Numbers read best biggest first; text reads best A to Z.
    const first = sort === 'units' || sort === 'onHand' ? 'desc' : 'asc';
    go({sort, dir: query.sort === sort ? (query.dir === 'asc' ? 'desc' : 'asc') : first});
  };

  const otherMonth = data.months.find((mo) => mo.loaded && mo.month !== sel?.month)?.month ?? null;
  const m = AUDIT_META[state];
  const c = toneOf(state);
  const where = all ? 'any store' : 'this store';

  return (
    <div className={GL_PAGE}>
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <p className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">Reconciliation</p>
            <h1 className="mt-1 font-heading text-2xl font-semibold tracking-tight">Watsons, inventory and PO, side by side</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Each product gets a yes or no on three legs and one recommendation. A mark with no data behind it shows as not known, never as a no.
            </p>
          </div>
          <ReconTabs query={sel ? `month=${sel.month}` : undefined} />
        </div>
        <PoSourceBar po={data.po} />
      </header>

      {data.mock && (
        <div className="rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Sample view. Example rows; connect the database to see real counts.
        </div>
      )}

      {!sel ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-1 px-6 py-14 text-center">
            <p className="font-heading text-sm font-semibold">Nothing to reconcile yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">Load a month of Watsons sales or commit an inventory form. Products are then checked against the PO form here.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
              Store
              <StorePicker stores={data.stores} value={sel.code} onChange={(code) => setParam('store', code)} />
            </div>
            <div className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
              Month
              <MonthPicker months={data.months} value={sel.month} onChange={(month) => setParam('month', month)} />
            </div>
            <div className="ml-auto text-right">
              <p className="font-heading text-3xl leading-none font-semibold tabular-nums">{data.summary.needsAction.toLocaleString('en-US')}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                of {data.summary.total.toLocaleString('en-US')} {all ? 'store and product pairs' : 'products'} need a step
              </p>
            </div>
          </div>

          <CoverageNote month={sel.month} coverage={data.coverage} all={all} />

          {/* A month without sales can't be judged: one notice instead of a grid of zeros. */}
          {!data.coverage.loaded ? (
            <NoSalesNotice
              month={sel.month}
              total={data.summary.total}
              unit={all ? 'store and product pairs' : 'products'}
              otherMonth={otherMonth}
              otherHref={otherMonth ? `/stock/audit?${new URLSearchParams({store: sel.code, month: otherMonth})}` : null}
            />
          ) : (
            <NotebookGrid summary={data.summary} active={searching ? null : state} onPick={(s) => go({state: s, why: null, q: ''})} unit={all ? 'store and product pairs' : 'products'} />
          )}
          <UnknownReasons summary={data.summary} active={!searching && state === 'unknown'} activeWhy={query.why} onPick={(why) => go({state: 'unknown', why, q: ''})} />

          <Card className="gap-0 overflow-hidden py-0">
            {/* The table's header says what it shows. No second filter here. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
              {searching ? (
                <p className="text-sm">
                  <span className="font-semibold tabular-nums">{total.toLocaleString('en-US')}</span> {total === 1 ? 'line matches' : 'lines match'} <span className="font-medium">“{typed}”</span>{' '}
                  <span className="text-muted-foreground">{pattern ? 'as a Watsons · Inventory · PO pattern' : 'across every recommendation'}</span>
                </p>
              ) : (
                <>
                  <StateChip state={state} />
                  <span className="font-heading text-sm font-semibold tabular-nums">{total.toLocaleString('en-US')}</span>
                  <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                    {m.owner !== 'None' && (
                      <span className="font-medium" style={{color: ink(c)}}>
                        {m.owner === 'Admin' ? 'You' : m.owner} ·{' '}
                      </span>
                    )}
                    {state === 'unknown' && query.why ? `Only lines missing: ${WHY_LABEL[query.why].toLowerCase()}. ` : ''}
                    {m.action}
                  </span>
                </>
              )}
              <div className="ml-auto flex items-center gap-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <input
                    value={query.q}
                    maxLength={80}
                    onChange={(e) => go({q: e.target.value}, 350)}
                    placeholder={all ? 'Product, store or YYX' : 'Product or YYX'}
                    aria-label="Search products, or type a pattern like YYX"
                    className={cn(FIELD, 'w-56 pl-8', query.q && 'pr-8')}
                  />
                  {query.q && (
                    <button
                      type="button"
                      onClick={() => go({q: ''})}
                      aria-label="Clear search"
                      className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 [@media(hover:hover)]:hover:bg-muted"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
                {!data.mock && total > 0 && (
                  <a
                    href={`/api/goldline/audit-export?${toParams(sel.code, sel.month, {...query, page: 0})}`}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-medium transition-[transform,border-color] duration-150 ease-out active:scale-[0.97] [@media(hover:hover)]:hover:border-foreground/25"
                  >
                    <Download className="size-4" aria-hidden /> CSV
                  </a>
                )}
              </div>
            </div>

            <div aria-busy={pending} className={cn('transition-opacity duration-150', pending && 'opacity-50')}>
              {shown.length === 0 ? (
                <p className="px-4 py-12 text-center text-sm text-muted-foreground">
                  {searching ? `Nothing at ${where} matches that search.` : `Nothing is at “${m.label}” at ${where}${state !== 'unknown' && data.summary.unknown > 0 ? ` yet. ${data.summary.unknown.toLocaleString('en-US')} ${data.summary.unknown === 1 ? 'line is' : 'lines are'} still missing data, so this can change.` : '.'}`}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[56rem] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                        <SortHead sort="product" label="Product" query={query} onSort={sortBy} className="pl-4" />
                        {all && <SortHead sort="store" label="Store" query={query} onSort={sortBy} />}
                        <SortHead sort="reco" label="Recommendation" query={query} onSort={sortBy} />
                        <SortHead sort="units" label="Watsons" query={query} onSort={sortBy} center className="w-28" />
                        <SortHead sort="onHand" label="Inventory" query={query} onSort={sortBy} center className="w-32" />
                        <th className="w-16 px-2 py-2 text-center font-medium">PO</th>
                        <th className="w-10 py-2 pr-3" aria-label="Open" />
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r) => (
                        <ProductRow key={`${r.store}|${r.item_code}`} r={r} showStore={all} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {pages > 1 && (
                <div className="border-t border-border px-4 py-2.5">
                  <Pager page={at} pages={pages} total={total} size={size} onPage={(page) => go({page})} label={searching ? 'Search results' : m.label} />
                </div>
              )}
            </div>
          </Card>
          <p className="text-xs text-muted-foreground">
            Inventory is a yes with stock counted and a no at a counted zero or when the store&apos;s form doesn&apos;t list the product. A blank is not known. This page recommends only: nothing is retired or changed here.
          </p>
        </>
      )}
    </div>
  );
}

function SortHead({sort, label, query, onSort, center, className}: {sort: AuditSort; label: string; query: AuditQuery; onSort: (s: AuditSort) => void; center?: boolean; className?: string}) {
  const on = query.sort === sort;
  const Icon = !on ? ChevronsUpDown : query.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th className={cn('px-2 py-1.5 font-medium', center && 'text-center', className)} aria-sort={on ? (query.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(sort)}
        className={cn(
          'inline-flex h-7 items-center gap-1 rounded-md uppercase transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none [@media(hover:hover)]:hover:text-foreground',
          on && 'text-foreground',
        )}
      >
        {label}
        <Icon className={cn('size-3', !on && 'opacity-50')} aria-hidden />
      </button>
    </th>
  );
}

/** One line. The row opens the product's page for its store; the name is the real link. */
function ProductRow({r, showStore}: {r: AuditRow; showStore: boolean}) {
  const router = useRouter();
  const href = `/stock/${encodeURIComponent(r.item_code)}?store=${encodeURIComponent(r.store)}`;
  return (
    <tr
      onClick={() => router.push(href)}
      className="group/row cursor-pointer border-b border-border/60 align-top transition-colors duration-150 last:border-0 focus-within:bg-muted/40 [@media(hover:hover)]:hover:bg-muted/40"
    >
      <td className="py-2.5 pr-3 pl-4">
        <Link href={href} onClick={(e) => e.stopPropagation()} className="block max-w-[22rem] truncate font-medium outline-none focus-visible:underline">
          {r.shade ?? r.product ?? r.item_code}
        </Link>
        <span className="block max-w-[22rem] truncate text-[11px] text-muted-foreground">
          {r.shade && r.line ? `${r.line} · ` : ''}
          <span className="font-mono">{r.item_code}</span>
          {r.retired && ' · retired'}
        </span>
      </td>
      {showStore && (
        <td className="px-2 py-2.5">
          <span className="block max-w-[14rem] truncate">{r.storeName ? titleName(r.storeName) : r.store}</span>
          {r.storeName && <span className="font-mono text-[11px] text-muted-foreground">{r.store}</span>}
        </td>
      )}
      <td className="px-2 py-2.5">
        <span className="flex flex-col items-start gap-1">
          <span title={recoAction(r)}>
            <StateChip state={r.state} label={r.reco} />
          </span>
          {r.state === 'unknown' && (
            <span className="max-w-[17rem] text-[11px] leading-snug text-muted-foreground">
              {r.why.map((w) => WHY_LABEL[w]).join(' · ')}
              {r.between.length === 2 && <span className="block">Either {r.between[0]} or {r.between[1]}</span>}
            </span>
          )}
        </span>
      </td>
      <td className="px-2 py-2.5">
        <LegCell leg={r.watsons} detail={r.units == null ? null : `${r.units} sold`} label="Watsons" />
      </td>
      <td className="px-2 py-2.5">
        <LegCell leg={r.inventory} detail={r.onHand != null ? `${r.onHand} on hand` : r.inventory === 'no' ? 'not on form' : r.why.includes('blank') ? 'blank' : null} label="Inventory" />
      </td>
      <td className="px-2 py-2.5">
        <LegCell leg={r.po} label="PO" />
      </td>
      <td className="py-3 pr-3 text-right">
        <ChevronRight
          aria-hidden
          className="ml-auto size-4 text-muted-foreground/40 transition-[transform,color] duration-150 ease-out group-hover/row:translate-x-0.5 group-hover/row:text-foreground group-focus-within/row:text-foreground"
        />
      </td>
    </tr>
  );
}

function LegCell({leg, detail, label}: {leg: Leg; detail?: string | null; label: string}) {
  return (
    <span className="flex flex-col items-center gap-0.5">
      <Mark leg={leg} label={label} />
      {detail && <span className="text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">{detail}</span>}
    </span>
  );
}
