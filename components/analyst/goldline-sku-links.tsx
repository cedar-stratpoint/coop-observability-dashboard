'use client';

import {useMemo, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {Check, Link2, MessageSquare, Search, Unlink, X} from 'lucide-react';
import type {SkuLinkData, SkuLinkItem, SkuLinkRow} from '@/src/goldline-sku-links-data';
import {approveSuggestionAction, linkSkuAction, rejectSuggestionAction, saveRemarkAction, unlinkSkuAction} from '@/app/stock/skus/actions';
import {ACTION_WORD, linkedHow, SKU_TAGS, skuStatus, sureness, type SkuStatus, type Tone} from '@/src/goldline-sku-tags';
import {Card, CardContent} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {NativeSelect} from '@/components/ui/native-select';
import {Pagination} from '@/components/analyst/pagination';
import {GL_PAGE, GL_SCROLL_ROW_MOBILE} from '@/src/goldline-ui';
import {cn} from '@/lib/utils';
import {itemDisplayName} from '@/src/goldline-item-name';

// SKU linking (Oct 27): which Watsons SKU code is which Nichido item. Five plain-language
// tags double as the filters. Coop's suggestions get Approve / Reject; SKUs with no match
// get a picker; links can be undone. Every decision takes an optional remark, and each
// SKU shows its latest one. Sales only count in the stock checks once a SKU is linked.

const PAGE_SIZE = 25;
const REMARK_MAX = 500;
const ORDER: SkuStatus[] = ['check', 'choose', 'rejected', 'linked', 'formOnly'];
const n = (v: number) => Math.round(v).toLocaleString('en-US');
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila'}) : '';
const itemText = (i: SkuLinkItem) => itemDisplayName(i.productLine, i.variant, i.itemCode);
// 'info' has no status token: it uses the muted text colour.
const toneVar = (t: Tone) => (t === 'info' ? 'var(--muted-foreground)' : `var(--status-${t})`);
const toneStyle = (t: Tone) => ({color: toneVar(t), background: `color-mix(in oklab, ${toneVar(t)} 14%, transparent)`});

type Act = (key: string, fn: () => Promise<{ok: true} | {ok: false; error: string}>, okText: string, onOk?: () => void) => void;

export function GoldlineSkuLinks({company, data, canEdit}: {company: string; data: SkuLinkData; canEdit: boolean}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{kind: 'ok' | 'err'; text: string} | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const lists = useMemo(() => {
    const out: Record<Exclude<SkuStatus, 'formOnly'>, SkuLinkRow[]> = {check: [], choose: [], rejected: [], linked: []};
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

  const q = query.trim().toLowerCase();
  const shownSkus = useMemo(() => {
    if (filter === 'formOnly') return [];
    return lists[filter].filter(
      (r) => !q || r.name.toLowerCase().includes(q) || r.skuCode.includes(q) || (r.linked?.itemCode ?? r.suggestion?.itemCode ?? '').toLowerCase().includes(q),
    );
  }, [lists, filter, q]);
  const shownItems = useMemo(
    () => (filter === 'formOnly' ? data.unlinkedItems.filter((i) => !q || i.itemCode.toLowerCase().includes(q) || itemText(i).toLowerCase().includes(q)) : []),
    [data.unlinkedItems, filter, q],
  );
  const total = filter === 'formOnly' ? shownItems.length : shownSkus.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const slice = <T,>(xs: T[]) => xs.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

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

  return (
    <div className={GL_PAGE}>
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">SKU linking</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Which Watsons SKU code is which of our items. A SKU&apos;s Watsons sales only count for an item once they are linked, so the stock checks and restock depend on it.
        </p>
      </header>

      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <p className="text-sm">
              <span className="font-heading text-2xl font-semibold tabular-nums">{linkedPct}%</span>{' '}
              <span className="text-muted-foreground">of units sold at Watsons are on linked SKUs</span>
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {n(t.linkedUnits)} of {n(t.units)} units · {suggestedPct}% more if Coop&apos;s matches are approved
            </p>
          </div>
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
            <div style={{width: `${linkedPct}%`, background: 'var(--status-good)'}} />
            <div style={{width: `${suggestedPct}%`, background: 'var(--status-warn)'}} />
          </div>
        </CardContent>
      </Card>

      <div className={GL_SCROLL_ROW_MOBILE}>
        <div role="group" aria-label="Show" className="grid w-full gap-2.5 max-md:flex sm:grid-cols-2 lg:grid-cols-5">
          {ORDER.map((s) => {
            const tag = SKU_TAGS[s];
            const on = filter === s;
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                onClick={() => pick(s)}
                className={cn(
                  'flex flex-col items-start gap-1.5 rounded-xl border px-4 py-3 text-left transition-[background-color,border-color,transform] duration-150 ease-out active:scale-[0.98] max-md:w-64 max-md:shrink-0',
                  on ? 'border-primary bg-primary/[0.06] ring-1 ring-primary' : 'border-border hover:border-foreground/30',
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="size-2 rounded-full" style={{background: toneVar(tag.tone)}} aria-hidden />
                  <span className="font-heading text-xl font-semibold tabular-nums">{counts[s]}</span>
                </span>
                <span className="text-sm leading-snug font-medium">{tag.label}</span>
                <span className="text-xs leading-snug text-muted-foreground max-md:whitespace-normal">{tag.help}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {total === 0 ? 'Nothing to show' : `${n(total)} ${filter === 'formOnly' ? 'items' : 'Watsons SKUs'}`}
          {filter !== 'formOnly' && total > 0 ? ', biggest sellers first' : ''}
        </p>
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
            className="h-8 w-64 rounded-md border border-border bg-background pr-2.5 pl-8 text-sm outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 max-md:w-full"
          />
        </div>
      </div>

      {notice && (
        <p role="status" className={cn('text-sm', notice.kind === 'ok' ? 'text-muted-foreground' : 'text-destructive')}>
          {notice.text}
        </p>
      )}

      {total === 0 ? (
        <Card>
          <CardContent className="px-6 py-10 text-center text-sm text-muted-foreground">{query ? 'Nothing matches that search.' : EMPTY[filter]}</CardContent>
        </Card>
      ) : filter === 'formOnly' ? (
        <Card className="py-0">
          <div className="hidden grid-cols-[8rem_minmax(0,1fr)_minmax(0,14rem)_6rem] gap-6 border-b px-5 py-2.5 text-xs font-medium text-muted-foreground md:grid">
            <span>Item code</span>
            <span>Item</span>
            <span>Product line</span>
            <span className="text-right">Price</span>
          </div>
          <ul className="divide-y">
            {slice(shownItems).map((i) => (
              <li key={i.itemCode} className="grid gap-1 px-5 py-3 md:grid-cols-[8rem_minmax(0,1fr)_minmax(0,14rem)_6rem] md:items-center md:gap-6">
                <span className="font-mono text-xs text-muted-foreground">{i.itemCode}</span>
                <span className="truncate text-sm" title={itemText(i)}>
                  {itemText(i)}
                </span>
                <span className="truncate text-sm text-muted-foreground">{i.productLine ?? 'Other'}</span>
                <span className="text-sm tabular-nums md:text-right">{i.price != null ? `₱${n(i.price)}` : '—'}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <Card className="py-0">
          <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,24rem)] gap-6 border-b px-5 py-2.5 text-xs font-medium text-muted-foreground lg:grid">
            <span>Watsons SKU</span>
            <span>Our item</span>
            <span>{canEdit ? 'Your decision' : 'Decision'}</span>
          </div>
          <ul className="divide-y">
            {slice(shownSkus).map((r) => (
              <SkuRow key={r.skuCode} r={r} company={company} canEdit={canEdit} groups={groups} disabled={pending} busy={busy === r.skuCode} act={act} />
            ))}
          </ul>
        </Card>
      )}

      <Pagination page={safePage} pageCount={pageCount} onPage={setPage} label="SKU pages" />
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
  const tag = SKU_TAGS[status];
  const [remark, setRemark] = useState('');
  const [item, setItem] = useState('');
  const [open, setOpen] = useState<'remark' | 'unlink' | null>(null);
  const shownItem = r.linked ?? r.suggestion;
  const sku = r.skuCode;
  const done = () => {
    setRemark('');
    setItem('');
    setOpen(null);
  };

  return (
    <li className="grid gap-4 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,24rem)] lg:gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-medium [overflow-wrap:anywhere]" title={r.name}>
          {r.name}
        </p>
        <p className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {sku} · {n(r.units)} units{r.avgPrice != null ? ` · ₱${n(r.avgPrice)} avg` : ''}
          {r.subclass ? ` · ${r.subclass.toLowerCase()}` : ''}
        </p>
      </div>

      <div className="flex min-w-0 flex-col items-start gap-1.5">
        <span className="rounded-full px-2.5 py-0.5 text-xs font-medium" style={toneStyle(tag.tone)}>
          {tag.label}
        </span>
        {shownItem ? (
          <>
            <p className="text-sm [overflow-wrap:anywhere]">
              <span className="font-mono text-xs text-muted-foreground">{shownItem.itemCode}</span> {itemText(shownItem)}
              {shownItem.price != null && <span className="text-muted-foreground tabular-nums"> · ₱{n(shownItem.price)}</span>}
            </p>
            <p className="text-xs text-muted-foreground">{r.linked ? linkedHow(r) : r.suggestion ? sureness(r.suggestion.tier) : ''}</p>
          </>
        ) : status === 'rejected' && r.review?.itemCode ? (
          <p className="text-xs text-muted-foreground">
            Coop suggested <span className="font-mono">{r.review.itemCode}</span>. Coop has no other match.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">No item yet.</p>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-2.5">
        {canEdit && status === 'check' && r.suggestion && (
          <>
            <RemarkBox sku={sku} value={remark} onChange={setRemark} />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={disabled}
                onClick={() =>
                  act(sku, () => approveSuggestionAction({company, sku, item: r.suggestion!.itemCode, remark}), `Approved. ${sku} is now linked to ${r.suggestion!.itemCode}.`, done)
                }
              >
                <Check className="size-3.5" /> {busy ? 'Saving…' : 'Approve'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() =>
                  act(sku, () => rejectSuggestionAction({company, sku, item: r.suggestion!.itemCode, remark}), `Rejected. Coop won't suggest ${r.suggestion!.itemCode} for ${sku} again.`, done)
                }
              >
                <X className="size-3.5" /> Reject
              </Button>
            </div>
          </>
        )}

        {canEdit && (status === 'choose' || status === 'rejected') && (
          <>
            <NativeSelect aria-label={`Item for ${sku}`} value={item} onChange={(e) => setItem(e.target.value)} wrapperClassName="min-w-0">
              <option value="">Choose our item…</option>
              {groups.map(([line, items]) => (
                <optgroup key={line} label={line}>
                  {items.map((i) => (
                    <option key={i.itemCode} value={i.itemCode}>
                      {i.itemCode} · {itemText(i)}
                      {i.price != null ? ` · ₱${n(i.price)}` : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </NativeSelect>
            <RemarkBox sku={sku} value={remark} onChange={setRemark} />
            <div className="flex gap-2">
              <Button size="sm" disabled={disabled || !item} onClick={() => act(sku, () => linkSkuAction({company, sku, item, remark}), `Linked ${sku} to ${item}.`, done)}>
                <Link2 className="size-3.5" /> {busy ? 'Saving…' : 'Link'}
              </Button>
              {remark.trim() && (
                <Button size="sm" variant="outline" disabled={disabled} onClick={() => act(sku, () => saveRemarkAction({company, sku, remark}), 'Remark saved.', done)}>
                  Save remark only
                </Button>
              )}
            </div>
          </>
        )}

        {canEdit && status === 'linked' && (
          <>
            {open ? (
              <>
                <RemarkBox sku={sku} value={remark} onChange={setRemark} autoFocus label={open === 'unlink' ? 'Why unlink? (optional)' : 'Remark'} />
                <div className="flex gap-2">
                  {open === 'unlink' ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={disabled}
                      onClick={() => act(sku, () => unlinkSkuAction({company, sku, remark}), `Unlinked ${sku}. Coop won't match it to ${r.linked!.itemCode} again.`, done)}
                    >
                      <Unlink className="size-3.5" /> {busy ? 'Saving…' : 'Unlink'}
                    </Button>
                  ) : (
                    <Button size="sm" disabled={disabled || !remark.trim()} onClick={() => act(sku, () => saveRemarkAction({company, sku, remark}), 'Remark saved.', done)}>
                      {busy ? 'Saving…' : 'Save remark'}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setOpen(null)}>
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setOpen('remark')}>
                  <MessageSquare className="size-3.5" /> {r.review?.remark ? 'Edit remark' : 'Add remark'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setOpen('unlink')}>
                  <Unlink className="size-3.5" /> Unlink
                </Button>
              </div>
            )}
          </>
        )}

        <ReviewNote r={r} />
      </div>
    </li>
  );
}

function RemarkBox({sku, value, onChange, autoFocus, label = 'Remarks (optional)'}: {sku: string; value: string; onChange: (v: string) => void; autoFocus?: boolean; label?: string}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      maxLength={REMARK_MAX}
      rows={2}
      autoFocus={autoFocus}
      placeholder={label}
      aria-label={`${label} for ${sku}`}
      className="min-h-14 w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none transition-colors placeholder:text-muted-foreground hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
    />
  );
}

/** The latest decision and the latest remark, with who and when. */
function ReviewNote({r}: {r: SkuLinkRow}) {
  const v = r.review;
  if (!v || (!v.action && !v.remark)) return null;
  return (
    <div className="flex flex-col gap-1 rounded-md bg-muted/60 px-3 py-2 text-xs">
      {v.action && (
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">{ACTION_WORD[v.action]}</span>
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
