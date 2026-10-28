'use client';

import {useEffect, useMemo, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {Archive, ArchiveRestore, Loader2, NotebookPen, RotateCcw, ArrowDown, ArrowUp, Check, ChevronDown, ChevronsUpDown, CircleCheck, CircleDashed, CircleHelp, FileQuestion, Link2, MessageSquare, MoreHorizontal, Search, SearchCheck, Unlink, X} from 'lucide-react';
import type {DecommissionedItem, ItemNote, SkuLinkData, SkuLinkItem, SkuLinkRow} from '@/src/goldline-sku-links-data';
import {approveSuggestionAction, linkSkuAction, rejectSuggestionAction, saveItemNoteAction, saveRemarkAction, setDecommissionedAction, undoDecisionAction, unlinkSkuAction} from '@/app/stock/skus/actions';
import type {DecisionInfo} from '@/src/goldline-sku-undo';
import {decisionLabel, UndoDialog} from '@/components/analyst/goldline-undo-dialog';
import {ACTION_WORD, formSpotText, type FormSpot, linkedHow, SKU_TAGS, skuStatus, type SkuStatus, type Tone, watsonsName} from '@/src/goldline-sku-tags';
import {Button} from '@/components/ui/button';
import {ItemCombobox} from '@/components/analyst/goldline-item-combobox';
import {Pagination} from '@/components/analyst/pagination';
import {FormPageDialog} from '@/components/analyst/goldline-form-page';
import {GL_PAGE} from '@/src/goldline-ui';
import {cn} from '@/lib/utils';
import {itemDisplayName} from '@/src/goldline-item-name';

// SKU linking (Oct 27): which Watsons SKU code is which Nichido item. Second calm-down
// pass: four columns (SKU · our item with its form page · price · decision), Watsons names
// in title case without the repeated "NICHIDO", one price unless the two differ, a quiet
// "⋯" on linked rows, and rows per page moved down beside the pager.
// Kept calm on purpose (Hick's Law): one row of tabs instead of five cards, only the
// chosen tab's explanation, one obvious action per row, and the remark box and
// secondary actions (unlink, remark only) open on demand. Each item shows where it is
// printed on the inventory form (page and row), and Watsons' average price sits next
// to ours so a match can be checked at a glance.

const PAGE_SIZES = [5, 10, 20, 100] as const;
type PageSize = (typeof PAGE_SIZES)[number];
const SIZE_KEY = 'coop.skus.perPage';
const NUMBERS_KEY = 'coop.skus.numbersOpen';
const REMARK_MAX = 500;
// One column template for the header and every row, so the columns line up.
const COLS = 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_9rem_minmax(12.5rem,14rem)]';
const ITEM_COLS = 'md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_7rem]';
const ITEM_COLS_EDIT = 'md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_7rem_minmax(18rem,19.5rem)]';

const n = (v: number) => Math.round(v).toLocaleString('en-US');
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
const day = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'Asia/Manila',
      })
    : '';
const itemText = (i: SkuLinkItem) => itemDisplayName(i.productLine, i.variant, i.itemCode);
// 'info' has no status token: it uses the muted text colour.
const toneVar = (t: Tone) => (t === 'info' ? 'var(--muted-foreground)' : `var(--status-${t})`);
const tint = (t: Tone, pct: number) => `color-mix(in oklab, ${toneVar(t)} ${pct}%, transparent)`;
// One icon per view for the help strip above the table.
const TAB_ICON: Record<SkuStatus, typeof Check> = {check: SearchCheck, choose: CircleHelp, rejected: X, linked: CircleCheck, noSales: CircleDashed, formOnly: FileQuestion, decommissioned: Archive};

type Act = (key: string, fn: () => Promise<{ok: true} | {ok: false; error: string}>, okText: string, onOk?: () => void, onErr?: () => void) => void;

export function GoldlineSkuLinks({company, data, canEdit}: {company: string; data: SkuLinkData; canEdit: boolean}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    kind: 'ok' | 'err';
    text: string;
  } | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState<PageSize>(20);
  const [formAt, setFormAt] = useState<{page: number; itemCode: string} | null>(null);
  const showForm = (itemCode: string, spot: FormSpot | null) => spot && setFormAt({page: spot.page, itemCode});

  // Rows per page is a per-viewer convenience: remembered in this browser only.
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(SIZE_KEY));
      if ((PAGE_SIZES as readonly number[]).includes(v)) setSize(v as PageSize);
    } catch {}
  }, []);
  const changeSize = (v: PageSize) => {
    setSize(v);
    setPage(1);
    try {
      localStorage.setItem(SIZE_KEY, String(v));
    } catch {}
  };

  const lists = useMemo(() => {
    const out: Record<Exclude<SkuStatus, 'formOnly' | 'decommissioned'>, SkuLinkRow[]> = {
      check: [],
      choose: [],
      rejected: [],
      linked: [],
      noSales: [],
    };
    // Listed by Watsons but never sold in the window: nothing to decide, so kept out of the
    // working tabs and reachable from the total in the header.
    for (const r of data.rows) out[r.units > 0 || r.linked ? skuStatus(r) : 'noSales'].push(r);
    return out;
  }, [data.rows]);
  // Our items Coop already suggested for a "to check" SKU are answered there, so the
  // "Sold at Watsons?" view is only the ones with no Watsons SKU and no suggestion.
  const suggestedItems = useMemo(() => new Set(lists.check.map((r) => r.suggestion?.itemCode).filter(Boolean)), [lists.check]);
  const noMatchItems = useMemo(() => data.unlinkedItems.filter((i) => !suggestedItems.has(i.itemCode)), [data.unlinkedItems, suggestedItems]);
  const counts: Record<SkuStatus, number> = {
    check: lists.check.length,
    choose: lists.choose.length,
    rejected: lists.rejected.length,
    linked: lists.linked.length,
    noSales: lists.noSales.length,
    formOnly: noMatchItems.length,
    decommissioned: data.decommissioned.length,
  };
  const [filter, setFilter] = useState<SkuStatus>(lists.check.length ? 'check' : lists.choose.length ? 'choose' : 'linked');

  // Column sorting. "Biggest sellers first" is the default and the third click on a column
  // goes back to it, so there's never a sort the page can't get out of.
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const sortBy = (key: SortKey) => {
    setPage(1);
    setSort((s) => (s.key !== key ? {key, dir: 1} : s.dir === 1 ? {key, dir: -1} : DEFAULT_SORT));
  };

  const q = query.trim().toLowerCase();
  const shownSkus = useMemo(() => {
    if (filter === 'formOnly' || filter === 'decommissioned') return [];
    const rows = lists[filter].filter((r) => {
      const it = r.linked ?? r.suggestion;
      return !q || r.name.toLowerCase().includes(q) || r.skuCode.includes(q) || (it ? `${it.itemCode} ${itemText(it)}`.toLowerCase().includes(q) : false);
    });
    return sort.key === 'sales' ? rows : sortRows(rows, (r) => skuSortValue(r, sort.key), sort.dir);
  }, [lists, filter, q, sort]);
  const shownItems = useMemo((): Array<SkuLinkItem | DecommissionedItem> => {
    if (filter !== 'formOnly' && filter !== 'decommissioned') return [];
    const items = (filter === 'decommissioned' ? data.decommissioned : noMatchItems).filter((i) => !q || `${i.itemCode} ${itemText(i)}`.toLowerCase().includes(q));
    return sort.key === 'sales' ? items : sortRows(items, (i) => itemSortValue(i, sort.key), sort.dir);
  }, [noMatchItems, data.decommissioned, filter, q, sort]);
  const itemView = filter === 'formOnly' || filter === 'decommissioned';
  const total = itemView ? shownItems.length : shownSkus.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(page, pageCount);
  const from = (safePage - 1) * size;
  const slice = <T,>(xs: T[]) => xs.slice(from, from + size);

  const act: Act = (key, fn, okText, onOk, onErr) => {
    setBusy(key);
    setNotice(null);
    start(async () => {
      const res = await fn();
      setBusy(null);
      if (res.ok) {
        setNotice({kind: 'ok', text: okText});
        onOk?.();
        router.refresh();
      } else {
        setNotice({kind: 'err', text: res.error});
        onErr?.();
      }
    });
  };

  const t = data.totals;
  // Every Watsons SKU in the files, so the tabs add up: the ones with no units sold in the
  // whole window (listed by Watsons, never sold) have nothing to decide and aren't in a tab.
  const allSkus = data.rows.length;
  // Our side is a second list, so it gets its own total: every form item is either linked
  // (the same 210 pairs) or has no Watsons code yet. Many of those are the items Coop
  // suggested for "to check" SKUs, which is why the tab counts can't simply be added up.
  const formItems = counts.linked + data.unlinkedItems.length + data.decommissioned.length;
  const formOnlySuggested = data.unlinkedItems.length - noMatchItems.length;
  const linkedPct = pct(t.linkedUnits, t.units);
  const suggestedPct = pct(t.suggestedUnits, t.units);
  const pick = (s: SkuStatus) => {
    setFilter(s);
    setPage(1);
    setSort(DEFAULT_SORT);
  };
  const tag = SKU_TAGS[filter];
  const TabIcon = TAB_ICON[filter];

  return (
    <div className={GL_PAGE}>
      <header className="flex max-w-3xl flex-col gap-1.5">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">SKU linking</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">Coop has already linked the Watsons SKUs it is sure of. These need your eye.</p>
      </header>

      {/* Three jobs, one card each (Hick's Law): a card filters the table below. Everything
          else (linked, rejected, no units sold) is reached from "For your records". */}
      <section aria-label="What needs a decision" className="grid grid-cols-3 gap-2 sm:gap-4">
        <ActionCard view="check" value={counts.check} title="Check Coop’s match" sub="Approve or reject each one" active={filter === 'check'} onPick={pick} />
        <ActionCard view="choose" value={counts.choose} title="Choose our item" sub="Pick it from our items" active={filter === 'choose'} onPick={pick} />
        <ActionCard view="formOnly" value={counts.formOnly} title="Sold at Watsons?" sub="On our forms, no Watsons SKU yet" active={filter === 'formOnly'} onPick={pick} />
      </section>

      <NumbersTable
        filter={filter}
        onPick={pick}
        totals={{watsons: allSkus, ours: formItems}}
        rows={[
          {view: 'linked', tone: 'good', name: 'Linked', means: 'A Watsons SKU and our item, matched. Their sales count.', watsons: counts.linked, ours: counts.linked},
          {view: 'check', tone: 'warn', name: 'Coop’s suggestion', means: 'Coop paired them. A person says if it is right.', watsons: counts.check, ours: formOnlySuggested},
          {view: 'choose', tone: 'crit', name: 'No match found', means: 'Watsons sold it, but Coop could not tell which of our items it is.', watsons: counts.choose, ours: null},
          ...(counts.rejected > 0
            ? [{view: 'rejected' as const, tone: 'crit' as const, name: 'Rejected', means: 'Coop’s suggestion was turned down. Pick the right item.', watsons: counts.rejected, ours: null}]
            : []),
          {view: 'noSales', tone: 'info', name: 'No units sold', means: 'In Watsons’ files, but none sold in 12 months. Nothing to decide.', watsons: counts.noSales, ours: null},
          {view: 'formOnly', tone: 'info', name: 'No Watsons SKU', means: 'On our forms, with no Watsons SKU and no suggestion. Some may be under No match found with a short name.', watsons: null, ours: counts.formOnly},
          ...(counts.decommissioned > 0
            ? [{view: 'decommissioned' as const, tone: 'info' as const, name: 'Decommissioned', means: 'On our forms, but no longer made or sold. Left out of matching and restock.', watsons: null, ours: counts.decommissioned}]
            : []),
        ]}
        footnote={
          <>
            <span className="font-medium text-foreground tabular-nums">{linkedPct}%</span> of the units Watsons sold are on linked SKUs. Approving Coop’s suggestions adds {suggestedPct}%.
          </>
        }
      />

      <div className="flex items-start gap-3 rounded-xl px-4 py-3" style={{background: tint(tag.tone, 8)}}>
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full" style={{background: tint(tag.tone, 18), color: toneVar(tag.tone)}}>
          <TabIcon aria-hidden className="size-3.5" />
        </span>
        <p className="text-sm leading-relaxed">
          <span className="font-medium">
            {tag.label} · <span className="tabular-nums">{n(counts[filter])}</span>.
          </span>{' '}
          <span className="text-muted-foreground">{tag.help}</span>
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative max-md:w-full">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Search name or code…"
            aria-label="Search name or code"
            className="h-9 w-72 rounded-md border border-border bg-background pr-2.5 pl-8 text-sm outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 max-md:w-full"
          />
        </div>
        {total > 0 && (
          <p className="text-xs text-muted-foreground tabular-nums">
            {n(total)} {itemView ? 'items' : 'Watsons SKUs'}
            {sort.key !== 'sales' ? (
              <>
                , {sortText(sort, filter)}
                {' · '}
                <button type="button" onClick={() => setSort(DEFAULT_SORT)} className="underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground">
                  {itemView ? 'form order' : 'biggest sellers first'}
                </button>
              </>
            ) : itemView ? (
              ', in form order'
            ) : filter !== 'noSales' ? (
              ', biggest sellers first'
            ) : (
              ''
            )}
          </p>
        )}
      </div>

      {notice && (
        <p role="status" className={cn('-my-2 text-sm', notice.kind === 'ok' ? 'text-muted-foreground' : 'text-destructive')}>
          {notice.text}
        </p>
      )}

      {total === 0 ? (
        <p className="rounded-xl border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">{query ? 'Nothing matches that search.' : EMPTY[filter]}</p>
      ) : itemView ? (
        <div className="overflow-hidden rounded-xl border">
          <div className={cn('hidden gap-8 border-b px-6 py-3 text-xs font-medium text-muted-foreground md:grid', canEdit ? ITEM_COLS_EDIT : ITEM_COLS)}>
            <SortHead label="Item on our form" k="item" sort={sort} onSort={sortBy} />
            <SortHead label="Product line" k="line" sort={sort} onSort={sortBy} />
            <SortHead label="Price" k="price" sort={sort} onSort={sortBy} right />
            {canEdit && <span>Your decision</span>}
          </div>
          <ul className="divide-y">
            {slice(shownItems).map((i) => (
              <ItemRow
                key={i.itemCode}
                i={i}
                note={data.notes[i.itemCode] ?? null}
                decision={data.decisions[`item:${i.itemCode}`]}
                decommissioned={filter === 'decommissioned'}
                company={company}
                canEdit={canEdit}
                disabled={pending}
                busy={busy === i.itemCode}
                act={act}
                onShowForm={showForm}
              />
            ))}
          </ul>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <div className={cn('hidden gap-8 border-b px-6 py-3 text-xs font-medium text-muted-foreground lg:grid', COLS)}>
            <SortHead label="Watsons SKU" k="sku" sort={sort} onSort={sortBy} />
            <SortHead label="Our item" k="item" sort={sort} onSort={sortBy} />
            <SortHead label="Price" k="price" sort={sort} onSort={sortBy} right />
            <SortHead label={canEdit ? 'Your decision' : 'Decision'} k="decision" sort={sort} onSort={sortBy} />
          </div>
          <ul className="divide-y">
            {slice(shownSkus).map((r) => (
              <SkuRow key={r.skuCode} r={r} company={company} canEdit={canEdit} items={data.unlinkedItems} disabled={false} busy={busy === r.skuCode} act={act} onShowForm={showForm} quiet={filter === 'noSales'} decision={data.decisions[`sku:${r.skuCode}`]} />
            ))}
          </ul>
        </div>
      )}

      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <p className="text-xs text-muted-foreground tabular-nums">
              {n(from + 1)} to {n(Math.min(total, from + size))} of {n(total)}
            </p>
            <RowsPerPage value={size} onChange={changeSize} />
          </div>
          <Pagination page={safePage} pageCount={pageCount} onPage={setPage} label="SKU pages" />
        </div>
      )}

      {formAt && data.formPages.length > 0 && <FormPageDialog pages={data.formPages} at={formAt} onClosed={() => setFormAt(null)} />}
    </div>
  );
}

type SortKey = 'sales' | 'sku' | 'item' | 'price' | 'decision' | 'line';
type Sort = {key: SortKey; dir: 1 | -1};
const DEFAULT_SORT: Sort = {key: 'sales', dir: -1};
const SORT_LABEL: Record<SortKey, string> = {sales: 'sales', sku: 'Watsons name', item: 'our item', price: 'price', decision: 'decision', line: 'product line'};
/** "by price, low to high" and so on, for the line above the table. */
function sortText({key, dir}: Sort, view: SkuStatus): string {
  if (key === 'price') return `by price, ${dir === 1 ? 'low to high' : 'high to low'}`;
  if (key === 'decision') {
    const first = view === 'check' ? 'least sure match first' : 'latest decision first';
    return dir === 1 ? first : `by decision, ${view === 'check' ? 'surest match first' : 'oldest decision first'}`;
  }
  return `by ${SORT_LABEL[key]}, ${dir === 1 ? 'A to Z' : 'Z to A'}`;
}
const TIER_RANK = {low: 0, medium: 1, high: 2} as const;

type SortValue = string | number | null;
/** Sort by one value; empty values (no item, no price) always go last, whichever the direction. */
function sortRows<T>(xs: T[], val: (x: T) => SortValue, dir: 1 | -1): T[] {
  return [...xs].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
  });
}
function skuSortValue(r: SkuLinkRow, key: SortKey): SortValue {
  const it = r.linked ?? r.suggestion;
  switch (key) {
    case 'sku':
      return watsonsName(r.name).toLowerCase();
    case 'item':
      return it ? itemText(it).toLowerCase() : null;
    case 'price':
      return r.avgPrice;
    case 'decision':
      // Coop's suggestions: "not sure" first. Everything else: the latest decision first.
      return r.suggestion ? TIER_RANK[r.suggestion.tier] : r.review?.actionAt ? -Date.parse(r.review.actionAt) : null;
    default:
      return null;
  }
}
function itemSortValue(i: SkuLinkItem, key: SortKey): SortValue {
  return key === 'price' ? i.price : key === 'line' ? (i.productLine ?? 'Other').toLowerCase() : key === 'item' ? itemText(i).toLowerCase() : null;
}

/** A sortable column header: click for ascending, again for descending, a third time back to the default. */
function SortHead({label, k, sort, onSort, right = false}: {label: string; k: SortKey; sort: Sort; onSort: (k: SortKey) => void; right?: boolean}) {
  const on = sort.key === k;
  const Icon = !on ? ChevronsUpDown : sort.dir === 1 ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      aria-label={`Sort by ${label}${on ? (sort.dir === 1 ? ', ascending' : ', descending') : ''}`}
      className={cn(
        'group inline-flex items-center gap-1 rounded-sm text-left outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
        right && 'justify-self-end',
        on && 'text-foreground',
      )}
    >
      {label}
      <Icon aria-hidden className={cn('size-3 shrink-0', on ? 'opacity-100' : 'opacity-40 group-hover:opacity-80')} />
    </button>
  );
}

/** The record that a decision was undone: what, who decided it, who undid it and when. */
function UndoneLine({decision}: {decision: DecisionInfo}) {
  return (
    <p className="flex w-full min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={`${decisionLabel(decision)} by ${decision.by ?? 'someone'}, undone by ${decision.undoneBy ?? 'someone'}`}>
      <RotateCcw className="size-3 shrink-0" aria-hidden />
      <span className="truncate">
        Undone: {decisionLabel(decision)}
        {decision.by ? ` by ${decision.by}` : ''}
        {decision.undoneBy ? ` · undone by ${decision.undoneBy}` : ''}
        {decision.undoneAt ? `, ${day(decision.undoneAt)}` : ''}
      </span>
    </p>
  );
}

const CARD_TONE: Record<'check' | 'choose' | 'formOnly', Tone> = {check: 'warn', choose: 'crit', formOnly: 'info'};

/** One job on the page: its count, what it is and what to do. Pressed while it's the table's filter. */
function ActionCard({
  view,
  value,
  title,
  sub,
  active,
  onPick,
}: {
  view: 'check' | 'choose' | 'formOnly';
  value: number;
  title: string;
  sub: string;
  active: boolean;
  onPick: (s: SkuStatus) => void;
}) {
  const tone = CARD_TONE[view];
  const color = view === 'formOnly' ? 'var(--foreground)' : toneVar(tone);
  return (
    <button
      type="button"
      onClick={() => onPick(view)}
      aria-pressed={active}
      className="flex min-w-0 flex-col items-start rounded-xl border bg-card px-3 py-3 text-left outline-none transition-[border-color,box-shadow,transform] duration-150 ease-out hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] sm:px-5 sm:py-4"
      style={active ? {borderColor: color, boxShadow: `0 0 0 1px ${color}`} : undefined}
    >
      <span className="font-heading text-2xl font-semibold tabular-nums sm:text-4xl" style={{color: value > 0 ? color : 'var(--muted-foreground)'}}>
        {n(value)}
      </span>
      <span className="mt-1.5 text-xs font-medium leading-snug sm:mt-3 sm:text-base">{title}</span>
      <span className="mt-0.5 hidden text-sm text-muted-foreground sm:block">{sub}</span>
    </button>
  );
}

type NumbersRow = {view: SkuStatus; tone: Tone; name: string; means: string; watsons: number | null; ours: number | null};

/**
 * Watsons SKUs and our items side by side (Oct 28): every group with its count on each
 * side, so the two totals (315 and 263) visibly add up and the shared rows (linked pairs,
 * Coop's suggestions) read as the same pairs, not extra items. A row filters the table.
 */
function NumbersTable({rows, totals, filter, onPick, footnote}: {rows: NumbersRow[]; totals: {watsons: number; ours: number}; filter: SkuStatus; onPick: (s: SkuStatus) => void; footnote: React.ReactNode}) {
  // Open by default; folding it keeps just the totals. Remembered per browser.
  const [open, setOpen] = useState(true);
  useEffect(() => {
    try {
      if (localStorage.getItem(NUMBERS_KEY) === '0') setOpen(false);
    } catch {}
  }, []);
  const toggle = () =>
    setOpen((v) => {
      try {
        localStorage.setItem(NUMBERS_KEY, v ? '0' : '1');
      } catch {}
      return !v;
    });
  const cell = (v: number | null) => (v == null ? <span className="text-muted-foreground/60">—</span> : n(v));
  const GRID = 'grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] items-center gap-x-4 px-4 sm:grid-cols-[minmax(0,1fr)_7rem_7rem] sm:px-6';
  return (
    <section aria-label="How the numbers fit" className="overflow-hidden rounded-xl border">
      <div className={cn(GRID, 'bg-muted/40 py-3 text-xs font-medium text-muted-foreground', open && 'border-b')}>
        <span>How the numbers fit</span>
        <span className="text-right">Watsons SKUs</span>
        <span className="text-right">Our items</span>
      </div>
      <div id="numbers-rows" className={cn('grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <ul className="min-h-0 divide-y overflow-hidden" aria-hidden={!open}>
          {rows.map((r) => {
            const on = filter === r.view;
            return (
              <li key={r.view}>
                <button
                  type="button"
                  onClick={() => onPick(r.view)}
                  aria-pressed={on}
                  tabIndex={open ? undefined : -1}
                  className={cn(GRID, 'w-full py-3 text-left outline-none transition-colors duration-150 hover:bg-muted/40 focus-visible:bg-muted/40', on && 'bg-muted/50')}
                >
                  <span className="flex min-w-0 items-start gap-2.5">
                    <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{background: toneVar(r.tone)}} aria-hidden />
                    <span className="flex min-w-0 flex-col">
                      <span className={cn('text-sm', on ? 'font-semibold' : 'font-medium')}>{r.name}</span>
                      <span className="text-xs leading-relaxed text-muted-foreground">{r.means}</span>
                    </span>
                  </span>
                  <span className="text-right text-sm tabular-nums">{cell(r.watsons)}</span>
                  <span className="text-right text-sm tabular-nums">{cell(r.ours)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className={cn(GRID, 'py-3', open && 'border-t')}>
        <span className="pl-[18px] text-sm font-semibold">Total</span>
        <span className="text-right font-heading text-base font-semibold tabular-nums">{n(totals.watsons)}</span>
        <span className="text-right font-heading text-base font-semibold tabular-nums">{n(totals.ours)}</span>
      </div>
      {open && <p className="border-t px-4 py-3 text-xs leading-relaxed text-muted-foreground sm:px-6">{footnote}</p>}
      {/* The toggle sits at the bottom, in the brand colour, so it reads as the way in and out. */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls="numbers-rows"
        className="flex w-full items-center justify-center gap-1.5 border-t border-primary/25 bg-primary/15 py-3 text-sm font-semibold text-primary outline-none transition-colors duration-150 hover:bg-primary/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {open ? 'Hide the breakdown' : `Show the breakdown · ${rows.length} groups`}
        <ChevronDown aria-hidden className={cn('size-4 transition-transform duration-200 ease-out motion-reduce:transition-none', open && 'rotate-180')} />
      </button>
    </section>
  );
}

/**
 * One of our form items with no Watsons SKU. On "Sold at Watsons?" it can be marked as
 * decommissioned (no longer made or sold) with an optional remark; on "Decommissioned"
 * it shows who did it and why, and can be brought back.
 */
function ItemRow({
  i,
  note,
  decision,
  decommissioned,
  company,
  canEdit,
  disabled,
  busy,
  act,
  onShowForm,
}: {
  i: SkuLinkItem | DecommissionedItem;
  note: ItemNote | null;
  decision?: DecisionInfo;
  decommissioned: boolean;
  company: string;
  canEdit: boolean;
  disabled: boolean;
  busy: boolean;
  act: Act;
  onShowForm: (itemCode: string, spot: FormSpot | null) => void;
}) {
  // One panel at a time: a note (for checking, or anything) or decommissioning; they're separate.
  const [panel, setPanel] = useState<'note' | 'decom' | null>(null);
  const [remark, setRemark] = useState('');
  const [text, setText] = useState('');
  // Saving a note is optimistic: the note shows the moment Save is pressed ("Saving…", then
  // "Saved" when the server confirms) while the page reloads behind it; if it fails, the
  // note is taken back and the panel reopens. `removed` hides a note being removed.
  const [optimistic, setOptimistic] = useState<ItemNote | 'removed' | null>(null);
  const [undoOpen, setUndoOpen] = useState(false);
  const [undoing, setUndoing] = useState<'saving' | 'saved' | null>(null);
  const decisionKey = `${decision?.id ?? ''}|${decision?.undoneAt ?? ''}`;
  const [seenDecision, setSeenDecision] = useState(decisionKey);
  if (decisionKey !== seenDecision) {
    // The reloaded page shows the undo: drop the "Undoing…" state.
    setSeenDecision(decisionKey);
    if (undoing === 'saved') setUndoing(null);
  }
  // On Decommissioned, "Bring back" already undoes a decommission; no second button.
  const canUndo = Boolean(decision && !decision.undoneAt && !(decommissioned && decision.action === 'decommissioned'));
  const undo = () => {
    if (!decision) return;
    setUndoing('saving');
    act(
      i.itemCode,
      () => undoDecisionAction({company, id: decision.id}),
      `Undone: ${decisionLabel(decision)}.`,
      () => setUndoing((u) => (u ? 'saved' : u)),
      () => setUndoing(null),
    );
  };
  const [saving, setSaving] = useState<'saving' | 'saved' | null>(null);
  useEffect(() => {
    // The reloaded page has caught up: drop the stand-in.
    if (optimistic === 'removed' ? !note : optimistic && note?.text === optimistic.text) {
      setOptimistic(null);
      setSaving(null);
    }
  }, [note, optimistic]);
  const shown = optimistic === 'removed' ? null : (optimistic ?? note);
  const saveNote = (value: string | null) => {
    const previous = optimistic;
    setOptimistic(value ? {text: value.trim(), by: null, at: new Date().toISOString()} : 'removed');
    setSaving(value ? 'saving' : null);
    setPanel(null);
    act(
      i.itemCode,
      () => saveItemNoteAction({company, item: i.itemCode, note: value}),
      value ? `Note saved for ${i.itemCode}.` : `Note removed from ${i.itemCode}.`,
      () => setSaving((st) => (st ? 'saved' : st)),
      () => {
        setOptimistic(previous);
        setSaving(null);
        if (value) setPanel('note');
      },
    );
  };
  const done = () => {
    setPanel(null);
    setRemark('');
  };
  const openNote = () => {
    setText(shown?.text ?? '');
    setPanel((p) => (p === 'note' ? null : 'note'));
  };
  const d = decommissioned ? (i as DecommissionedItem) : null;
  const input =
    'min-h-14 w-full max-w-xl resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none transition-colors placeholder:text-muted-foreground hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40';
  return (
    <li className="transition-colors duration-150 hover:bg-muted/30">
      <div className={cn('grid gap-1.5 px-6 py-4 md:items-center md:gap-8', canEdit ? ITEM_COLS_EDIT : ITEM_COLS)}>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="truncate text-sm" title={itemText(i)}>
            {itemText(i)}
          </p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="tabular-nums">{i.itemCode}</span>
            <span aria-hidden>·</span>
            <FormSpotLink spot={i.formSpot} onClick={() => onShowForm(i.itemCode, i.formSpot)} />
          </p>
          {shown && panel !== 'note' && (
            <p
              key={saving ? 'pending' : 'note'}
              className="flex min-w-0 max-w-xl items-start gap-1.5 rounded-md px-2 py-1 text-xs motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-200"
              style={{background: 'color-mix(in oklab, var(--status-warn) 12%, transparent)'}}
              title={`${shown.text}${shown.by ? ` · ${shown.by}` : ''} · ${day(shown.at)}`}
            >
              <NotebookPen className="mt-0.5 size-3 shrink-0" style={{color: 'var(--status-warn)'}} aria-hidden />
              <span className="flex min-w-0 flex-col">
                <span className="line-clamp-2">{shown.text}</span>
                {saving ? (
                  <span className="mt-0.5 flex items-center gap-1.5 text-muted-foreground" role="status">
                    {saving === 'saving' ? (
                      <>
                        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden /> Saving…
                      </>
                    ) : (
                      <>
                        <Check className="size-3" style={{color: 'var(--status-good)'}} aria-hidden /> Saved
                      </>
                    )}
                    {/* Who and when fill in once the page reloads. */}
                    <span className="h-2 w-20 rounded-full bg-foreground/10 motion-safe:animate-pulse" aria-hidden />
                  </span>
                ) : (
                  <span className="text-muted-foreground">{[shown.by, day(shown.at)].filter(Boolean).join(' · ')}</span>
                )}
              </span>
            </p>
          )}
          {d && (
            <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={d.remark ?? undefined}>
              <Archive className="size-3 shrink-0" aria-hidden />
              <span className="truncate">
                Decommissioned {[d.at && day(d.at), d.by].filter(Boolean).join(' · ')}
                {d.remark ? ` · “${d.remark}”` : ''}
              </span>
            </p>
          )}
        </div>
        <span className="truncate text-sm text-muted-foreground">{i.productLine ?? 'Other'}</span>
        <span className="text-sm tabular-nums md:text-right">{i.price != null ? `₱${n(i.price)}` : '—'}</span>
        {canEdit && undoing && (
          <span role="status" className="inline-flex items-center gap-1.5 justify-self-start rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
            {undoing === 'saving' ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
            {undoing === 'saving' ? 'Undoing…' : 'Undone'}
          </span>
        )}
        {canEdit && !undoing && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant={panel === 'note' ? 'secondary' : 'ghost'} onClick={openNote} aria-expanded={panel === 'note'} disabled={saving === 'saving'}>
              <NotebookPen className="size-3.5" /> {shown ? 'Edit note' : 'Add note'}
            </Button>
            {d ? (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => act(i.itemCode, () => setDecommissionedAction({company, item: i.itemCode, on: false}), `${i.itemCode} is back under Sold at Watsons?.`)}
              >
                <ArchiveRestore className="size-3.5" /> {busy && panel === null ? 'Saving…' : 'Bring back'}
              </Button>
            ) : (
              <Button size="sm" variant={panel === 'decom' ? 'secondary' : 'outline'} onClick={() => setPanel((p) => (p === 'decom' ? null : 'decom'))} aria-expanded={panel === 'decom'}>
                <Archive className="size-3.5" /> Mark as decommissioned
              </Button>
            )}
            {canUndo && decision && (
              <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setUndoOpen(true)} title={`Undo: ${decisionLabel(decision)}`}>
                <RotateCcw className="size-3.5" /> Undo
              </Button>
            )}
          </div>
        )}
      </div>
      {decision?.undoneAt && !undoing && (
        <div className="px-6 pb-3 -mt-2">
          <UndoneLine decision={decision} />
        </div>
      )}
      {undoOpen && decision && (
        <UndoDialog decision={decision} subject={`${itemText(i)} · ${i.itemCode}`} onConfirm={undo} onClosed={() => setUndoOpen(false)} />
      )}
      {panel === 'note' && canEdit && (
        <div className="flex flex-col gap-2.5 bg-muted/30 px-6 pt-1 pb-5">
          <p className="text-xs text-muted-foreground">A note for this item, for example to check it later. It doesn’t change anything else; only the latest note is kept.</p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={REMARK_MAX}
            rows={2}
            autoFocus
            placeholder="For example, “check with Justin” or “maybe the Watsons name LIP PNCL”"
            aria-label={`Note for ${i.itemCode}`}
            className={input}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!text.trim() || text.trim() === shown?.text} onClick={() => saveNote(text)}>
              <NotebookPen className="size-3.5" /> Save note
            </Button>
            {shown && (
              <Button size="sm" variant="outline" onClick={() => saveNote(null)}>
                Remove note
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setPanel(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {panel === 'decom' && canEdit && !d && (
        <div className="flex flex-col gap-2.5 bg-muted/30 px-6 pt-1 pb-5">
          <p className="text-xs text-muted-foreground">No longer made or sold. It leaves SKU matching and restock, and can be brought back from Decommissioned.</p>
          <textarea
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            maxLength={REMARK_MAX}
            rows={2}
            autoFocus
            placeholder="Why? For example, “discontinued in 2025” (optional)"
            aria-label={`Remarks for ${i.itemCode}`}
            className={input}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => act(i.itemCode, () => setDecommissionedAction({company, item: i.itemCode, on: true, remark}), `${i.itemCode} is marked as decommissioned.`, done)}
            >
              <Archive className="size-3.5" /> {busy ? 'Saving…' : 'Mark as decommissioned'}
            </Button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={done}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

const EMPTY: Record<SkuStatus, string> = {
  check: 'No matches waiting. Everything Coop suggested has been decided.',
  choose: 'Every Watsons SKU with sales has a link or a suggestion.',
  rejected: 'No rejected matches waiting for an item.',
  linked: 'No links yet.',
  noSales: 'Every Watsons SKU in the files has sold at least once.',
  formOnly: 'Every item on our forms has a Watsons SKU or a match from Coop to check.',
  decommissioned: 'No items are marked as decommissioned.',
};

function RowsPerPage({value, onChange}: {value: PageSize; onChange: (v: PageSize) => void}) {
  return (
    <div role="group" aria-label="Rows per page" className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>Rows</span>
      <div className="flex rounded-md bg-muted/60 p-0.5">
        {PAGE_SIZES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={value === s}
            onClick={() => onChange(s)}
            className={cn(
              'h-6 min-w-8 rounded px-2 tabular-nums transition-colors duration-150',
              value === s ? 'bg-background font-medium text-foreground shadow-sm' : 'hover:text-foreground',
            )}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The decision's state in place of the buttons: a spinner while saving, a check once saved. */
function DecisionChip({outcome}: {outcome: {doing: string; done: string; tone: Tone; state: 'saving' | 'saved'}}) {
  const saved = outcome.state === 'saved';
  return (
    <span
      role="status"
      key={outcome.state}
      className="inline-flex min-w-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-200"
      style={{color: saved ? toneVar(outcome.tone) : 'var(--muted-foreground)', background: `color-mix(in oklab, ${saved ? toneVar(outcome.tone) : 'var(--muted-foreground)'} 13%, transparent)`}}
    >
      {saved ? <Check className="size-3.5 shrink-0" aria-hidden /> : <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
      <span className="truncate">{saved ? outcome.done : outcome.doing}</span>
    </span>
  );
}

function SkuRow({
  r,
  company,
  canEdit,
  items,
  disabled,
  busy,
  act,
  onShowForm,
  quiet = false,
  decision,
}: {
  r: SkuLinkRow;
  company: string;
  canEdit: boolean;
  items: SkuLinkItem[];
  disabled: boolean;
  busy: boolean;
  act: Act;
  onShowForm: (itemCode: string, spot: FormSpot | null) => void;
  /** Nothing to decide here (no units sold), so the action is offered, not pushed. */
  quiet?: boolean;
  /** The latest decision on this SKU, for Undo (or the record that it was undone). */
  decision?: DecisionInfo;
}) {
  const status = skuStatus(r);
  const [undoOpen, setUndoOpen] = useState(false);
  const [remark, setRemark] = useState('');
  const [item, setItem] = useState('');
  const [open, setOpen] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  // A decision shows at once: the buttons give way to a chip ("Approving…", then
  // "Approved" when the server confirms) while the page reloads and the row moves to its
  // new list. A failure brings the buttons back with the error.
  const [outcome, setOutcome] = useState<{doing: string; done: string; tone: Tone; remark?: string; item?: SkuLinkItem; state: 'saving' | 'saved'} | null>(null);
  const rowKey = `${r.linked?.itemCode ?? ''}|${r.suggestion?.itemCode ?? ''}|${r.review?.action ?? ''}|${r.review?.remark ?? ''}`;
  const [seenKey, setSeenKey] = useState(rowKey);
  if (rowKey !== seenKey) {
    // The reloaded row has caught up: drop the chip.
    setSeenKey(rowKey);
    if (outcome?.state === 'saved') setOutcome(null);
  }
  const decide = (fn: () => Promise<{ok: true} | {ok: false; error: string}>, okText: string, chip: {doing: string; done: string; tone: Tone; remark?: string; item?: SkuLinkItem}) => {
    setOutcome({...chip, state: 'saving'});
    done();
    act(
      sku,
      fn,
      okText,
      () => setOutcome((o) => (o ? {...o, state: 'saved'} : o)),
      () => setOutcome(null),
    );
  };
  // While a link or approval is saving, show the item it is being linked to.
  const shown = outcome?.item ?? r.linked ?? r.suggestion;
  const sku = r.skuCode;
  const choosing = status === 'choose' || status === 'rejected';
  const done = () => {
    setRemark('');
    setItem('');
    setOpen(false);
    setUnlinking(false);
  };
  const priceOff = shown?.price != null && r.avgPrice != null && shown.price > 0 && Math.abs(r.avgPrice / shown.price - 1) > 0.15;
  const note = r.review?.remark;
  const ours = shown?.price ?? null;
  const theirs = r.avgPrice;
  const samePrice = ours != null && theirs != null && Math.round(ours) === Math.round(theirs);

  return (
    <li>
      <div
        className={cn('grid gap-x-8 gap-y-3 px-6 py-4 transition-colors duration-150 hover:bg-muted/30 lg:items-center', COLS, open && 'bg-muted/30')}
        style={outcome ? {background: `color-mix(in oklab, ${toneVar(outcome.tone)} 6%, transparent)`} : undefined}
      >
        <div className="flex min-w-0 flex-col gap-1">
          <p className="truncate text-sm font-medium" title={r.name}>
            {watsonsName(r.name)}
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">{sku}</p>
        </div>

        <div className="flex min-w-0 flex-col gap-1">
          {shown ? (
            <>
              <p className="flex min-w-0 items-center gap-2 text-sm">
                <span className="truncate" title={itemText(shown)}>
                  {itemText(shown)}
                </span>
                {!r.linked && r.suggestion?.tier === 'low' && (
                  <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{color: 'var(--status-warn)', background: 'color-mix(in oklab, var(--status-warn) 14%, transparent)'}}>
                    Not sure
                  </span>
                )}
              </p>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="tabular-nums">{shown.itemCode}</span>
                <span aria-hidden>·</span>
                <FormSpotLink spot={shown.formSpot} onClick={() => onShowForm(shown.itemCode, shown.formSpot)} />
              </p>
            </>
          ) : status === 'rejected' && r.review?.itemCode ? (
            <p className="text-sm text-muted-foreground">
              Rejected {r.review.itemCode}. No other match.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">No item yet</p>
          )}
        </div>

        <div className="flex flex-col gap-0.5 text-sm tabular-nums lg:items-end" title={priceOff ? 'Prices differ by more than 15%. Check it is the same product.' : undefined}>
          {samePrice || theirs == null || ours == null ? (
            <span>
              <span className="text-xs text-muted-foreground lg:hidden">Price </span>
              {ours != null ? `₱${n(ours)}` : theirs != null ? `₱${n(theirs)}` : '—'}
            </span>
          ) : (
            <>
              <span style={priceOff ? {color: 'var(--status-warn)'} : undefined}>
                <span className="text-xs text-muted-foreground lg:hidden">Ours </span>₱{n(ours)}
              </span>
              <span className="text-xs text-muted-foreground">Watsons ₱{n(theirs)}</span>
            </>
          )}
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {outcome && <DecisionChip outcome={outcome} />}
          {!outcome && canEdit && status === 'check' && r.suggestion && (
            <>
              <Button
                size="sm"
                disabled={disabled}
                onClick={() =>
                  decide(
                    () =>
                      approveSuggestionAction({
                        company,
                        sku,
                        item: r.suggestion!.itemCode,
                        remark,
                      }),
                    `Approved. ${sku} is now linked to ${r.suggestion!.itemCode}.`,
                    {doing: 'Approving…', done: `Approved · linked to ${r.suggestion!.itemCode}`, tone: 'good', remark},
                  )
                }
              >
                <Check className="size-3.5" /> Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() =>
                  decide(
                    () =>
                      rejectSuggestionAction({
                        company,
                        sku,
                        item: r.suggestion!.itemCode,
                        remark,
                      }),
                    `Rejected. Coop won't suggest ${r.suggestion!.itemCode} for ${sku} again.`,
                    {doing: 'Rejecting…', done: `Rejected ${r.suggestion!.itemCode}`, tone: 'crit', remark},
                  )
                }
              >
                <X className="size-3.5" /> Reject
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-label={`Add a remark for ${sku}`}
                title="Add a remark"
                className="text-muted-foreground"
              >
                <MessageSquare className="size-3.5" />
              </Button>
            </>
          )}
          {!outcome && canEdit && choosing && (
            <Button size="sm" variant={open ? 'secondary' : quiet ? 'outline' : 'default'} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              <Link2 className="size-3.5" /> Choose item
            </Button>
          )}
          {!outcome && canEdit && status === 'linked' && (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-label={`Remark or unlink ${sku}`}
              title="Remark or unlink"
              className="text-muted-foreground"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          )}
          {!outcome && canEdit && decision && !decision.undoneAt && (
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setUndoOpen(true)} title={`Undo: ${decisionLabel(decision)}`}>
              <RotateCcw className="size-3.5" /> Undo
            </Button>
          )}
          {!outcome && decision?.undoneAt && <UndoneLine decision={decision} />}
          {(outcome?.remark?.trim() || note) && !open && (
            <p className="flex w-full min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={outcome?.remark?.trim() || note || undefined}>
              <MessageSquare className="size-3 shrink-0" />
              <span className="truncate">{outcome?.remark?.trim() || note}</span>
            </p>
          )}
        </div>
      </div>

      {open && canEdit && (
        <div className="flex flex-col gap-4 bg-muted/30 px-6 pt-1 pb-5 lg:flex-row lg:items-start lg:gap-8">
          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            {r.linked && <p className="text-xs text-muted-foreground">How it was linked: {linkedHow(r)}.</p>}
            {choosing && (
              <ItemCombobox items={items} value={item} onChange={setItem} watsonsPrice={r.avgPrice} label={`Item for ${sku}`} />
            )}
            <textarea
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              maxLength={REMARK_MAX}
              rows={2}
              autoFocus={!choosing}
              placeholder={unlinking ? 'Why unlink? (optional)' : 'Remarks (optional)'}
              aria-label={`Remarks for ${sku}`}
              className="min-h-14 w-full max-w-xl resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none transition-colors placeholder:text-muted-foreground hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
            />
            <div className="flex flex-wrap items-center gap-2">
              {choosing && (
                <Button size="sm" disabled={disabled || !item} onClick={() => decide(() => linkSkuAction({company, sku, item, remark}), `Linked ${sku} to ${item}.`, {doing: `Linking to ${item}…`, done: `Linked to ${item}`, tone: 'good', remark, item: items.find((x) => x.itemCode === item)})}>
                  <Link2 className="size-3.5" /> {busy ? 'Saving…' : 'Link'}
                </Button>
              )}
              {status === 'linked' &&
                (unlinking ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={disabled}
                    onClick={() => decide(() => unlinkSkuAction({company, sku, remark}), `Unlinked ${sku}. Coop won't match it to ${r.linked!.itemCode} again.`, {doing: 'Unlinking…', done: `Unlinked ${r.linked!.itemCode}`, tone: 'crit', remark})}
                  >
                    <Unlink className="size-3.5" /> {busy ? 'Saving…' : 'Confirm unlink'}
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" disabled={disabled} onClick={() => setUnlinking(true)}>
                    <Unlink className="size-3.5" /> Unlink
                  </Button>
                ))}
              {status !== 'check' && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled || !remark.trim()}
                  onClick={() => decide(() => saveRemarkAction({company, sku, remark}), 'Remark saved.', {doing: 'Saving remark…', done: 'Remark saved', tone: 'info', remark})}
                >
                  Save remark only
                </Button>
              )}
              {status === 'check' && <p className="text-xs text-muted-foreground">Saved with Approve or Reject.</p>}
              <Button size="sm" variant="ghost" disabled={disabled} onClick={done}>
                Cancel
              </Button>
            </div>
          </div>
          <ReviewNote r={r} />
        </div>
      )}
      {undoOpen && decision && (
        <UndoDialog
          decision={decision}
          subject={`Watsons SKU ${sku} · ${watsonsName(r.name)}`}
          onConfirm={() => decide(() => undoDecisionAction({company, id: decision.id}), `Undone: ${decisionLabel(decision)}.`, {doing: 'Undoing…', done: 'Undone', tone: 'info'})}
          onClosed={() => setUndoOpen(false)}
        />
      )}
    </li>
  );
}

/** The latest decision and the latest remark, with who and when. */
function ReviewNote({r}: {r: SkuLinkRow}) {
  const v = r.review;
  if (!v || (!v.action && !v.remark)) return null;
  return (
    <div className="flex flex-col gap-1 text-xs lg:w-80 lg:shrink-0">
      <p className="font-medium text-muted-foreground">Last decision</p>
      {v.action && (
        <p className="text-muted-foreground">
          <span className="text-foreground">{ACTION_WORD[v.action]}</span>
          {v.itemCode ? <span className="font-mono"> {v.itemCode}</span> : null}
          {v.actionBy ? ` by ${v.actionBy}` : ''}
          {v.actionAt ? ` · ${day(v.actionAt)}` : ''}
        </p>
      )}
      {v.remark && (
        <p className="[overflow-wrap:anywhere] whitespace-pre-line">
          &ldquo;{v.remark}&rdquo;
          <span className="text-muted-foreground">
            {v.remarkBy ? ` · ${v.remarkBy}` : ''}
            {v.remarkAt ? ` · ${day(v.remarkAt)}` : ''}
          </span>
        </p>
      )}
    </div>
  );
}

/** "Page 2 · row 17", as a link that opens that page of the form with the item pinpointed. */
function FormSpotLink({spot, onClick}: {spot: FormSpot | null; onClick: () => void}) {
  if (!spot) return <span className="text-muted-foreground">{formSpotText(spot)}</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      title="Show this row on the inventory form"
      className="rounded-sm text-left tabular-nums underline decoration-border decoration-dotted underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      {formSpotText(spot)}
    </button>
  );
}
