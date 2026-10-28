'use client';

import {Fragment, useEffect, useMemo, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {Check, CircleCheck, CircleHelp, FileQuestion, Link2, MessageSquare, MoreHorizontal, Search, SearchCheck, Unlink, X} from 'lucide-react';
import type {SkuLinkData, SkuLinkItem, SkuLinkRow} from '@/src/goldline-sku-links-data';
import {approveSuggestionAction, linkSkuAction, rejectSuggestionAction, saveRemarkAction, unlinkSkuAction} from '@/app/stock/skus/actions';
import {ACTION_WORD, formSpotText, type FormSpot, linkedHow, SKU_TAGS, skuStatus, type SkuStatus, type Tone, watsonsName} from '@/src/goldline-sku-tags';
import {Button} from '@/components/ui/button';
import {ItemCombobox} from '@/components/analyst/goldline-item-combobox';
import {Pagination} from '@/components/analyst/pagination';
import {FormPageDialog} from '@/components/analyst/goldline-form-page';
import {GL_PAGE, GL_SCROLL_ROW_MOBILE} from '@/src/goldline-ui';
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
const REMARK_MAX = 500;
const ORDER: SkuStatus[] = ['check', 'choose', 'rejected', 'linked', 'formOnly'];
const TAB: Record<SkuStatus, string> = {
  check: 'Check Coop’s match',
  choose: 'Choose the item',
  rejected: 'Rejected',
  linked: 'Linked',
  formOnly: 'Form items without a SKU',
};
// One column template for the header and every row, so the columns line up.
const COLS = 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_9rem_minmax(12.5rem,14rem)]';
const ITEM_COLS = 'md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_7rem]';

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
// One icon per tab for the help strip under the tabs.
const TAB_ICON: Record<SkuStatus, typeof Check> = {check: SearchCheck, choose: CircleHelp, rejected: X, linked: CircleCheck, formOnly: FileQuestion};

type Act = (key: string, fn: () => Promise<{ok: true} | {ok: false; error: string}>, okText: string, onOk?: () => void) => void;

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
    const out: Record<Exclude<SkuStatus, 'formOnly'>, SkuLinkRow[]> = {
      check: [],
      choose: [],
      rejected: [],
      linked: [],
    };
    for (const r of data.rows) if (r.units > 0 || r.linked) out[skuStatus(r)].push(r);
    return out;
  }, [data.rows]);
  const counts: Record<SkuStatus, number> = {
    check: lists.check.length,
    choose: lists.choose.length,
    rejected: lists.rejected.length,
    linked: lists.linked.length,
    formOnly: data.unlinkedItems.length,
  };
  const [filter, setFilter] = useState<SkuStatus>(lists.check.length ? 'check' : lists.choose.length ? 'choose' : 'linked');
  // Hide an empty "Rejected" tab (most days) so there are fewer choices.
  const tabs = ORDER.filter((s) => s !== 'rejected' || counts.rejected > 0 || filter === 'rejected');

  const q = query.trim().toLowerCase();
  const shownSkus = useMemo(() => {
    if (filter === 'formOnly') return [];
    return lists[filter].filter((r) => {
      const it = r.linked ?? r.suggestion;
      return !q || r.name.toLowerCase().includes(q) || r.skuCode.includes(q) || (it ? `${it.itemCode} ${itemText(it)}`.toLowerCase().includes(q) : false);
    });
  }, [lists, filter, q]);
  const shownItems = useMemo(
    () => (filter === 'formOnly' ? data.unlinkedItems.filter((i) => !q || `${i.itemCode} ${itemText(i)}`.toLowerCase().includes(q)) : []),
    [data.unlinkedItems, filter, q],
  );
  const total = filter === 'formOnly' ? shownItems.length : shownSkus.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(page, pageCount);
  const from = (safePage - 1) * size;
  const slice = <T,>(xs: T[]) => xs.slice(from, from + size);

  const act: Act = (key, fn, okText, onOk) => {
    setBusy(key);
    setNotice(null);
    start(async () => {
      const res = await fn();
      setBusy(null);
      if (res.ok) {
        setNotice({kind: 'ok', text: okText});
        onOk?.();
        router.refresh();
      } else setNotice({kind: 'err', text: res.error});
    });
  };

  const t = data.totals;
  // Every Watsons SKU in the files, so the tabs add up: the ones with no units sold in the
  // whole window (listed by Watsons, never sold) have nothing to decide and aren't in a tab.
  const allSkus = data.rows.length;
  const noSales = allSkus - counts.check - counts.choose - counts.rejected - counts.linked;
  // Our side is a second list, so it gets its own total: every form item is either linked
  // (the same 210 pairs) or has no Watsons code yet. Many of those are the items Coop
  // suggested for "to check" SKUs, which is why the tab counts can't simply be added up.
  const formItems = counts.linked + counts.formOnly;
  const suggestedItems = useMemo(() => new Set(lists.check.map((r) => r.suggestion?.itemCode).filter(Boolean)), [lists.check]);
  const formOnlySuggested = data.unlinkedItems.filter((i) => suggestedItems.has(i.itemCode)).length;
  const linkedPct = pct(t.linkedUnits, t.units);
  const suggestedPct = pct(t.suggestedUnits, t.units);
  const pick = (s: SkuStatus) => {
    setFilter(s);
    setPage(1);
  };
  const tag = SKU_TAGS[filter];
  const TabIcon = TAB_ICON[filter];

  return (
    <div className={GL_PAGE}>
      <header className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex max-w-2xl flex-col gap-1.5 lg:pt-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">SKU linking</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">Match each Watsons SKU to our item. A SKU&apos;s Watsons sales count for the item only once it is linked.</p>
        </div>
        <div className="flex w-full shrink-0 flex-col gap-3 rounded-xl border bg-card px-5 py-4 lg:w-[30rem]">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              <span className="font-heading text-2xl font-semibold text-foreground tabular-nums">{linkedPct}%</span> of Watsons units linked
            </p>
          </div>
          <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className="rounded-full" style={{width: `${linkedPct}%`, background: 'var(--status-good)'}} />
            <div className="rounded-full" style={{width: `${suggestedPct}%`, background: 'var(--status-warn)'}} />
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
            <li className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full" style={{background: 'var(--status-good)'}} aria-hidden /> Linked {linkedPct}%
            </li>
            <li className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full" style={{background: 'var(--status-warn)'}} aria-hidden /> Waiting on a decision {suggestedPct}%
            </li>
            <li className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-muted-foreground/40" aria-hidden /> Not matched {Math.max(0, Math.round((100 - linkedPct - suggestedPct) * 10) / 10)}%
            </li>
          </ul>
          <div className="flex flex-col gap-3 border-t pt-3">
            <div className="flex flex-col gap-1">
            <p className="text-sm">
              <span className="font-semibold tabular-nums">{n(allSkus)}</span> <span className="text-muted-foreground">Watsons SKUs in all</span>
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground tabular-nums">
              {[
                `${n(counts.linked)} linked`,
                `${n(counts.check)} to check`,
                `${n(counts.choose)} to choose`,
                counts.rejected > 0 && `${n(counts.rejected)} rejected`,
                noSales > 0 && `${n(noSales)} with no units sold`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-sm">
                <span className="font-semibold tabular-nums">{n(formItems)}</span> <span className="text-muted-foreground">items on our forms</span>
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground tabular-nums">
                {n(counts.linked)} linked (the same pairs) · {n(counts.formOnly)} without a Watsons SKU
                {formOnlySuggested > 0 ? `, ${n(formOnlySuggested)} of them Coop's matches to check` : ''}
              </p>
            </div>
          </div>
        </div>
      </header>

      <div className="flex flex-col gap-4">
        <div className={cn('border-b', GL_SCROLL_ROW_MOBILE)}>
          <div role="tablist" aria-label="Show" className="-mb-px flex gap-1">
            {tabs.map((s) => {
              const on = filter === s;
              return (
                <Fragment key={s}>
                {/* The last tab lists our items, not Watsons SKUs: set apart so its count isn't read as part of the others. */}
                {s === 'formOnly' && <span aria-hidden className="mx-2 my-2.5 w-px shrink-0 bg-border" />}
                <button
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => pick(s)}
                  className={cn(
                    'inline-flex h-10 items-center gap-2 border-b-2 px-3 text-sm whitespace-nowrap transition-colors duration-150',
                    on ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  <span className="size-1.5 rounded-full" style={{background: toneVar(SKU_TAGS[s].tone)}} aria-hidden />
                  {TAB[s]}
                  <span className={cn('rounded-full px-1.5 text-xs tabular-nums', on ? 'bg-foreground/10' : 'bg-muted')}>{counts[s]}</span>
                </button>
                </Fragment>
              );
            })}
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-xl px-4 py-3" style={{background: tint(tag.tone, 8)}}>
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full" style={{background: tint(tag.tone, 18), color: toneVar(tag.tone)}}>
            <TabIcon aria-hidden className="size-3.5" />
          </span>
          <p className="text-sm leading-relaxed">
            <span className="font-medium">{tag.label}.</span> <span className="text-muted-foreground">{tag.help}</span>
          </p>
        </div>
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
            {n(total)} {filter === 'formOnly' ? 'items' : 'Watsons SKUs'}
            {filter !== 'formOnly' ? ', biggest sellers first' : ''}
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
      ) : filter === 'formOnly' ? (
        <div className="overflow-hidden rounded-xl border">
          <div className={cn('hidden gap-8 border-b px-6 py-3 text-xs font-medium text-muted-foreground md:grid', ITEM_COLS)}>
            <span>Item on our form</span>
            <span>Product line</span>
            <span className="text-right">Price</span>
          </div>
          <ul className="divide-y">
            {slice(shownItems).map((i) => (
              <li key={i.itemCode} className={cn('grid gap-1.5 px-6 py-4 transition-colors duration-150 hover:bg-muted/30 md:items-center md:gap-8', ITEM_COLS)}>
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="truncate text-sm" title={itemText(i)}>
                    {itemText(i)}
                  </p>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="tabular-nums">{i.itemCode}</span>
                    <span aria-hidden>·</span>
                    <FormSpotLink spot={i.formSpot} onClick={() => showForm(i.itemCode, i.formSpot)} />
                  </p>
                </div>
                <span className="truncate text-sm text-muted-foreground">{i.productLine ?? 'Other'}</span>
                <span className="text-sm tabular-nums md:text-right">{i.price != null ? `₱${n(i.price)}` : '—'}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <div className={cn('hidden gap-8 border-b px-6 py-3 text-xs font-medium text-muted-foreground lg:grid', COLS)}>
            <span>Watsons SKU</span>
            <span>Our item</span>
            <span className="text-right">Price</span>
            <span>{canEdit ? 'Your decision' : 'Decision'}</span>
          </div>
          <ul className="divide-y">
            {slice(shownSkus).map((r) => (
              <SkuRow key={r.skuCode} r={r} company={company} canEdit={canEdit} items={data.unlinkedItems} disabled={pending} busy={busy === r.skuCode} act={act} onShowForm={showForm} />
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

const EMPTY: Record<SkuStatus, string> = {
  check: 'No matches waiting. Everything Coop suggested has been decided.',
  choose: 'Every Watsons SKU with sales has a link or a suggestion.',
  rejected: 'No rejected matches waiting for an item.',
  linked: 'No links yet.',
  formOnly: 'Every item on our forms has a Watsons SKU.',
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

function SkuRow({
  r,
  company,
  canEdit,
  items,
  disabled,
  busy,
  act,
  onShowForm,
}: {
  r: SkuLinkRow;
  company: string;
  canEdit: boolean;
  items: SkuLinkItem[];
  disabled: boolean;
  busy: boolean;
  act: Act;
  onShowForm: (itemCode: string, spot: FormSpot | null) => void;
}) {
  const status = skuStatus(r);
  const [remark, setRemark] = useState('');
  const [item, setItem] = useState('');
  const [open, setOpen] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const shown = r.linked ?? r.suggestion;
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
      <div className={cn('grid gap-x-8 gap-y-3 px-6 py-4 transition-colors duration-150 hover:bg-muted/30 lg:items-center', COLS, open && 'bg-muted/30')}>
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
          {canEdit && status === 'check' && r.suggestion && (
            <>
              <Button
                size="sm"
                disabled={disabled}
                onClick={() =>
                  act(
                    sku,
                    () =>
                      approveSuggestionAction({
                        company,
                        sku,
                        item: r.suggestion!.itemCode,
                        remark,
                      }),
                    `Approved. ${sku} is now linked to ${r.suggestion!.itemCode}.`,
                    done,
                  )
                }
              >
                <Check className="size-3.5" /> {busy ? 'Saving…' : 'Approve'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() =>
                  act(
                    sku,
                    () =>
                      rejectSuggestionAction({
                        company,
                        sku,
                        item: r.suggestion!.itemCode,
                        remark,
                      }),
                    `Rejected. Coop won't suggest ${r.suggestion!.itemCode} for ${sku} again.`,
                    done,
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
          {canEdit && choosing && (
            <Button size="sm" variant={open ? 'secondary' : 'default'} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              <Link2 className="size-3.5" /> Choose item
            </Button>
          )}
          {canEdit && status === 'linked' && (
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
          {note && !open && (
            <p className="flex w-full min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={note}>
              <MessageSquare className="size-3 shrink-0" />
              <span className="truncate">{note}</span>
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
                <Button size="sm" disabled={disabled || !item} onClick={() => act(sku, () => linkSkuAction({company, sku, item, remark}), `Linked ${sku} to ${item}.`, done)}>
                  <Link2 className="size-3.5" /> {busy ? 'Saving…' : 'Link'}
                </Button>
              )}
              {status === 'linked' &&
                (unlinking ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={disabled}
                    onClick={() => act(sku, () => unlinkSkuAction({company, sku, remark}), `Unlinked ${sku}. Coop won't match it to ${r.linked!.itemCode} again.`, done)}
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
                  onClick={() => act(sku, () => saveRemarkAction({company, sku, remark}), 'Remark saved.', done)}
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
