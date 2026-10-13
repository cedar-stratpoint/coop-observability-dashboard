'use client';

// The merged "All products" table: catalog + stock + sell-through in one, with
// sortable columns (default Category order), Line/Status/search filters, an
// editable Price, and a per-row ⋯ menu carrying the catalog edits (rename,
// reprice, list/unlist) via the existing server actions. Read-first by design;
// editing opens a small popover so the wide table stays scannable.

import {useMemo, useState, useTransition, useEffect, useLayoutEffect, useRef} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {createPortal} from 'react-dom';
import {ArrowLeftRight, Eye, EyeOff, MoreHorizontal, Pencil, Search, Tag, Type, Undo2, X, type LucideIcon} from 'lucide-react';
import {cn} from '@/lib/utils';
import {Card, CardContent} from '@/components/ui/card';
import {POS_CATEGORIES, POS_SUBCATEGORIES, SUBCATEGORY_CATEGORY, formatPeso} from '@/src/pos-format';
import {compareByCategory, filterInventoryRows} from '@/src/pos-inventory-compute';
import {renameProductAction, repriceProductAction, setListingAction, setStockAction} from '@/src/pos-actions';
import {voidLastAddAction} from '@/src/pos-stock-intake-actions';
import {TransferModal} from './transfer-stock-button';
import {Pagination} from './pagination';
import type {InventoryRow} from '@/src/pos-inventory-data';
import type {ForecastStatus} from '@/src/pos-forecast-compute';
import {STATUS} from '@/src/inventory-status';

type SortKey = 'category' | 'name' | 'status' | 'price' | 'thisMonth' | 'lastMonth' | 'threeMo' | 'stock' | 'office' | 'cover' | 'reorder';

const PAGE_SIZE = 12; // rows per page on the merged product table

const STATUS_RANK: Record<ForecastStatus, number> = {out: 0, low: 1, healthy: 2};
const fmt1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString();

export function InventoryTable({rows: initialRows, usingMock}: {rows: InventoryRow[]; usingMock: boolean}) {
  const [rows, setRows] = useState(initialRows);
  useEffect(() => setRows(initialRows), [initialRows]);

  const [line, setLine] = useState('');
  const [sub, setSub] = useState('');
  const [status, setStatus] = useState<'' | ForecastStatus | 'unlisted'>('');
  const [loc, setLoc] = useState<'' | 'office' | 'event'>('');
  // Switch: include products tagged Out (status 'out'). On = today's behavior.
  const [showOut, setShowOut] = useState(true);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{key: SortKey; dir: 1 | -1}>({key: 'category', dir: 1});
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // Separate menu state for the mobile card list. The card RowMenu portals to
  // <body>, so sharing menuFor with the table would let the display:none side
  // render a stray menu at (0,0) on the visible side. Keeping them independent
  // means the hidden breakpoint's menu never opens (its buttons aren't clickable).
  const [cardMenuFor, setCardMenuFor] = useState<string | null>(null);
  const [editing, setEditing] = useState<{row: InventoryRow; field: 'name' | 'price'} | null>(null);
  const [moveStockRow, setMoveStockRow] = useState<InventoryRow | null>(null);
  const [editStockRow, setEditStockRow] = useState<InventoryRow | null>(null);
  const [page, setPage] = useState(1);

  const outCount = useMemo(() => rows.filter((r) => r.status === 'out').length, [rows]);

  const filtered = useMemo(
    () => filterInventoryRows(rows, {line, sub, status, loc, showOut, search}),
    [rows, line, sub, status, loc, search, showOut],
  );

  const sorted = useMemo(() => {
    const arr = [...filtered];
    if (sort.key === 'category') return arr.sort(compareByCategory);
    const val = (r: InventoryRow): number | string => {
      switch (sort.key) {
        case 'name': return r.name.toLowerCase();
        case 'status': return STATUS_RANK[r.status];
        case 'price': return r.price ?? -1;
        case 'thisMonth': return r.monthly.thisMonth;
        case 'lastMonth': return r.monthly.lastMonth;
        case 'threeMo': return r.monthly.threeMonthTotal;
        case 'stock': return r.stock;
        case 'office': return r.office;
        case 'cover': return r.coverEventDays ?? Number.POSITIVE_INFINITY;
        case 'reorder': return r.reorderQty ?? -1;
        default: return 0;
      }
    };
    return arr.sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av < bv) return -1 * sort.dir;
      if (av > bv) return 1 * sort.dir;
      return a.name.localeCompare(b.name);
    });
  }, [filtered, sort]);

  // Paginate the filtered+sorted rows client-side. Snap back to page 1 whenever the
  // result set changes (filter/search/sort), and clamp so a shrunk set never leaves
  // us stranded past the last page.
  useEffect(() => setPage(1), [line, sub, status, loc, search, showOut, sort]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const from = (safePage - 1) * PAGE_SIZE;
  const paged = sorted.slice(from, from + PAGE_SIZE);

  // Numeric/severity columns default high-to-low (dir -1); name/category low-to-high.
  function toggleSort(key: SortKey) {
    setSort((s) => {
      if (s.key !== key) return {key, dir: key === 'name' || key === 'category' ? 1 : -1};
      return {key, dir: (s.dir * -1) as 1 | -1};
    });
  }
  const caret = (key: SortKey) => (sort.key !== key ? '↕' : sort.dir === 1 ? '↑' : '↓');

  return (
    <div>
      {/* Filters: Line, then (Freeze-Dried only) Type, Status and Location as pill rows,
          then search. All inline; there is no separate Filters modal. */}
      <div className="mb-4 flex flex-col gap-2.5">
        <PillRow label="Line" items={[{v: '', l: 'All'}, ...POS_CATEGORIES.map((c) => ({v: c as string, l: c}))]} active={line}
          onSelect={(v) => {setLine(v); if (v !== SUBCATEGORY_CATEGORY) setSub('');}} />
        {line === SUBCATEGORY_CATEGORY && (
          <PillRow label="Type" items={[{v: '', l: 'All'}, ...POS_SUBCATEGORIES.map((c) => ({v: c as string, l: c}))]} active={sub} onSelect={setSub} />
        )}
        <PillRow label="Status" items={[{v: '', l: 'All'}, {v: 'out', l: 'Out'}, {v: 'low', l: 'Low'}, {v: 'healthy', l: 'Healthy'}, {v: 'unlisted', l: 'Unlisted'}]} active={status} onSelect={(v) => {setStatus(v as '' | ForecastStatus | 'unlisted'); if (v === 'out') setShowOut(true);}} />
        <PillRow label="Location" items={[{v: '', l: 'All'}, {v: 'event', l: 'In Event'}, {v: 'office', l: 'In Office'}]} active={loc} onSelect={(v) => setLoc(v as '' | 'office' | 'event')} />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or SKU…"
              aria-label="Search products"
              className="w-full rounded-md border bg-background py-2 pl-9 pr-8 text-sm outline-none transition-colors focus-visible:border-ring"
            />
            {search && (
              <button type="button" onClick={() => setSearch('')} aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground">
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <button type="button" role="switch" aria-checked={showOut}
            onClick={() => {const next = !showOut; setShowOut(next); if (!next && status === 'out') setStatus('');}}
            className="group inline-flex shrink-0 items-center gap-2 rounded-md py-1 text-sm font-medium transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <span aria-hidden className={cn('relative h-5 w-9 rounded-full transition-colors duration-150', showOut ? 'bg-primary' : 'bg-muted-foreground/30')}>
              <span className={cn('absolute left-0.5 top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none', showOut && 'translate-x-4')} />
            </span>
            <span className={showOut ? 'text-foreground' : 'text-muted-foreground'}>Show out of stock</span>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{outCount}</span>
          </button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {sorted.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No products match this filter.</p>
          ) : (
            <>
            <div className="overflow-x-auto max-md:hidden">
              <table className="w-full min-w-[860px] text-sm">
                <thead>
                  <tr className="border-b text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <Th onClick={() => toggleSort('name')} active={sort.key === 'name' || sort.key === 'category'}>Product <Sc>{sort.key === 'category' ? '▲cat' : caret('name')}</Sc></Th>
                    <Th onClick={() => toggleSort('status')} active={sort.key === 'status'}>Status <Sc>{caret('status')}</Sc></Th>
                    <Th className="text-right" onClick={() => toggleSort('price')} active={sort.key === 'price'}>Price <Sc>{caret('price')}</Sc></Th>
                    <Th className="text-right" onClick={() => toggleSort('office')} active={sort.key === 'office'}>Office <Sc>{caret('office')}</Sc></Th>
                    <Th className="text-right" onClick={() => toggleSort('stock')} active={sort.key === 'stock'}>Event <Sc>{caret('stock')}</Sc></Th>
                    <th className="px-3 py-3 text-left">Trend</th>
                    <Th className="text-right" onClick={() => toggleSort('thisMonth')} active={sort.key === 'thisMonth'}>This mo <Sc>{caret('thisMonth')}</Sc></Th>
                    <Th className="text-right" onClick={() => toggleSort('lastMonth')} active={sort.key === 'lastMonth'}>Last mo <Sc>{caret('lastMonth')}</Sc></Th>
                    <Th className="text-right" onClick={() => toggleSort('threeMo')} active={sort.key === 'threeMo'}>3mo <Sc>{caret('threeMo')}</Sc></Th>
                    <Th onClick={() => toggleSort('cover')} active={sort.key === 'cover'}>Lasts <Sc>{caret('cover')}</Sc></Th>
                    <Th className="text-right" onClick={() => toggleSort('reorder')} active={sort.key === 'reorder'}>Suggested <Sc>{caret('reorder')}</Sc></Th>
                    <th className="sticky right-0 bg-card px-2 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {paged.map((r) => (
                    <Row key={r.product_id} r={r} menuOpen={menuFor === r.product_id}
                      onMenu={() => setMenuFor((m) => (m === r.product_id ? null : r.product_id))}
                      onClose={() => setMenuFor(null)}
                      onEdit={(field) => {setMenuFor(null); setEditing({row: r, field});}}
                      onMoveStock={() => {setMenuFor(null); setMoveStockRow(r);}}
                      onEditStock={() => {setMenuFor(null); setEditStockRow(r);}} />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile (below md): the same paged rows as cards. Own menu state
                (cardMenuFor) so the hidden desktop table never spawns a stray
                RowMenu portal, and shares the parent edit/stock dialogs. */}
            <ul className="divide-y divide-border md:hidden">
              {paged.map((r) => (
                <RowCard key={r.product_id} r={r} menuOpen={cardMenuFor === r.product_id}
                  onMenu={() => setCardMenuFor((m) => (m === r.product_id ? null : r.product_id))}
                  onClose={() => setCardMenuFor(null)}
                  onEdit={(field) => {setCardMenuFor(null); setEditing({row: r, field});}}
                  onMoveStock={() => {setCardMenuFor(null); setMoveStockRow(r);}}
                  onEditStock={() => {setCardMenuFor(null); setEditStockRow(r);}} />
              ))}
            </ul>
            </>
          )}
        </CardContent>
      </Card>

      {sorted.length > 0 && (
        <div className="mt-4 flex flex-col-reverse items-center justify-between gap-3 sm:flex-row">
          <p className="text-xs text-muted-foreground tabular-nums">
            Showing {from + 1}–{Math.min(from + PAGE_SIZE, sorted.length)} of {sorted.length}
          </p>
          <Pagination page={safePage} pageCount={pageCount} onPage={setPage} label="Products pagination" />
        </div>
      )}

      {editing && (
        <EditDialog row={editing.row} field={editing.field} usingMock={usingMock}
          onClose={() => setEditing(null)}
          onSaved={(patch) => {setRows((rs) => rs.map((r) => (r.product_id === editing.row.product_id ? {...r, ...patch} : r))); setEditing(null);}} />
      )}
      {moveStockRow && (
        <TransferModal
          products={rows.map((r) => ({product_id: r.product_id, name: r.name, office: r.office, event: r.event}))}
          initialSku={moveStockRow.product_id}
          onClose={() => setMoveStockRow(null)}
        />
      )}
      {editStockRow && (
        <EditStockDialog row={editStockRow} usingMock={usingMock}
          onClose={() => setEditStockRow(null)}
          onDone={(newQty, loc) => {setRows((rs) => rs.map((r) => (r.product_id === editStockRow.product_id ? (loc === 'office' ? {...r, office: newQty} : {...r, stock: newQty, event: newQty}) : r))); setEditStockRow(null);}} />
      )}
    </div>
  );
}

function Row({r, menuOpen, onMenu, onClose, onEdit, onMoveStock, onEditStock}: {
  r: InventoryRow; menuOpen: boolean; onMenu: () => void; onClose: () => void; onEdit: (f: 'name' | 'price') => void; onMoveStock: () => void; onEditStock: () => void;
}) {
  const s = STATUS[r.status];
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  // Right-clicking anywhere on the row opens the same menu at the cursor, so
  // editing stock doesn't need a scroll to the ⋯ column. null = anchored to the ⋯.
  const [ctxPoint, setCtxPoint] = useState<MenuPoint | null>(null);
  function toggleListing() {
    startTransition(async () => {
      await setListingAction(r.product_id, !r.active);
      onClose();
      router.refresh();
    });
  }
  function undoLastAdd() {
    startTransition(async () => {
      await voidLastAddAction(r.product_id);
      onClose();
      router.refresh();
    });
  }
  const max = Math.max(1, ...r.monthly.trend);
  // The whole row navigates to the product detail; inner controls (name link, price
  // edit, the ⋯ menu) stopPropagation so they keep their own behavior.
  return (
    <tr onClick={() => router.push(`/inventory/${r.product_id}`)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setCtxPoint({x: e.clientX, y: e.clientY});
        if (!menuOpen) onMenu();
      }}
      className={cn('group cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/50', !r.active && 'opacity-55')}>
      <td className="px-3 py-3">
        <Link href={`/inventory/${r.product_id}`} onClick={(e) => e.stopPropagation()} className="font-medium transition-colors hover:text-primary">{r.name}</Link>
        <div className="font-mono text-[10px] text-muted-foreground">{r.product_id}{!r.active && ' · unlisted'}</div>
      </td>
      <td className="px-3 py-3">
        <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', s.bg, s.text)}>
          <span className={cn('size-1.5 rounded-full', s.dot)} />{s.label}
        </span>
      </td>
      <td className="px-3 py-3 text-right">
        <button onClick={(e) => {e.stopPropagation(); onEdit('price');}} className="inline-flex items-center gap-1.5 tabular-nums transition-colors hover:text-primary" title="Change price">
          {formatPeso(r.price)} <Pencil className="size-3 text-muted-foreground" />
        </button>
      </td>
      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{r.office}</td>
      <td className="px-3 py-3 text-right tabular-nums font-medium">{r.event}</td>
      <td className="px-3 py-3">
        <span className="inline-flex h-5 items-end gap-[3px]">
          {r.monthly.trend.map((v, i) => (
            <span key={i} className={cn('w-[5px] rounded-sm', r.monthly.threeMonthTotal > 0 ? 'bg-emerald-500' : 'bg-muted')}
              style={{height: `${Math.max(12, (v / max) * 100)}%`}} />
          ))}
        </span>
      </td>
      <td className="px-3 py-3 text-right tabular-nums">
        <span>{r.monthly.thisMonth}</span>
        <YoyDelta yoy={r.yoy} thisMonth={r.monthly.thisMonth} />
      </td>
      <td className="px-3 py-3 text-right tabular-nums text-muted-foreground">{r.monthly.lastMonth}</td>
      <td className="px-3 py-3 text-right tabular-nums">{r.monthly.threeMonthTotal}</td>
      <td className="whitespace-nowrap px-3 py-3">
        <LastsBadge row={r} />
      </td>
      <td className="px-3 py-3 text-right tabular-nums">{r.reorderQty != null ? r.reorderQty : <span className="text-muted-foreground">—</span>}</td>
      <td className="sticky right-0 bg-card px-2 py-3 text-right transition-colors group-hover:bg-muted">
        <button ref={menuBtnRef} onClick={(e) => {e.stopPropagation(); setCtxPoint(null); onMenu();}} aria-label="Row actions" className="rounded p-1 text-muted-foreground hover:text-foreground"><MoreHorizontal className="size-4" /></button>
        {menuOpen && (
          <RowMenu anchor={ctxPoint ?? menuBtnRef.current} sku={r.product_id} active={r.active} pending={pending}
            onRename={() => onEdit('name')} onReprice={() => onEdit('price')} onToggleListing={toggleListing}
            onMoveStock={onMoveStock} onEditStock={onEditStock} onUndo={undoLastAdd} onClose={onClose} />
        )}
      </td>
    </tr>
  );
}

// Mobile (below md) card mirror of Row. Same handlers and shared parent dialogs;
// its own menu open/close is driven by cardMenuFor so it never collides with the
// desktop table's portal. The name link navigates (no whole-card click, so the
// price/menu taps don't need stopPropagation).
function RowCard({r, menuOpen, onMenu, onClose, onEdit, onMoveStock, onEditStock}: {
  r: InventoryRow; menuOpen: boolean; onMenu: () => void; onClose: () => void; onEdit: (f: 'name' | 'price') => void; onMoveStock: () => void; onEditStock: () => void;
}) {
  const s = STATUS[r.status];
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  function toggleListing() {
    startTransition(async () => {
      await setListingAction(r.product_id, !r.active);
      onClose();
      router.refresh();
    });
  }
  function undoLastAdd() {
    startTransition(async () => {
      await voidLastAddAction(r.product_id);
      onClose();
      router.refresh();
    });
  }
  return (
    <li className={cn('p-4', !r.active && 'opacity-55')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/inventory/${r.product_id}`} className="font-medium transition-colors hover:text-primary">{r.name}</Link>
          <div className="font-mono text-[10px] text-muted-foreground">{r.product_id}{!r.active && ' · unlisted'}</div>
        </div>
        <div className="relative shrink-0">
          <button ref={menuBtnRef} onClick={onMenu} aria-label="Row actions" className="rounded p-1.5 text-muted-foreground hover:text-foreground"><MoreHorizontal className="size-5" /></button>
          {menuOpen && (
            <RowMenu anchor={menuBtnRef.current} sku={r.product_id} active={r.active} pending={pending}
              onRename={() => onEdit('name')} onReprice={() => onEdit('price')} onToggleListing={toggleListing}
              onMoveStock={onMoveStock} onEditStock={onEditStock} onUndo={undoLastAdd} onClose={onClose} />
          )}
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', s.bg, s.text)}>
          <span className={cn('size-1.5 rounded-full', s.dot)} />{s.label}
        </span>
        <button onClick={() => onEdit('price')} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs tabular-nums transition-colors hover:text-primary" title="Change price">
          {formatPeso(r.price)} <Pencil className="size-3 text-muted-foreground" />
        </button>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2.5 text-xs">
        <div>
          <dt className="text-muted-foreground">Office</dt>
          <dd className="mt-0.5 tabular-nums text-muted-foreground">{r.office}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Event</dt>
          <dd className="mt-0.5 font-medium tabular-nums">{r.event}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">This mo</dt>
          <dd className="mt-0.5 font-medium tabular-nums">{r.monthly.thisMonth}<YoyDelta yoy={r.yoy} thisMonth={r.monthly.thisMonth} /></dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Last mo</dt>
          <dd className="mt-0.5 tabular-nums text-muted-foreground">{r.monthly.lastMonth}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">3 mo</dt>
          <dd className="mt-0.5 tabular-nums">{r.monthly.threeMonthTotal}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Lasts</dt>
          <dd className="mt-0.5"><LastsBadge row={r} /></dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Suggested</dt>
          <dd className="mt-0.5 tabular-nums">{r.reorderQty != null ? r.reorderQty : <span className="text-muted-foreground">—</span>}</dd>
        </div>
      </dl>
    </li>
  );
}

// Small year-over-year indicator under the "This month" number: ▲/▼ vs the same
// month last year. Only shown when there is a real baseline (yoy set); before 12
// months of history exists there is nothing to compare, so it renders nothing.
function YoyDelta({yoy, thisMonth}: {yoy: InventoryRow['yoy']; thisMonth: number}) {
  if (!yoy || yoy.deltaPct == null) return null;
  const up = yoy.deltaPct > 0, flat = yoy.deltaPct === 0;
  const cls = flat ? 'text-muted-foreground' : up ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
  return (
    <span className={cn('mt-0.5 block text-[10px] font-medium tabular-nums', cls)}
      title={`vs ${yoy.monthLabel}: ${yoy.lastYearSold} (this month ${thisMonth})`}>
      {flat ? '±' : up ? '▲' : '▼'}{Math.abs(yoy.deltaPct)}% YoY
    </span>
  );
}
function LastsBadge({row}: {row: InventoryRow}) {
  const {status, coverEventDays, monthly, runsOutLabel} = row;
  if (status === 'out') return <Badge tone="crit">runs out</Badge>;
  if (monthly.threeMonthTotal === 0 && coverEventDays == null) return <Badge tone="warn">not selling</Badge>;
  if (coverEventDays == null) return <span className="text-xs text-muted-foreground">{runsOutLabel}</span>;
  const tone = coverEventDays <= 2 ? 'crit' : 'ok';
  return <Badge tone={tone}>~{fmt1(coverEventDays)} selling days</Badge>;
}
function Badge({tone, children}: {tone: 'crit' | 'warn' | 'ok'; children: React.ReactNode}) {
  const cls = tone === 'crit' ? 'bg-red-500/10 text-red-600 dark:text-red-400'
    : tone === 'warn' ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
    : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
  return <span className={cn('inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold', cls)}>{children}</span>;
}

// Rendered in a portal with fixed positioning anchored to the ⋯ button, so it
// escapes the table's overflow container (which would otherwise clip it) and flips
// above the button when there isn't room below (bottom rows near the viewport edge).
type MenuPoint = {x: number; y: number};

function RowMenu({anchor, sku, active, pending, onRename, onReprice, onToggleListing, onMoveStock, onEditStock, onUndo, onClose}: {
  anchor: HTMLElement | MenuPoint | null; sku: string; active: boolean; pending: boolean; onRename: () => void; onReprice: () => void; onToggleListing: () => void; onMoveStock: () => void; onEditStock: () => void; onUndo: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{left: number; top: number} | null>(null);

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const isPoint = !(anchor instanceof HTMLElement);
    const a = isPoint ? {left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y} : anchor.getBoundingClientRect();
    const m = ref.current.getBoundingClientRect();
    const gap = isPoint ? 2 : 6, pad = 8;
    // Kebab: right-align under the button. Cursor: open with the corner at the pointer.
    const wantLeft = isPoint ? a.left : a.right - m.width;
    const left = Math.max(pad, Math.min(wantLeft, window.innerWidth - m.width - pad));
    let top = a.bottom + gap;
    if (top + m.height > window.innerHeight - pad) {
      const above = a.top - gap - m.height;
      top = above >= pad ? above : Math.max(pad, window.innerHeight - m.height - pad);
    }
    setPos({left, top});
  }, [anchor]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(anchor instanceof HTMLElement && anchor.contains(e.target as Node))) onClose();
    };
    const dismiss = () => onClose();
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true); // capture inner scroll containers too
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [anchor, onClose]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div ref={ref} onClick={(e) => e.stopPropagation()}
      style={{position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999, visibility: pos ? 'visible' : 'hidden'}}
      className="z-50 w-48 overflow-hidden rounded-xl border bg-popover text-left shadow-lg">
      <MenuItem href={`/inventory/${sku}`} icon={Eye}>View detail</MenuItem>
      <MenuItem onClick={onMoveStock} icon={ArrowLeftRight}>Move stock</MenuItem>
      <MenuItem onClick={onEditStock} icon={Pencil}>Edit stock</MenuItem>
      <MenuItem onClick={onUndo} disabled={pending} icon={Undo2}>Undo last add</MenuItem>
      <MenuItem onClick={onRename} icon={Type}>Rename</MenuItem>
      <MenuItem onClick={onReprice} icon={Tag}>Change price</MenuItem>
      <MenuItem onClick={onToggleListing} disabled={pending} icon={active ? EyeOff : Eye}>{active ? 'Unlist' : 'List'}</MenuItem>
    </div>,
    document.body,
  );
}
function MenuItem({children, onClick, href, disabled, icon: Icon}: {children: React.ReactNode; onClick?: () => void; href?: string; disabled?: boolean; icon?: LucideIcon}) {
  const cls = 'flex w-full items-center gap-2.5 border-b px-4 py-2.5 text-left text-sm font-medium last:border-0 hover:bg-muted disabled:opacity-50';
  const inner = (
    <>
      {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" />}
      {children}
    </>
  );
  if (href) return <Link href={href} className={cls}>{inner}</Link>;
  return <button type="button" onClick={onClick} disabled={disabled} className={cls}>{inner}</button>;
}

function EditDialog({row, field, usingMock, onClose, onSaved}: {
  row: InventoryRow; field: 'name' | 'price'; usingMock: boolean; onClose: () => void; onSaved: (patch: Partial<InventoryRow>) => void;
}) {
  const [value, setValue] = useState(field === 'name' ? row.name : String(row.price ?? ''));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {if (e.key === 'Escape') onClose();};
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function save() {
    setError(null);
    startTransition(async () => {
      const res = field === 'name' ? await renameProductAction(row.product_id, value.trim()) : await repriceProductAction(row.product_id, value.trim());
      if (res.ok) {
        onSaved(field === 'name' ? {name: value.trim()} : {price: Number(value)});
        router.refresh();
      } else setError(res.error);
    });
  }
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button type="button" aria-label="Cancel" onClick={onClose} className="absolute inset-0 cursor-default bg-foreground/40 backdrop-blur-[1px]" />
      <div className="relative w-full max-w-sm rounded-xl border bg-popover p-5 shadow-lg">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{field === 'name' ? 'Rename product' : 'Change price'}</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
        </div>
        <p className="mb-3 font-mono text-[11px] text-muted-foreground">{row.product_id}</p>
        {field === 'price' ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">₱</span>
            <input type="text" inputMode="decimal" value={value} autoFocus
              onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ''))}
              className="w-32 rounded-md border bg-background px-2 py-1.5 text-sm tabular-nums outline-none focus-visible:border-ring" />
          </div>
        ) : (
          <input type="text" value={value} autoFocus onChange={(e) => setValue(e.target.value)}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus-visible:border-ring" />
        )}
        {field === 'price' && (
          <p className="mt-2 text-[11px] text-muted-foreground">Logged to the price history. Past sales keep the price they were rung up at.</p>
        )}
        {usingMock && <p className="mt-2 text-xs text-muted-foreground">Demo mode — set the Supabase pos_* env to save.</p>}
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">Cancel</button>
          <button onClick={save} disabled={pending || usingMock} className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">{pending ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Set a product's on-hand in one location (Event or Office) to an exact count
// (set_product_stock -> a 'recount' movement carrying the signed delta). Distinct
// from Add stock: this overwrites that location's total. Prefilled with the current
// count; the ledger records previous -> new.
function EditStockDialog({row, usingMock, onClose, onDone}: {
  row: InventoryRow; usingMock: boolean; onClose: () => void; onDone: (newQty: number, loc: 'office' | 'event') => void;
}) {
  const [loc, setLoc] = useState<'office' | 'event'>('event');
  const current = loc === 'office' ? row.office : row.event;
  const [value, setValue] = useState(String(row.event));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {if (e.key === 'Escape') onClose();};
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const parsed = value.trim() === '' ? NaN : Math.round(Number(value));
  const valid = Number.isFinite(parsed) && parsed >= 0;
  const diff = valid ? parsed - current : 0;

  function save() {
    setError(null);
    if (!valid) {setError('Enter a stock count of zero or more.'); return;}
    startTransition(async () => {
      const res = await setStockAction(row.product_id, String(parsed), loc);
      if (res.ok) {
        onDone(parsed, loc);
        router.refresh();
      } else setError(res.error);
    });
  }
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button type="button" aria-label="Cancel" onClick={onClose} className="absolute inset-0 cursor-default bg-foreground/40 backdrop-blur-[1px]" />
      <div className="relative w-full max-w-sm rounded-xl border bg-popover p-5 shadow-lg">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Edit stock</h2>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
        </div>
        <p className="mb-3 font-mono text-[11px] text-muted-foreground">{row.name} · {row.product_id} · {current} in {loc === 'office' ? 'Office' : 'Event'} now</p>
        <div className="mb-3 inline-flex rounded-lg border bg-muted/40 p-1" role="group" aria-label="Location">
          {(['event', 'office'] as const).map((l) => (
            <button key={l} type="button" onClick={() => {setLoc(l); setValue(String(l === 'office' ? row.office : row.event));}}
              className={cn('rounded-md px-3 py-1.5 text-xs font-medium transition-colors', loc === l ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {l === 'office' ? 'Office' : 'Event'}<span className="ml-1.5 font-mono text-[9px] opacity-70">{l === 'office' ? row.office : row.event}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Set to</span>
          <input type="text" inputMode="numeric" value={value} autoFocus
            onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={(e) => {if (e.key === 'Enter') save();}}
            className="w-32 rounded-md border bg-background px-2 py-1.5 text-sm tabular-nums outline-none focus-visible:border-ring" />
          <span className="text-xs text-muted-foreground">units</span>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          {valid && diff !== 0
            ? `Changes ${current} → ${parsed} (${diff > 0 ? '+' : ''}${diff}). Logged to the stock history with the previous and new amounts.`
            : `Overwrites the ${loc === 'office' ? 'Office' : 'Event'} count. Logged to the stock history with the previous and new amounts.`}
        </p>
        {usingMock && <p className="mt-2 text-xs text-muted-foreground">Demo mode — set the Supabase pos_* env to edit stock.</p>}
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">Cancel</button>
          <button onClick={save} disabled={pending || usingMock || !valid || diff === 0} className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">{pending ? 'Saving…' : 'Save stock'}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function Th({children, className, onClick, active}: {children: React.ReactNode; className?: string; onClick?: () => void; active?: boolean}) {
  return (
    <th onClick={onClick} className={cn('cursor-pointer select-none whitespace-nowrap px-3 py-3 text-left transition-colors hover:text-foreground', active && 'text-primary', className)}>
      {children}
    </th>
  );
}
export function Sc({children}: {children: React.ReactNode}) {
  return <span className="ml-0.5 text-[9px] opacity-60">{children}</span>;
}

export function PillRow({label, items, active, onSelect}: {label: string; items: {v: string; l: string}[]; active: string; onSelect: (v: string) => void}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-16 shrink-0 whitespace-nowrap font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      {items.map((it) => (
        <button key={it.v || 'all'} type="button" onClick={() => onSelect(it.v)}
          className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors', active === it.v ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground')}>
          {it.l}
        </button>
      ))}
    </div>
  );
}
