'use client';

import {useEffect, useMemo, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {Check, ChevronDown, Link2, MessageSquare, Search, Unlink, X} from 'lucide-react';
import type {SkuLinkData, SkuLinkItem, SkuLinkRow} from '@/src/goldline-sku-links-data';
import {approveSuggestionAction, linkSkuAction, rejectSuggestionAction, saveRemarkAction, unlinkSkuAction} from '@/app/stock/skus/actions';
import {ACTION_WORD, formSpotText, linkedHow, SKU_TAGS, skuStatus, sureness, type SkuStatus, type Tone} from '@/src/goldline-sku-tags';
import {Button} from '@/components/ui/button';
import {NativeSelect} from '@/components/ui/native-select';
import {Pagination} from '@/components/analyst/pagination';
import {GL_PAGE, GL_SCROLL_ROW_MOBILE} from '@/src/goldline-ui';
import {cn} from '@/lib/utils';
import {itemDisplayName} from '@/src/goldline-item-name';

// SKU linking (Oct 27): which Watsons SKU code is which Nichido item.
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
const COLS = 'lg:grid-cols-[minmax(0,1.25fr)_5rem_minmax(0,1.25fr)_7.5rem_8.5rem_minmax(13rem,15rem)]';
const ITEM_COLS = 'md:grid-cols-[8rem_minmax(0,1fr)_minmax(0,14rem)_7.5rem_6rem]';

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

  // Unlinked catalog items, grouped by product line for the manual picker.
  const groups = useMemo(() => {
    const g = new Map<string, SkuLinkItem[]>();
    for (const i of data.unlinkedItems) {
      const k = i.productLine?.trim() || 'Other';
      g.set(k, [...(g.get(k) ?? []), i]);
    }
    return [...g.entries()];
  }, [data.unlinkedItems]);

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
  const linkedPct = pct(t.linkedUnits, t.units);
  const suggestedPct = pct(t.suggestedUnits, t.units);
  const pick = (s: SkuStatus) => {
    setFilter(s);
    setPage(1);
  };
  const tag = SKU_TAGS[filter];

  return (
    <div className={GL_PAGE}>
      <header className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight">SKU linking</h1>
          <p className="text-sm text-muted-foreground">Match each Watsons SKU to our item. Its Watsons sales count for the item only once linked.</p>
        </div>
        <div className="flex max-w-3xl flex-col gap-2">
          <p className="text-sm">
            <span className="font-heading text-lg font-semibold tabular-nums">{linkedPct}%</span>{' '}
            <span className="text-muted-foreground">of Watsons units are on linked SKUs · {suggestedPct}% more if Coop&apos;s matches are approved</span>
          </p>
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
            <div
              style={{
                width: `${linkedPct}%`,
                background: 'var(--status-good)',
              }}
            />
            <div
              style={{
                width: `${suggestedPct}%`,
                background: 'var(--status-warn)',
              }}
            />
          </div>
        </div>
      </header>

      <div className="flex flex-col gap-3">
        <div className={cn('border-b', GL_SCROLL_ROW_MOBILE)}>
          <div role="tablist" aria-label="Show" className="-mb-px flex gap-1">
            {tabs.map((s) => {
              const on = filter === s;
              return (
                <button
                  key={s}
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
              );
            })}
          </div>
        </div>
        <p className="text-sm">
          <span className="font-medium">{tag.label}.</span> <span className="text-muted-foreground">{tag.help}</span>
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
        <RowsPerPage value={size} onChange={changeSize} />
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
          <div className={cn('hidden gap-6 border-b bg-muted/40 px-5 py-2.5 text-xs font-medium text-muted-foreground md:grid', ITEM_COLS)}>
            <span>Item code</span>
            <span>Item</span>
            <span>Product line</span>
            <span>Form page</span>
            <span className="text-right">Price</span>
          </div>
          <ul className="divide-y">
            {slice(shownItems).map((i) => (
              <li key={i.itemCode} className={cn('grid gap-1 px-5 py-3 md:items-center md:gap-6', ITEM_COLS)}>
                <span className="font-mono text-xs text-muted-foreground">{i.itemCode}</span>
                <span className="truncate text-sm" title={itemText(i)}>
                  {itemText(i)}
                </span>
                <span className="truncate text-sm text-muted-foreground">{i.productLine ?? 'Other'}</span>
                <span className="text-sm tabular-nums">{formSpotText(i.formSpot)}</span>
                <span className="text-sm tabular-nums md:text-right">{i.price != null ? `₱${n(i.price)}` : '—'}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <div className={cn('hidden gap-5 border-b bg-muted/40 px-5 py-2.5 text-xs font-medium text-muted-foreground lg:grid', COLS)}>
            <span>Watsons SKU</span>
            <span className="text-right">Units sold</span>
            <span>Our item</span>
            <span>Form page</span>
            <span className="text-right whitespace-nowrap">Watsons / our price</span>
            <span>{canEdit ? 'Your decision' : 'Decision'}</span>
          </div>
          <ul className="divide-y">
            {slice(shownSkus).map((r) => (
              <SkuRow key={r.skuCode} r={r} company={company} canEdit={canEdit} groups={groups} disabled={pending} busy={busy === r.skuCode} act={act} />
            ))}
          </ul>
        </div>
      )}

      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground tabular-nums">
            {n(from + 1)} to {n(Math.min(total, from + size))} of {n(total)}
            {filter !== 'formOnly' ? ' · biggest sellers first' : ''}
          </p>
          <Pagination page={safePage} pageCount={pageCount} onPage={setPage} label="SKU pages" />
        </div>
      )}
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
      <span>Rows per page</span>
      <div className="flex rounded-md border p-0.5">
        {PAGE_SIZES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={value === s}
            onClick={() => onChange(s)}
            className={cn(
              'h-7 min-w-9 rounded px-2 tabular-nums transition-colors duration-150',
              value === s ? 'bg-foreground font-medium text-background' : 'hover:text-foreground',
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
  groups,
  disabled,
  busy,
  act,
}: {
  r: SkuLinkRow;
  company: string;
  canEdit: boolean;
  groups: Array<[string, SkuLinkItem[]]>;
  disabled: boolean;
  busy: boolean;
  act: Act;
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
  const formSpot = shown ? formSpotText(shown.formSpot) : '—';
  const priceTitle = priceOff ? 'Prices differ by more than 15%. Check it is the same product.' : undefined;
  const price = (
    <>
      {r.avgPrice != null ? `₱${n(r.avgPrice)}` : '—'}
      <span className="text-muted-foreground"> / </span>
      <span style={priceOff ? {color: 'var(--status-warn)'} : undefined}>{shown?.price != null ? `₱${n(shown.price)}` : '—'}</span>
    </>
  );

  return (
    <li>
      <div className={cn('grid gap-x-5 gap-y-2 px-5 py-3.5 lg:items-center', COLS)}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="truncate text-sm font-medium" title={r.name}>
            {r.name}
          </p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {sku}
            {r.subclass ? ` · ${r.subclass.toLowerCase()}` : ''}
          </p>
        </div>

        <p className="text-sm tabular-nums max-lg:hidden lg:text-right">{n(r.units)}</p>

        <div className="flex min-w-0 flex-col gap-0.5">
          {shown ? (
            <>
              <p className="truncate text-sm" title={itemText(shown)}>
                {itemText(shown)}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                <span className="font-mono">{shown.itemCode}</span> · {r.linked ? linkedHow(r) : r.suggestion ? sureness(r.suggestion.tier) : ''}
              </p>
            </>
          ) : status === 'rejected' && r.review?.itemCode ? (
            <p className="text-xs text-muted-foreground">
              Rejected <span className="font-mono">{r.review.itemCode}</span>. Coop has no other match.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">No item yet</p>
          )}
        </div>

        <p className="text-sm tabular-nums max-lg:hidden">{formSpot}</p>
        <p className="text-sm tabular-nums max-lg:hidden lg:text-right" title={priceTitle}>
          {price}
        </p>
        {/* Phones: units, form page and price on one line under the item. */}
        <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums lg:hidden" title={priceTitle}>
          <span>{n(r.units)} sold</span>
          <span>Form {formSpot}</span>
          <span>Watsons / ours {price}</span>
        </p>

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
            <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`Remark or unlink ${sku}`} className="text-muted-foreground">
              Remark or unlink <ChevronDown className={cn('size-3.5 transition-transform duration-150', open && 'rotate-180')} />
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
        <div className="flex flex-col gap-4 border-t bg-muted/30 px-5 py-4 lg:flex-row lg:items-start lg:gap-8">
          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            {choosing && (
              <NativeSelect aria-label={`Item for ${sku}`} value={item} onChange={(e) => setItem(e.target.value)} wrapperClassName="min-w-0 max-w-xl">
                <option value="">Choose our item…</option>
                {groups.map(([line, items]) => (
                  <optgroup key={line} label={line}>
                    {items.map((i) => (
                      <option key={i.itemCode} value={i.itemCode}>
                        {i.itemCode} · {itemText(i)}
                        {i.price != null ? ` · ₱${n(i.price)}` : ''}
                        {i.formSpot ? ` · form page ${i.formSpot.page}` : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </NativeSelect>
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
