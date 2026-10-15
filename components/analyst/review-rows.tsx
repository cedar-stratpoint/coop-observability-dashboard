'use client';

import {useMemo} from 'react';
import {Check, ChevronLeft, ChevronRight, Search} from 'lucide-react';
import type {ExtractedRow} from '@/src/goldline-extract-run';
import {bandOf, rowConfidence, toneText, type Band} from '@/src/review-confidence';
import {groupByFamily, type CatalogLite} from '@/src/review-workbench';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {SegmentedControl} from '@/components/analyst/segmented-control';
import {cn} from '@/lib/utils';

// The rows of a scan review (plan §07d). Two views:
//  • Needs review — only the flagged rows, each with "Looks right" (or edit it) to
//    resolve it; the flag navigator walks them one by one.
//  • All — the whole page as a form grid that mirrors the paper: grouped under the
//    printed family headings with their price, flagged rows still highlighted.
// Commit is gated by the parent until every flag is resolved.

export const COLS = [
  {key: 'stockroom', label: 'Stk', title: 'Bilang sa stockroom / steel cabinet'},
  {key: 'drawer', label: 'Drw', title: 'Bilang sa drawer ng module'},
  {key: 'selling_area', label: 'Sell', title: 'Bilang sa selling area'},
  {key: 'delivery', label: 'Dlv', title: 'Delivery'},
  {key: 'ending_on_hand', label: 'End', title: 'Ending inventory (stock on hand)'},
] as const;
export type ColKey = (typeof COLS)[number]['key'];

/** Full field names for the phone layout (the table uses the short form labels). */
const MOBILE_LABEL: Record<ColKey, string> = {stockroom: 'Stockroom', drawer: 'Drawer', selling_area: 'Selling', delivery: 'Delivery', ending_on_hand: 'Ending'};

/** The VISIBLE element for review row `index` — the table row on wide screens, the
 *  card on phones (both are in the page; only one is shown). */
export function reviewRowEl(index: number): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(`[data-review-row="${index}"]`);
  for (const el of all) if (el.offsetParent !== null) return el;
  return all[0] ?? null;
}
export type ReviewView = 'needs' | 'all';

const BAND_TONE: Record<Band, string> = {high: 'var(--status-good)', medium: 'var(--status-warn)', low: 'var(--status-crit)'};

type Props = {
  rows: ExtractedRow[];
  productNames: Record<string, string>;
  catalog: Record<string, CatalogLite>;
  flagged: number[]; // row indices under the threshold
  resolved: ReadonlySet<number>;
  active: number | null; // the flag the navigator is on
  view: ReviewView;
  query: string;
  onQuery: (q: string) => void;
  editable: boolean;
  onView: (v: ReviewView) => void;
  onCell: (index: number, key: ColKey, raw: string) => void;
  onResolve: (index: number) => void;
  onStep: (dir: 1 | -1) => void;
};

export function ReviewRows({
  rows,
  productNames,
  catalog,
  flagged,
  resolved,
  active,
  view,
  query,
  onQuery,
  editable,
  onView,
  onCell,
  onResolve,
  onStep,
}: Props) {
  const flaggedSet = useMemo(() => new Set(flagged), [flagged]);
  const q = query.trim().toLowerCase();
  const indexed = useMemo(() => rows.map((r, i) => ({...r, i})), [rows]);
  const matches = (r: (typeof indexed)[number]) =>
    !q || r.item_code.toLowerCase().includes(q) || (productNames[r.item_code] ?? '').toLowerCase().includes(q);
  const visible = indexed.filter((r) => (view === 'all' || flaggedSet.has(r.i)) && matches(r));
  const groups = view === 'all' ? groupByFamily(visible, catalog) : null;
  const resolvedCount = flagged.filter((i) => resolved.has(i)).length;
  const pos = active == null ? 0 : flagged.indexOf(active) + 1;

  const header = (
    <tr className="border-b border-border text-left text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
      <th className="py-2 pr-3 font-medium">Item</th>
      {COLS.map((c) => (
        <th key={c.key} className="py-2 pr-2 text-right font-medium" title={c.title}>
          {c.label}
        </th>
      ))}
      <th className="py-2 pr-2 text-right font-medium">Conf.</th>
      {editable && <th className="py-2 font-medium sr-only">Decision</th>}
    </tr>
  );

  const line = (r: (typeof indexed)[number]) => {
    const isFlag = flaggedSet.has(r.i);
    const done = resolved.has(r.i);
    const c = rowConfidence(r.confidence);
    const tone = BAND_TONE[bandOf(c)];
    return (
      <tr
        key={`${r.item_code}-${r.i}`}
        id={`review-row-${r.i}`}
        data-review-row={r.i}
        className={cn(
          'scroll-mt-24 border-b border-border/60 transition-colors',
          isFlag && !done && 'bg-[color-mix(in_oklab,var(--status-crit)_6%,transparent)]',
          active === r.i && 'outline-2 -outline-offset-2 outline-[var(--status-crit)]',
        )}
      >
        <td className="py-1.5 pr-3 align-top">
          <span className="font-mono text-xs">{r.item_code}</span>
          {productNames[r.item_code] && <span className="block max-w-[14rem] truncate text-xs text-muted-foreground">{productNames[r.item_code]}</span>}
          {view === 'needs' && catalog[r.item_code]?.productLine && (
            <span className="block max-w-[14rem] truncate text-[11px] text-muted-foreground/80">{catalog[r.item_code]?.productLine}</span>
          )}
          {r.alt && <span className="block text-[11px]" style={{color: toneText('var(--status-warn)')}}>Maybe: {r.alt}</span>}
        </td>
        {COLS.map((col) => (
          <td key={col.key} className="py-1.5 pr-2 text-right">
            <input
              inputMode="numeric"
              aria-label={`${r.item_code} ${col.title}`}
              value={r[col.key] ?? ''}
              disabled={!editable}
              onChange={(e) => onCell(r.i, col.key, e.target.value)}
              className={cn(
                'h-7 w-14 rounded-md border bg-background px-1.5 text-right font-mono text-xs tabular-nums outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40',
                isFlag && !done ? 'border-[color-mix(in_oklab,var(--status-crit)_55%,transparent)]' : 'border-border',
              )}
            />
          </td>
        ))}
        <td className="py-1.5 pr-2 text-right text-xs tabular-nums">
          <span
            className="inline-flex min-w-11 justify-center rounded-full px-1.5 py-0.5 font-medium"
            style={{color: toneText(tone), background: `color-mix(in oklab, ${tone} 14%, transparent)`}}
          >
            {Math.round(c * 100)}%
          </span>
        </td>
        {editable && (
          <td className="py-1.5 text-right whitespace-nowrap">
            {isFlag &&
              (done ? (
                <span className="inline-flex items-center gap-1 text-xs" style={{color: toneText('var(--status-good)')}}>
                  <Check className="size-3.5" /> Resolved
                </span>
              ) : (
                <Button variant="outline" size="xs" onClick={() => onResolve(r.i)}>
                  Looks right
                </Button>
              ))}
          </td>
        )}
      </tr>
    );
  };

  // Phones: one card per row, every count a labelled full-size field (no side-scrolling).
  const card = (r: (typeof indexed)[number]) => {
    const isFlag = flaggedSet.has(r.i);
    const done = resolved.has(r.i);
    const c = rowConfidence(r.confidence);
    const tone = BAND_TONE[bandOf(c)];
    return (
      <li
        key={`${r.item_code}-${r.i}`}
        data-review-row={r.i}
        className={cn(
          'flex scroll-mt-24 flex-col gap-2.5 px-4 py-3',
          isFlag && !done && 'bg-[color-mix(in_oklab,var(--status-crit)_6%,transparent)]',
          active === r.i && 'outline-2 -outline-offset-2 outline-[var(--status-crit)]',
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <span className="font-mono text-xs">{r.item_code}</span>
            {productNames[r.item_code] && <span className="block truncate text-sm">{productNames[r.item_code]}</span>}
            {r.alt && <span className="block text-xs" style={{color: toneText('var(--status-warn)')}}>Maybe: {r.alt}</span>}
          </div>
          <span
            className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums"
            style={{color: toneText(tone), background: `color-mix(in oklab, ${tone} 14%, transparent)`}}
          >
            {Math.round(c * 100)}%
          </span>
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {COLS.map((col) => (
            <label key={col.key} className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-[10.5px] text-muted-foreground">{MOBILE_LABEL[col.key]}</span>
              <input
                inputMode="numeric"
                aria-label={`${r.item_code} ${col.title}`}
                value={r[col.key] ?? ''}
                disabled={!editable}
                onChange={(e) => onCell(r.i, col.key, e.target.value)}
                className={cn(
                  'h-10 w-full min-w-0 rounded-md border bg-background px-1.5 text-center font-mono text-sm tabular-nums outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40',
                  isFlag && !done ? 'border-[color-mix(in_oklab,var(--status-crit)_55%,transparent)]' : 'border-border',
                )}
              />
            </label>
          ))}
        </div>
        {editable && isFlag && (
          <div className="flex justify-end">
            {done ? (
              <span className="inline-flex items-center gap-1 text-xs" style={{color: toneText('var(--status-good)')}}>
                <Check className="size-3.5" /> Resolved
              </span>
            ) : (
              <Button variant="outline" size="sm" onClick={() => onResolve(r.i)}>
                Looks right
              </Button>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <Card className="scroll-mt-4">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>
            Rows <span className="text-sm font-normal text-muted-foreground tabular-nums">({rows.length})</span>
          </CardTitle>
          {flagged.length > 0 && (
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
                {resolvedCount} of {flagged.length} resolved
              </span>
              <div className="inline-flex items-center rounded-md border border-border" role="group" aria-label="Flag navigator">
                <Button variant="ghost" size="icon-sm" aria-label="Previous flag" onClick={() => onStep(-1)}>
                  <ChevronLeft className="size-4" />
                </Button>
                <span className="px-1 text-xs font-medium tabular-nums">
                  Flag {pos || '–'} / {flagged.length}
                </span>
                <Button variant="ghost" size="icon-sm" aria-label="Next flag" onClick={() => onStep(1)}>
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl<ReviewView>
            ariaLabel="Which rows"
            value={view}
            onChange={onView}
            options={[
              {value: 'needs', label: `Needs review ${flagged.length}`},
              {value: 'all', label: `All ${rows.length} · form grid`},
            ]}
          />
          <div className="relative ml-auto min-w-[12rem]">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Search item or code…"
              aria-label="Search rows"
              className="h-8 w-full rounded-md border border-border bg-background pr-2.5 pl-8 text-sm outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {visible.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {rows.length === 0
              ? 'No rows were read from this page.'
              : q
                ? 'No rows match your search.'
                : 'Nothing needs review. Switch to “All” to see the whole page.'}
          </p>
        ) : (
          <>
          <ul role="list" className="-mx-4 flex flex-col divide-y divide-border border-y border-border md:hidden" aria-label="Rows">
            {groups
              ? groups.map((g) => (
                  <li key={`${g.family}-${g.items[0].i}`}>
                    <div className="bg-muted/50 px-4 py-1.5 text-xs font-semibold">
                      {g.family}
                      {g.price != null && <span className="ml-1.5 font-mono font-normal text-muted-foreground">· ₱{g.price.toLocaleString('en-US')}</span>}
                    </div>
                    <ul role="list" className="flex flex-col divide-y divide-border">{g.items.map(card)}</ul>
                  </li>
                ))
              : visible.map(card)}
          </ul>
          <div className="overflow-x-auto max-md:hidden">
            <table className="w-full border-collapse text-sm">
              <thead>{header}</thead>
              {groups ? (
                groups.map((g) => (
                  <tbody key={`${g.family}-${g.items[0].i}`}>
                    <tr className="bg-muted/50">
                      <th colSpan={COLS.length + (editable ? 3 : 2)} scope="rowgroup" className="px-2 py-1.5 text-left text-xs font-semibold">
                        {g.family}
                        {g.price != null && <span className="ml-1.5 font-mono font-normal text-muted-foreground">· ₱{g.price.toLocaleString('en-US')}</span>}
                      </th>
                    </tr>
                    {g.items.map(line)}
                  </tbody>
                ))
              ) : (
                <tbody>{visible.map(line)}</tbody>
              )}
            </table>
          </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
