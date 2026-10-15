'use client';

// Goldline Inventory — counts and forecast in one board (like Zoomy's Inventory), plus
// the warehouse side: how many each store needs, what's in the warehouse, when to ship
// so it arrives in time, and when to produce more. One store, or all stores added up.
// Row → product page; ⋯ → ship / warehouse stock / price / hide.

import {useMemo, useState, useTransition} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {Menu} from '@base-ui/react/menu';
import {ArrowDown, ArrowUp, ChevronsUpDown, Eye, EyeOff, FileText, Info, MoreHorizontal, Package, Pencil, Search, Settings2, Star, Truck, Upload, Warehouse, X} from 'lucide-react';
import type {BoardRow, BoardSummary, Shipment, SupplyConfig} from '@/src/goldline-supply';
import {lastsLabel, sortRank} from '@/src/goldline-supply';
import {Metric} from '@/components/analyst/metric';
import {SegmentedControl} from '@/components/analyst/segmented-control';
import {Pagination} from '@/components/analyst/pagination';
import {NativeSelect} from '@/components/ui/native-select';
import {Card, CardContent} from '@/components/ui/card';
import {Button, buttonVariants} from '@/components/ui/button';
import {fmtDay, MOVEMENT_STATUS, peso, StorePicker, ToneChip} from '@/components/analyst/goldline-ops-shared';
import {NumberDialog, priceSubmit, ShipmentDialog, SupplySettingsDialog, warehouseSubmit, type ShipTarget} from '@/components/analyst/goldline-supply-dialogs';
import {cancelShipmentAction, setHiddenAction} from '@/app/stock/actions';
import {cn} from '@/lib/utils';
import {GL_SCROLL_ROW_MOBILE, GL_TILES_MOBILE} from '@/src/goldline-ui';

export type BoardViewData = {
  company: string | null;
  canEdit: boolean;
  storeScoped: boolean;
  stores: Array<{code: string; name: string | null}>;
  store: string | null; // null = all stores
  rows: BoardRow[];
  summary: BoardSummary;
  config: SupplyConfig;
  productLines: string[];
  warehouse: Record<string, number>;
  shipments: Shipment[]; // in transit, for the stores in view
  today: string;
  currentMonth: string;
  count: {
    latestEnd: string | null;
    consultant: string | null;
    committedAt: string | null;
    sources: Array<{uploadId: string; filename: string; page: number | null}>;
    missingPages: number[];
  } | null;
  pendingReview: number;
};

type SortKey = 'urgency' | 'product' | 'price' | 'onHand' | 'thisMonth' | 'lastMonth' | 'threeMonths' | 'lasts' | 'need' | 'warehouse' | 'shipBy';
type Filter = 'all' | 'action' | 'out' | 'healthy' | 'not_counted';
const PAGE_SIZE = 25;

const STATUS_LABEL: Record<BoardRow['status'], {label: string; tone: string | null}> = {
  ...MOVEMENT_STATUS,
  not_moving: {label: 'Not moving', tone: null},
} as Record<BoardRow['status'], {label: string; tone: string | null}>;

const MENU_POPUP =
  'z-50 min-w-52 origin-[var(--transform-origin)] rounded-lg border bg-popover p-1 text-popover-foreground shadow-md outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0';
const MENU_ITEM =
  'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-muted';

const addDaysIso = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const num = (v: number | null) => (v == null ? '—' : v.toLocaleString('en-US'));
const monthName = (key: string, d = 0) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + d, 1)).toLocaleDateString('en-US', {month: 'short', timeZone: 'UTC'});
};
const needsAction = (r: BoardRow, warehouse: boolean) =>
  r.status === 'out' || r.status === 'reorder' || (r.shipBy?.kind === 'now' && r.need > 0) || (warehouse && (r.warehouseShort || r.produceBy?.kind === 'now'));
const shipRank = (r: BoardRow) => (r.shipBy == null ? '9999' : r.shipBy.kind === 'now' ? '0000' : r.shipBy.date);

function sortRows(rows: BoardRow[], key: SortKey, dir: 1 | -1): BoardRow[] {
  const val = (r: BoardRow): number | string => {
    switch (key) {
      case 'urgency':
        return `${sortRank(r.status)}|${shipRank(r)}`;
      case 'product':
        return `${r.productLine ?? ''} ${r.name}`.toLowerCase();
      case 'price':
        return r.price ?? -1;
      case 'onHand':
        return r.onHand ?? -1;
      case 'thisMonth':
        return r.thisMonth ?? -1;
      case 'lastMonth':
        return r.lastMonth ?? -1;
      case 'threeMonths':
        return r.threeMonths ?? -1;
      case 'lasts':
        return r.coverDays == null ? Number.MAX_VALUE : Number.isFinite(r.coverDays) ? r.coverDays : Number.MAX_VALUE / 2;
      case 'need':
        return r.need;
      case 'warehouse':
        return r.warehouse ?? -1;
      case 'shipBy':
        return shipRank(r);
    }
  };
  return [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return c * dir || a.name.localeCompare(b.name);
  });
}

export function GoldlineInventoryBoard({data}: {data: BoardViewData}) {
  const router = useRouter();
  const {rows, summary, store, config, today} = data;
  const [filter, setFilter] = useState<Filter>('all');
  const [line, setLine] = useState('');
  const [query, setQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [sort, setSort] = useState<{key: SortKey; dir: 1 | -1}>({key: 'urgency', dir: 1});
  const [page, setPage] = useState(1);
  const [ship, setShip] = useState<ShipTarget | null>(null);
  const [whEdit, setWhEdit] = useState<BoardRow | null>(null);
  const [priceEdit, setPriceEdit] = useState<BoardRow | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [, startHide] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const companyWide = data.canEdit && !data.storeScoped;
  // The warehouse serves every store; a store-scoped role only sees its own stores' needs,
  // so warehouse-wide flags (short, produce by) would be wrong for it — not shown.
  const showWarehouse = !data.storeScoped;
  const transitDays = store ? (config.storeTransitDays[store] ?? config.defaultTransitDays) : 0;

  const hiddenCount = rows.filter((r) => r.hidden).length;
  const visible = useMemo(() => rows.filter((r) => showHidden || !r.hidden), [rows, showHidden]);
  const counts = {
    all: visible.length,
    action: visible.filter((r) => needsAction(r, showWarehouse)).length,
    out: visible.filter((r) => r.status === 'out').length,
    healthy: visible.filter((r) => r.status === 'healthy').length,
    not_counted: visible.filter((r) => r.status === 'not_counted' || r.status === 'no_history').length,
  };
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sortRows(
      visible.filter(
        (r) =>
          (filter === 'all' ||
            (filter === 'action' && needsAction(r, showWarehouse)) ||
            (filter === 'out' && r.status === 'out') ||
            (filter === 'healthy' && r.status === 'healthy') ||
            (filter === 'not_counted' && (r.status === 'not_counted' || r.status === 'no_history'))) &&
          (!line || r.productLine === line) &&
          (!q || r.itemCode.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || (r.productLine ?? '').toLowerCase().includes(q)),
      ),
      sort.key,
      sort.dir,
    );
  }, [visible, filter, line, query, sort, showWarehouse]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const setSortKey = (key: SortKey) => {
    setPage(1);
    setSort((s) => (s.key === key ? {key, dir: (s.dir * -1) as 1 | -1} : {key, dir: key === 'product' || key === 'shipBy' || key === 'lasts' || key === 'urgency' ? 1 : -1}));
  };
  const productHref = (r: BoardRow) => `/stock/${encodeURIComponent(r.itemCode)}${store ? `?store=${encodeURIComponent(store)}` : ''}`;
  const itemOptions = useMemo(
    () =>
      rows
        .filter((r) => !r.hidden)
        .map((r) => ({code: r.itemCode, label: `${r.productLine ? `${r.productLine} · ` : ''}${r.name} (${r.itemCode})`}))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [rows],
  );
  const storeName = (code: string) => data.stores.find((s) => s.code === code)?.name ?? null;

  function toggleHidden(r: BoardRow) {
    startHide(async () => {
      const res = await setHiddenAction({company: data.company, item: r.itemCode, hidden: !r.hidden});
      setNotice(res.ok ? (r.hidden ? `${r.name} is back on the board.` : `${r.name} is hidden. Turn on “Show hidden” to see it.`) : res.error);
      router.refresh();
    });
  }

  const empty = data.stores.length === 0 || rows.length === 0;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="font-heading text-2xl font-semibold tracking-tight">Inventory</h1>
            <div className="flex flex-wrap items-center gap-2">
              {data.stores.length > 0 && <StorePicker stores={data.stores} value={store} allLabel={data.stores.length > 1 ? `All stores (${data.stores.length})` : undefined} />}
              <span className="font-mono text-xs text-muted-foreground">
                {data.count?.latestEnd
                  ? [`latest count ${fmtDay(data.count.latestEnd)}`, data.count.consultant && `by ${data.count.consultant}`].filter(Boolean).join(' · ')
                  : store
                    ? 'no count yet'
                    : `${data.stores.length} stores · latest counts`}
              </span>
              {store && (
                <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
                  <Truck className="size-3.5" aria-hidden /> {transitDays} {transitDays === 1 ? 'day' : 'days'} from the warehouse · sent today arrives ~
                  {fmtDay(addDaysIso(today, transitDays))}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)} disabled={!data.canEdit}>
              <Settings2 className="size-4" /> Supply settings
            </Button>
            {data.canEdit && (
              <Button size="sm" onClick={() => setShip({store, item: null})} disabled={empty}>
                <Truck className="size-4" /> Record shipment
              </Button>
            )}
          </div>
        </div>
        <div className="h-0.5 w-24 rounded-full bg-gradient-to-r from-primary to-transparent" aria-hidden />
      </header>

      {data.pendingReview > 0 && (
        <Link href="/uploads?status=needs_review" className="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors hover:bg-muted/50">
          <Upload className="size-4 text-muted-foreground" aria-hidden />
          <span>
            <span className="font-medium">{data.pendingReview} {data.pendingReview === 1 ? 'scan is' : 'scans are'} waiting for review</span>
            <span className="text-muted-foreground">. They&apos;ll update these numbers once committed.</span>
          </span>
        </Link>
      )}

      {config.isSample && (
        <p className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            <span className="font-medium">Warehouse stock and lead times are sample values</span>{' '}
            <span className="text-muted-foreground">
              until the real figures are gathered. Edit them in{' '}
              <button type="button" onClick={() => setSettingsOpen(true)} className="font-medium text-foreground underline-offset-4 hover:underline">
                Supply settings
              </button>{' '}
              or a product&apos;s ⋯ menu.
            </span>
          </span>
        </p>
      )}

      {empty ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <Package className="size-6 text-muted-foreground" aria-hidden />
            <h2 className="font-heading text-base font-semibold">No counts yet</h2>
            <p className="max-w-md text-sm text-muted-foreground">Upload a store&apos;s inventory form and commit it. Each product then shows its stock, sales pace and when to ship.</p>
            {data.canEdit && (
              <Link href="/uploads" className={cn(buttonVariants({size: 'sm'}), 'mt-1')}>
                <Upload className="size-4" /> Upload a scan
              </Link>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <section aria-label="Summary" className={cn("grid grid-cols-2 gap-4 lg:grid-cols-4", GL_TILES_MOBILE)}>
            <Metric label="Reorder now" value={String(summary.reorder)} sub={`${summary.out} out · rest under ~10 days`} valueClassName={summary.reorder ? 'text-[var(--status-warn)]' : undefined} />
            <Metric label="Ship now" value={String(summary.shipNow)} sub="won't arrive in time if sent later" valueClassName={summary.shipNow ? 'text-[var(--status-crit)]' : undefined} />
            {showWarehouse ? (
              <>
                <Metric label="Warehouse short" value={String(summary.warehouseShort)} sub="stores need more than it holds" valueClassName={summary.warehouseShort ? 'text-[var(--status-crit)]' : undefined} />
                <Metric label="Produce soon" value={String(summary.produceSoon)} sub="start within 2 weeks to keep up" valueClassName={summary.produceSoon ? 'text-[var(--status-warn)]' : undefined} />
              </>
            ) : (
              <>
                <Metric label="Out of stock" value={String(summary.out)} sub="deliver first" valueClassName={summary.out ? 'text-[var(--status-crit)]' : undefined} />
                <Metric label="On the way" value={String(data.shipments.length)} sub="shipments not yet counted" />
              </>
            )}
          </section>

          {data.count && (data.count.sources.length > 0 || data.count.missingPages.length > 0) && (
            <section aria-label="Source scans" className="-mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
              <span className="text-muted-foreground">Latest count from:</span>
              {data.count.sources.map((s) => (
                <Link
                  key={s.uploadId}
                  href={`/uploads/${s.uploadId}`}
                  className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2.5 transition-colors hover:border-foreground/30 hover:bg-muted"
                  title={s.filename}
                >
                  <FileText className="size-3 text-muted-foreground" aria-hidden />
                  {s.page ? `Page ${s.page}` : 'Scan'}
                </Link>
              ))}
              {data.count.missingPages.length > 0 && data.count.missingPages.length < 5 && (
                <span className="text-muted-foreground">Not in yet: page {data.count.missingPages.join(', ')}</span>
              )}
            </section>
          )}

          <Card className="py-0">
            <CardContent className="flex flex-col gap-3 px-0 pt-4 pb-3">
              <div className="flex flex-wrap items-center gap-2 px-4">
<div className={GL_SCROLL_ROW_MOBILE}>
                <SegmentedControl<Filter>
                  ariaLabel="Filter by status"
                  value={filter}
                  onChange={(v) => {
                    setFilter(v);
                    setPage(1);
                  }}
                  options={[
                    {value: 'all', label: `All ${counts.all}`},
                    {value: 'action', label: `Needs action ${counts.action}`},
                    {value: 'out', label: `Out ${counts.out}`},
                    {value: 'healthy', label: `Healthy ${counts.healthy}`},
                    {value: 'not_counted', label: `Not enough data ${counts.not_counted}`},
                  ]}
                />
                </div>
                <NativeSelect
                  aria-label="Product line"
                  value={line}
                  onChange={(e) => {
                    setLine(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">All product lines</option>
                  {data.productLines.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </NativeSelect>
                {hiddenCount > 0 && (
                  <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="size-3.5 accent-[var(--primary)]" />
                    Show hidden ({hiddenCount})
                  </label>
                )}
                <div className="relative ml-auto min-w-[12rem] max-md:w-full">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setPage(1);
                    }}
                    placeholder="Search product or code…"
                    aria-label="Search products"
                    className="h-8 w-full rounded-md border border-border bg-background pr-7 pl-8 text-sm outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
                  />
                  {query && (
                    <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground">
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
              </div>
              {notice && (
                <p role="status" className="mx-4 flex items-center justify-between gap-2 rounded-md bg-muted px-3 py-1.5 text-xs">
                  {notice}
                  <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="text-muted-foreground hover:text-foreground">
                    <X className="size-3.5" />
                  </button>
                </p>
              )}

              {pageRows.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">No products match.</p>
              ) : (
                <>
                  {/* Desktop table */}
                  <div className="overflow-x-auto max-md:hidden">
                    <table className="w-full border-collapse text-sm">
                      <thead>
                        <tr className="border-y border-border bg-muted/40 text-left text-[11px] font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase">
                          <Th k="product" sort={sort} onSort={setSortKey} className="pl-4">Product</Th>
                          <Th k="urgency" sort={sort} onSort={setSortKey}>Status</Th>
                          <Th k="price" sort={sort} onSort={setSortKey} right>Price</Th>
                          <Th k="onHand" sort={sort} onSort={setSortKey} right title="Back room (stockroom + drawer) · on display">On hand</Th>
                          <th className="py-2 pr-3 font-medium">Trend</th>
                          <Th k="thisMonth" sort={sort} onSort={setSortKey} right>{monthName(data.currentMonth)}</Th>
                          <Th k="lastMonth" sort={sort} onSort={setSortKey} right>{monthName(data.currentMonth, -1)}</Th>
                          <Th k="threeMonths" sort={sort} onSort={setSortKey} right>3 mo</Th>
                          <Th k="lasts" sort={sort} onSort={setSortKey}>Lasts</Th>
                          <Th k="need" sort={sort} onSort={setSortKey} right title={store ? "Top-up to two cycles of cover, less what's on the way" : "Every store's top-up, added up"}>Need</Th>
                          {showWarehouse && (
                            <Th k="warehouse" sort={sort} onSort={setSortKey} right title="Units in the warehouse · when to start producing">
                              Warehouse
                            </Th>
                          )}
                          <Th k="shipBy" sort={sort} onSort={setSortKey} title="Latest day to send so it arrives before running out">Ship by</Th>
                          <th className="w-10 py-2 pr-3" aria-label="Actions" />
                        </tr>
                      </thead>
                      <tbody>
                        {pageRows.map((r) => (
                          <tr
                            key={r.itemCode}
                            className={cn(
                              'relative border-b border-border/60 transition-colors duration-150 last:border-b-0 hover:bg-muted/40 has-[a[data-row]:focus-visible]:bg-muted/40',
                              r.hidden && 'opacity-55',
                            )}
                          >
                            <td className="max-w-[18rem] py-2 pr-3 pl-4">
                              <span className="flex items-center gap-1.5">
                                <Link
                                  data-row
                                  href={productHref(r)}
                                  className="truncate font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                                >
                                  {r.name}
                                </Link>
                                {r.bestseller && <Star aria-label="Bestseller" className="size-3.5 shrink-0 fill-current" style={{color: 'var(--status-warn)'}} />}
                              </span>
                              <span className="block truncate font-mono text-[11px] text-muted-foreground">
                                {r.itemCode}
                                {r.productLine ? ` · ${r.productLine}` : ''}
                                {r.hidden ? ' · hidden' : ''}
                              </span>
                            </td>
                            <td className="py-2 pr-3">
                              <StatusCell r={r} all={!store} />
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">{r.price == null ? '—' : peso(r.price)}</td>
                            <td className="py-2 pr-3 text-right whitespace-nowrap">
                              <span className="block font-mono text-xs font-semibold tabular-nums">{num(r.onHand)}</span>
                              {r.onHand != null && (
                                <span className="block font-mono text-[10.5px] text-muted-foreground tabular-nums" title="back room · on display">
                                  {num(r.backRoom)} · {num(r.display)}
                                </span>
                              )}
                            </td>
                            <td className="py-2 pr-3">
                              <Trend values={r.trend} />
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">{num(r.thisMonth)}</td>
                            <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums text-muted-foreground">{num(r.lastMonth)}</td>
                            <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">{num(r.threeMonths)}</td>
                            <td className="py-2 pr-3">
                              <Lasts r={r} />
                            </td>
                            <td className="py-2 pr-3 text-right whitespace-nowrap">
                              <span className={cn('block font-mono text-xs font-semibold tabular-nums', !r.need && 'font-normal text-muted-foreground')}>{r.need || '—'}</span>
                              {r.inTransit && (
                                <span className="block text-[10.5px] text-muted-foreground" title={`${r.inTransit.qty} on the way, arriving ${fmtDay(r.inTransit.arrivesOn)}`}>
                                  +{r.inTransit.qty} by {fmtDay(r.inTransit.arrivesOn)}
                                </span>
                              )}
                            </td>
                            {showWarehouse && (
                              <td className="py-2 pr-3 text-right whitespace-nowrap">
                                <WarehouseCell r={r} />
                              </td>
                            )}
                            <td className="py-2 pr-3 whitespace-nowrap">
                              <ShipByCell r={r} />
                            </td>
                            <td className="relative z-10 py-2 pr-3">
                              <RowMenu
                                r={r}
                                href={productHref(r)}
                                canEdit={data.canEdit}
                                companyWide={companyWide}
                                onShip={() => setShip({store, item: r.itemCode, need: r.need || undefined})}
                                onWarehouse={() => setWhEdit(r)}
                                onPrice={() => setPriceEdit(r)}
                                onHide={() => toggleHidden(r)}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile cards */}
                  <ul className="flex flex-col divide-y divide-border border-y border-border md:hidden">
                    {pageRows.map((r) => (
                      <li key={r.itemCode} className={cn('relative flex flex-col gap-2 px-4 py-3', r.hidden && 'opacity-55')}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <Link data-row href={productHref(r)} className="font-medium outline-none after:absolute after:inset-0 after:content-['']">
                              {r.name}
                            </Link>
                            <span className="block truncate font-mono text-[11px] text-muted-foreground">
                              {r.itemCode}
                              {r.productLine ? ` · ${r.productLine}` : ''}
                            </span>
                          </div>
                          <div className="relative z-10 flex items-center gap-1">
                            <StatusCell r={r} all={!store} />
                            <RowMenu
                              r={r}
                              href={productHref(r)}
                              canEdit={data.canEdit}
                              companyWide={companyWide}
                              onShip={() => setShip({store, item: r.itemCode, need: r.need || undefined})}
                              onWarehouse={() => setWhEdit(r)}
                              onPrice={() => setPriceEdit(r)}
                              onHide={() => toggleHidden(r)}
                            />
                          </div>
                        </div>
                        <dl className="grid grid-cols-4 gap-x-3 gap-y-1.5 text-xs">
                          <Stat k="On hand" v={num(r.onHand)} />
                          <Stat k={monthName(data.currentMonth)} v={num(r.thisMonth)} />
                          <Stat k="3 mo" v={num(r.threeMonths)} />
                          <Stat k="Lasts" v={lastsLabel(r.coverDays) ?? '—'} />
                          <Stat k="Need" v={r.need ? String(r.need) : '—'} />
                          {showWarehouse ? <Stat k="Warehouse" v={num(r.warehouse)} warn={r.warehouseShort} /> : <Stat k="Last mo" v={num(r.lastMonth)} />}
                          <Stat k="Ship by" v={r.shipBy == null ? '—' : r.shipBy.kind === 'now' ? 'Now' : fmtDay(r.shipBy.date)} warn={r.shipBy?.kind === 'now'} />
                          <Stat k="Price" v={r.price == null ? '—' : peso(r.price)} />
                        </dl>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 px-4">
                <span className="text-xs text-muted-foreground">
                  {filtered.length ? `Showing ${(safePage - 1) * PAGE_SIZE + 1} to ${Math.min(safePage * PAGE_SIZE, filtered.length)} of ${filtered.length}` : ''}
                </span>
                <Pagination page={safePage} pageCount={pageCount} onPage={setPage} />
              </div>
            </CardContent>
          </Card>

          {data.shipments.length > 0 && <OnTheWay shipments={data.shipments} rows={rows} storeName={storeName} company={data.company} canEdit={data.canEdit} today={today} />}

          <p className="text-xs leading-relaxed text-muted-foreground">
            On hand is the latest count (back room = stockroom + drawer · on display). Sold per month is estimated from consecutive counts (or the sales
            report once a product&apos;s POS SKU is linked. <span className="font-medium text-foreground">Need</span> tops each store up to two cycles of
            cover, less anything on the way. <span className="font-medium text-foreground">Ship by</span> is the run-out date minus the store&apos;s delivery
            time. <span className="font-medium text-foreground">Warehouse</span> covers every store&apos;s need; the date under it is when to start producing
            (the line&apos;s production time before the warehouse runs dry). Dates use Philippine time.
          </p>
        </>
      )}

      {ship && (
        <ShipmentDialog
          key={`${ship.store}-${ship.item}`}
          company={data.company}
          open
          onClose={() => setShip(null)}
          initial={ship}
          stores={data.stores}
          items={itemOptions}
          warehouse={data.warehouse}
          config={config}
          today={today}
        />
      )}
      {whEdit && (
        <NumberDialog
          open
          onClose={() => setWhEdit(null)}
          title="Warehouse stock"
          description={`${whEdit.productLine ? `${whEdit.productLine} · ` : ''}${whEdit.name}: units in the warehouse now.`}
          label="Units in the warehouse"
          initial={whEdit.warehouse}
          submitLabel="Save"
          onSubmit={warehouseSubmit(data.company, whEdit.itemCode)}
        />
      )}
      {priceEdit && (
        <NumberDialog
          open
          onClose={() => setPriceEdit(null)}
          title="Change price"
          description={`${priceEdit.productLine ? `${priceEdit.productLine} · ` : ''}${priceEdit.name}. The change is logged.`}
          label="Price"
          prefix="₱"
          step={0.01}
          initial={priceEdit.price}
          submitLabel="Change price"
          onSubmit={priceSubmit(data.company, priceEdit.itemCode)}
        />
      )}
      {settingsOpen && (
        <SupplySettingsDialog
          company={data.company}
          open
          onClose={() => setSettingsOpen(false)}
          config={config}
          stores={data.stores}
          productLines={data.productLines}
          storeScoped={data.storeScoped}
        />
      )}
    </div>
  );
}

function Th({k, sort, onSort, children, right, className, title}: {k: SortKey; sort: {key: SortKey; dir: 1 | -1}; onSort: (k: SortKey) => void; children: React.ReactNode; right?: boolean; className?: string; title?: string}) {
  const active = sort.key === k;
  const Icon = !active ? ChevronsUpDown : sort.dir === 1 ? ArrowUp : ArrowDown;
  return (
    <th className={cn('py-2 pr-3 font-medium', right && 'text-right', className)} aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined} title={title}>
      <button type="button" onClick={() => onSort(k)} className={cn('inline-flex items-center gap-1 uppercase transition-colors hover:text-foreground', active && 'text-foreground')}>
        {children}
        <Icon className={cn('size-3', !active && 'opacity-50')} aria-hidden />
      </button>
    </th>
  );
}

function StatusCell({r, all}: {r: BoardRow; all: boolean}) {
  const s = STATUS_LABEL[r.status];
  return (
    <span className="flex flex-col items-start gap-0.5">
      <ToneChip tone={s.tone}>{s.label}</ToneChip>
      {all && r.storesNeeding > 0 && (
        <span className="text-[10.5px] text-muted-foreground">
          {r.storesNeeding} of {r.storesCounted} {r.storesCounted === 1 ? 'store' : 'stores'}
        </span>
      )}
    </span>
  );
}

function Trend({values}: {values: [number | null, number | null, number | null]}) {
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  const none = values.every((v) => !v);
  return (
    <span className="flex h-5 items-end gap-0.5" aria-label={`Sold: ${values.map((v) => v ?? 'no data').join(', ')}`} role="img">
      {values.map((v, i) => (
        <span
          key={i}
          className={cn('w-1.5 rounded-sm', none || v == null ? 'bg-muted-foreground/25' : 'bg-[var(--status-good)]')}
          style={{height: `${v == null ? 12 : Math.max(12, (v / max) * 100)}%`, opacity: i === 2 ? 1 : 0.65}}
        />
      ))}
    </span>
  );
}

function Lasts({r}: {r: BoardRow}) {
  if (r.status === 'out') return <ToneChip tone="var(--status-crit)">out</ToneChip>;
  const label = lastsLabel(r.coverDays);
  if (!label) return <span className="text-xs text-muted-foreground">needs 2 counts</span>;
  if (label === 'not selling') return <ToneChip tone="var(--status-warn)">not selling</ToneChip>;
  const tone = r.coverDays != null && r.coverDays < 10 ? 'var(--status-crit)' : r.coverDays != null && r.coverDays < 20 ? 'var(--status-warn)' : 'var(--status-good)';
  return <ToneChip tone={tone}>{label}</ToneChip>;
}

function WarehouseCell({r}: {r: BoardRow}) {
  if (r.warehouse == null) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="flex flex-col items-end">
      <span className={cn('font-mono text-xs font-semibold tabular-nums', r.warehouseShort && 'text-[var(--status-crit)]')} title={r.warehouseShort ? `Stores need ${-(r.warehouseAfterNeeds ?? 0)} more than the warehouse holds` : undefined}>
        {num(r.warehouse)}
      </span>
      {r.produceBy && (
        <span className={cn('text-[10.5px]', r.produceBy.kind === 'now' ? 'font-semibold text-[var(--status-crit)]' : 'text-muted-foreground')} title={`${r.productionDays} days to produce`}>
          {r.produceBy.kind === 'now' ? 'produce now' : `produce by ${fmtDay(r.produceBy.date)}`}
        </span>
      )}
    </span>
  );
}

function ShipByCell({r}: {r: BoardRow}) {
  if (r.shipBy == null || (!r.need && r.shipBy.kind === 'now' && r.status !== 'out')) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="flex flex-col">
      {r.shipBy.kind === 'now' ? (
        <span className="text-xs font-semibold text-[var(--status-crit)]">Now</span>
      ) : (
        <span className="font-mono text-xs tabular-nums">{fmtDay(r.shipBy.date)}</span>
      )}
    </span>
  );
}

function Stat({k, v, warn}: {k: string; v: string; warn?: boolean}) {
  return (
    <div className="flex flex-col">
      <dt className="text-[10.5px] text-muted-foreground">{k}</dt>
      <dd className={cn('font-mono tabular-nums', warn && 'font-semibold text-[var(--status-crit)]')}>{v}</dd>
    </div>
  );
}

function RowMenu({
  r,
  href,
  canEdit,
  companyWide,
  onShip,
  onWarehouse,
  onPrice,
  onHide,
}: {
  r: BoardRow;
  href: string;
  canEdit: boolean;
  companyWide: boolean;
  onShip: () => void;
  onWarehouse: () => void;
  onPrice: () => void;
  onHide: () => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger aria-label={`Actions for ${r.name}`} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted">
        <MoreHorizontal className="size-4" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4}>
          <Menu.Popup className={MENU_POPUP}>
            <Menu.Item className={MENU_ITEM} render={<Link href={href} />}>
              <Eye className="size-4 text-muted-foreground" /> View product page
            </Menu.Item>
            {canEdit && (
              <Menu.Item className={MENU_ITEM} onClick={onShip}>
                <Truck className="size-4 text-muted-foreground" /> Record shipment
              </Menu.Item>
            )}
            {companyWide && (
              <>
                <Menu.Item className={MENU_ITEM} onClick={onWarehouse}>
                  <Warehouse className="size-4 text-muted-foreground" /> Edit warehouse stock
                </Menu.Item>
                <Menu.Item className={MENU_ITEM} onClick={onPrice}>
                  <Pencil className="size-4 text-muted-foreground" /> Change price
                </Menu.Item>
                <Menu.Separator className="my-1 h-px bg-border" />
                <Menu.Item className={MENU_ITEM} onClick={onHide}>
                  {r.hidden ? <Eye className="size-4 text-muted-foreground" /> : <EyeOff className="size-4 text-muted-foreground" />}
                  {r.hidden ? 'Show on the board' : 'Hide product'}
                </Menu.Item>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function OnTheWay({shipments, rows, storeName, company, canEdit, today}: {shipments: Shipment[]; rows: BoardRow[]; storeName: (c: string) => string | null; company: string | null; canEdit: boolean; today: string}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const nameOf = new Map(rows.map((r) => [r.itemCode, `${r.productLine ? `${r.productLine} · ` : ''}${r.name}`]));
  return (
    <Card className="py-0">
      <CardContent className="flex flex-col gap-1 px-0 pt-4 pb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-4">
          <h2 className="flex items-center gap-2 font-heading text-base font-semibold">
            <Truck className="size-4 text-muted-foreground" aria-hidden /> On the way
          </h2>
          <span className="text-xs text-muted-foreground">until the store&apos;s next count records the delivery</span>
        </div>
        {error && (
          <p role="alert" className="px-4 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-y border-border bg-muted/40 text-left text-[11px] font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase">
                <th className="py-2 pr-3 pl-4 font-medium">Product</th>
                <th className="py-2 pr-3 font-medium">To</th>
                <th className="py-2 pr-3 text-right font-medium">Units</th>
                <th className="py-2 pr-3 font-medium">Sent</th>
                <th className="py-2 pr-3 font-medium">Arrives</th>
                <th className="py-2 pr-4" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shipments.map((s) => (
                <tr key={s.id} className="border-b border-border/60 last:border-b-0">
                  <td className="max-w-[18rem] truncate py-2 pr-3 pl-4">{nameOf.get(s.itemCode) ?? s.itemCode}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{storeName(s.storeCode) ? `${s.storeCode} · ${storeName(s.storeCode)}` : `Store ${s.storeCode}`}</td>
                  <td className="py-2 pr-3 text-right font-mono text-xs font-semibold tabular-nums">{s.qty}</td>
                  <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">{fmtDay(s.shippedOn)}</td>
                  <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">{fmtDay(s.arrivesOn)}</td>
                  <td className="py-2 pr-4 text-right whitespace-nowrap">
                    {s.arrivesOn <= today ? (
                      <span className="text-xs text-muted-foreground">due · awaiting count</span>
                    ) : canEdit &&
                      (confirm === s.id ? (
                        <span className="inline-flex items-center gap-1">
                          <Button
                            size="xs"
                            variant="destructive"
                            disabled={pending}
                            onClick={() =>
                              start(async () => {
                                const res = await cancelShipmentAction({company, id: s.id});
                                setConfirm(null);
                                if (!res.ok) return setError(res.error);
                                setError(null);
                                router.refresh();
                              })
                            }
                          >
                            Cancel shipment
                          </Button>
                          <Button size="xs" variant="ghost" onClick={() => setConfirm(null)}>
                            Keep
                          </Button>
                        </span>
                      ) : (
                        <Button size="xs" variant="ghost" onClick={() => setConfirm(s.id)}>
                          Cancel…
                        </Button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
