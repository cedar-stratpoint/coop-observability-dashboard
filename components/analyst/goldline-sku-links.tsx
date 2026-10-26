'use client';

import {useMemo, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {Check, Link2, Search, Unlink, X} from 'lucide-react';
import type {SkuLinkData, SkuLinkItem, SkuLinkRow} from '@/src/goldline-sku-links-data';
import {dismissSuggestionAction, linkSkuAction, unlinkSkuAction} from '@/app/stock/skus/actions';
import {Card, CardContent} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {NativeSelect} from '@/components/ui/native-select';
import {Pagination} from '@/components/analyst/pagination';
import {GL_SCROLL_ROW_MOBILE, GL_TILES_MOBILE} from '@/src/goldline-ui';
import {cn} from '@/lib/utils';

// Watsons SKU links: which Watsons SKU code is which Nichido item. Three lists, biggest
// sellers first: suggestions to confirm, SKUs with no match (pick an item), and links
// already made (with where they came from). Sales only count in the stock checks once
// their SKU is linked, so the summary shows the share of units covered.

type Filter = 'confirm' | 'unmatched' | 'linked';
const PAGE_SIZE = 15;
const n = (v: number) => Math.round(v).toLocaleString('en-US');
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

const SOURCE: Record<string, string> = {code: 'Code in name', match: 'Matched', admin: 'By an admin'};

/** "Line · shade", dropping the words the catalog's shade repeats from the line
 *  ("Lip and Cheek Tint Beach Glow" under "Lip and Cheek Tint Paraben-Free" → "Beach Glow"). */
function itemText(i: SkuLinkItem) {
  const line = (i.productLine ?? '').trim();
  const words = (i.variant ?? '').trim().split(/\s+/).filter(Boolean);
  const lineWords = line.toLowerCase().split(/\s+/);
  let k = 0;
  while (k < words.length - 1 && k < lineWords.length && words[k].toLowerCase() === lineWords[k]) k++;
  const shade = words.slice(k).join(' ');
  return [line, shade].filter(Boolean).join(' · ') || i.itemCode;
}

export function GoldlineSkuLinks({company, data, canEdit}: {company: string; data: SkuLinkData; canEdit: boolean}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{kind: 'ok' | 'err'; text: string} | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const lists = useMemo(() => {
    const withSales = data.rows.filter((r) => r.units > 0 || r.linked);
    return {
      confirm: withSales.filter((r) => !r.linked && r.suggestion),
      unmatched: withSales.filter((r) => !r.linked && !r.suggestion),
      linked: withSales.filter((r) => r.linked),
    };
  }, [data.rows]);
  const [filter, setFilter] = useState<Filter>(lists.confirm.length ? 'confirm' : 'unmatched');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lists[filter].filter(
      (r) => !q || r.name.toLowerCase().includes(q) || r.skuCode.includes(q) || (r.linked?.itemCode ?? r.suggestion?.itemCode ?? '').toLowerCase().includes(q),
    );
  }, [lists, filter, query]);
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = shown.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Unlinked catalog items, grouped by product line for the manual picker.
  const groups = useMemo(() => {
    const g = new Map<string, SkuLinkItem[]>();
    for (const i of data.unlinkedItems) {
      const k = i.productLine?.trim() || 'Other';
      g.set(k, [...(g.get(k) ?? []), i]);
    }
    return [...g.entries()];
  }, [data.unlinkedItems]);

  function act(key: string, fn: () => Promise<{ok: true} | {ok: false; error: string}>, okText: string) {
    setBusy(key);
    setNotice(null);
    start(async () => {
      const res = await fn();
      setBusy(null);
      if (res.ok) {
        setNotice({kind: 'ok', text: okText});
        router.refresh();
      } else setNotice({kind: 'err', text: res.error});
    });
  }

  const t = data.totals;
  const linkedPct = pct(t.linkedUnits, t.units);
  const suggestedPct = pct(t.suggestedUnits, t.units);
  const chips: Array<{value: Filter; label: string; n: number}> = [
    {value: 'confirm', label: 'To confirm', n: lists.confirm.length},
    {value: 'unmatched', label: 'No match', n: lists.unmatched.length},
    {value: 'linked', label: 'Linked', n: lists.linked.length},
  ];

  return (
    <div className={cn('mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6', GL_TILES_MOBILE)}>
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">Watsons SKU links</h1>
        <p className="text-sm text-muted-foreground">
          Which Watsons SKU code is which Nichido item. A SKU&apos;s sales only count in the stock checks once it&apos;s linked.
        </p>
      </header>

      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <p className="text-sm">
              <span className="font-heading text-2xl font-semibold tabular-nums">{linkedPct}%</span>{' '}
              <span className="text-muted-foreground">of units sold are on linked SKUs</span>
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {n(t.linkedUnits)} of {n(t.units)} units · {suggestedPct}% more waiting to confirm
            </p>
          </div>
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
            <div style={{width: `${linkedPct}%`, background: 'var(--status-good)'}} />
            <div style={{width: `${suggestedPct}%`, background: 'var(--status-warn)'}} />
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className={GL_SCROLL_ROW_MOBILE}>
          <div role="group" aria-label="Show" className="flex gap-2">
            {chips.map((c) => (
              <button
                key={c.value}
                type="button"
                aria-pressed={filter === c.value}
                onClick={() => {
                  setFilter(c.value);
                  setPage(1);
                }}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-[background-color,border-color,transform] duration-150 ease-out active:scale-[0.97]',
                  filter === c.value ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:border-foreground/30',
                )}
              >
                {c.label} <span className="tabular-nums opacity-80">{c.n}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Search name or code…"
            aria-label="Search name or code"
            className="h-8 w-56 rounded-md border border-border bg-background pr-2.5 pl-8 text-sm outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
          />
        </div>
      </div>

      {notice && (
        <p role="status" className={cn('text-sm', notice.kind === 'ok' ? 'text-muted-foreground' : 'text-destructive')}>
          {notice.text}
        </p>
      )}

      {pageRows.length === 0 ? (
        <Card>
          <CardContent className="px-6 py-10 text-center text-sm text-muted-foreground">
            {query ? 'Nothing matches that search.' : filter === 'confirm' ? 'Nothing waiting to confirm.' : filter === 'unmatched' ? 'Every Watsons SKU with sales has a link or a suggestion.' : 'No links yet.'}
          </CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {pageRows.map((r) => (
            <li key={r.skuCode}>
              <Card className="py-0">
                <CardContent className="flex flex-col gap-3 px-4 py-3.5 md:flex-row md:items-center md:justify-between md:gap-6">
                  <SkuSide r={r} />
                  <div className="flex min-w-0 flex-col gap-2 md:w-[46%] md:shrink-0">
                    {filter === 'confirm' && r.suggestion && (
                      <>
                        <ItemLine label={r.suggestion.tier === 'low' ? 'A guess' : 'Likely'} tone={r.suggestion.tier === 'low' ? 'crit' : 'warn'} item={r.suggestion} />
                        {canEdit && (
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              disabled={pending}
                              onClick={() => act(r.skuCode, () => linkSkuAction({company, sku: r.skuCode, item: r.suggestion!.itemCode}), `Linked ${r.skuCode} to ${r.suggestion!.itemCode}.`)}
                            >
                              <Check className="size-3.5" /> {busy === r.skuCode ? 'Linking…' : 'Confirm'}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={pending}
                              onClick={() => act(r.skuCode, () => dismissSuggestionAction({company, sku: r.skuCode}), `Turned down. Looked for another match for ${r.skuCode}.`)}
                            >
                              <X className="size-3.5" /> Not this
                            </Button>
                          </div>
                        )}
                      </>
                    )}
                    {filter === 'unmatched' && canEdit && <ManualPick r={r} groups={groups} disabled={pending} onLink={(item) => act(r.skuCode, () => linkSkuAction({company, sku: r.skuCode, item}), `Linked ${r.skuCode} to ${item}.`)} />}
                    {filter === 'unmatched' && !canEdit && <p className="text-sm text-muted-foreground">Not linked yet.</p>}
                    {filter === 'linked' && r.linked && (
                      <div className="flex items-center justify-between gap-3">
                        <ItemLine label={SOURCE[r.linked.source ?? ''] ?? 'Linked'} tone="good" item={r.linked} />
                        {canEdit && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending}
                            aria-label={`Unlink ${r.skuCode}`}
                            onClick={() => act(r.skuCode, () => unlinkSkuAction({company, sku: r.skuCode}), `Unlinked ${r.skuCode}. It won't be matched to ${r.linked!.itemCode} again.`)}
                          >
                            <Unlink className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Pagination page={safePage} pageCount={pageCount} onPage={setPage} label="SKU pages" />
    </div>
  );
}

function SkuSide({r}: {r: SkuLinkRow}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="truncate text-sm font-medium" title={r.name}>
        {r.name}
      </p>
      <p className="font-mono text-[11px] text-muted-foreground tabular-nums">
        {r.skuCode} · {n(r.units)} units{r.avgPrice != null ? ` · ₱${n(r.avgPrice)} avg` : ''}
        {r.subclass ? ` · ${r.subclass.toLowerCase()}` : ''}
      </p>
    </div>
  );
}

function ItemLine({label, tone, item}: {label: string; tone: 'good' | 'warn' | 'crit'; item: SkuLinkItem}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <p className="flex items-center gap-2 text-xs">
        <span
          className="rounded-full px-2 py-0.5 font-medium"
          style={{color: `var(--status-${tone})`, background: `color-mix(in oklab, var(--status-${tone}) 14%, transparent)`}}
        >
          {label}
        </span>
        <span className="font-mono text-muted-foreground">{item.itemCode}</span>
      </p>
      <p className="truncate text-sm" title={itemText(item)}>
        {itemText(item)}
        {item.price != null && <span className="text-muted-foreground tabular-nums"> · ₱{n(item.price)}</span>}
      </p>
    </div>
  );
}

function ManualPick({r, groups, disabled, onLink}: {r: SkuLinkRow; groups: Array<[string, SkuLinkItem[]]>; disabled: boolean; onLink: (item: string) => void}) {
  const [item, setItem] = useState('');
  return (
    <div className="flex gap-2">
      <NativeSelect aria-label={`Item for ${r.skuCode}`} value={item} onChange={(e) => setItem(e.target.value)} wrapperClassName="min-w-0 flex-1">
        <option value="">Pick the Nichido item…</option>
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
      <Button size="sm" disabled={disabled || !item} onClick={() => onLink(item)}>
        <Link2 className="size-3.5" /> Link
      </Button>
    </div>
  );
}
