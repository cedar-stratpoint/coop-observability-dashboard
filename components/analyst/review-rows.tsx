'use client';

import {useMemo, useState} from 'react';
import {Check, ChevronLeft, ChevronRight, Plus, Search, Trash2} from 'lucide-react';
import type {ExtractedRow} from '@/src/goldline-extract-run';
import {bandOf, LOW_BELOW, rowConfidence, toneText, type Band} from '@/src/review-confidence';
import {groupByFamily, pageTotal, printedNameConflict, type CatalogLite} from '@/src/review-workbench';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {SegmentedControl} from '@/components/analyst/segmented-control';
import {cn} from '@/lib/utils';
import {COLS, colsForPage, colsForVersion, type ColKey} from './review-grid-cols';
import {noteLayout, readerNote} from './reader-note';
import {FlagButton, FlagChips, useReviewFlags} from './review-flags';
import {pageMarks, rowMarks} from '@/src/goldline-review-marks';
import {AddRowDialog} from './add-row-dialog';
import {addedRow, type AddableItem} from '@/src/review-add-row';
import {bandOpen, type PaperBand} from '@/src/band-prices';
import {BandPrice} from './band-price';

// The rows of a scan review (plan §07d). Two views:
//  • Needs review — only the flagged rows, each with "Looks right" (or edit it) to
//    resolve it; the flag navigator walks them one by one.
//  • All — the whole page as a form grid that mirrors the paper: grouped under the
//    printed family headings with their price, flagged rows still highlighted.
// Commit is gated by the parent until every flag is resolved.

// COLS / ColKey / colsForVersion live in the pure, testable ./review-grid-cols module;
// re-exported here so existing importers (batch-review) keep working unchanged.
export {COLS, colsForVersion};
export type {ColKey};

/** Full field names for the phone layout (the table uses the short form labels). */
const MOBILE_LABEL: Record<ColKey, string> = {stockroom: 'Stockroom', drawer: 'Drawer', selling_area: 'Selling', delivery: 'Delivery', ending_on_hand: 'Ending'};

/** The VISIBLE element for review row `index` — the table row on wide screens, the
 *  card on phones (both are in the page; only one is shown). */

const MARK_LABEL = {overwritten: 'Overwritten', unclear: 'Unclear', straddle: 'Between columns'} as const;
const FIELD_LABEL: Record<string, string> = {stockroom: 'stockroom', drawer: 'drawer', selling_area: 'selling area', delivery: 'delivery', ending_on_hand: 'ending'};
/** "Overwritten: drawer (was 5) · Unclear: ending" — the reader's cell marks (F3). */
function marksText(r: ExtractedRow): string | null {
  const m = r.marks ?? [];
  if (!m.length) return null;
  return m.map((x) => `${MARK_LABEL[x.mark] ?? x.mark}: ${FIELD_LABEL[x.field] ?? x.field}${x.written ? ` (written ${x.written})` : ''}`).join(' · ');
}

/** The deducted-model values Legacy forms carry in `extra` (no three-location split),
 *  as a read-only context line "Beginning 20 · +Delivery 25 · Deducted 8" — shown only
 *  for a Legacy row (v1/v2 have no `extra`). Blank values are omitted. */
function legacyExtraText(r: ExtractedRow): string | null {
  const e = r.extra;
  if (!e) return null;
  const bits: string[] = [];
  if (e.beginning != null) bits.push(`Beginning ${e.beginning}`);
  if (e.begin_plus_delivery != null) bits.push(`Beginning + Delivery ${e.begin_plus_delivery}`);
  if (e.deducted_pcs != null) bits.push(`Deducted ${e.deducted_pcs}`);
  return bits.length ? bits.join(' · ') : null;
}

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
  /** Row index → its own product name: several printed rows can share a code, so a code lookup isn't enough. */
  rowNames?: (string | null)[];
  catalog: Record<string, CatalogLite>;
  flagged: number[]; // row indices under the threshold
  /** Row index → an extra note to show with the row's reason (the history check). */
  rowNotes?: Record<number, string>;
  resolved: ReadonlySet<number>;
  active: number | null; // the flag the navigator is on
  view: ReviewView;
  /** The page's detected form version (legacy/v1/v2), so the count columns render in the
   *  version's printed left-to-right order. Display only; absent falls back to V1 order. */
  version?: string | null;
  query: string;
  onQuery: (q: string) => void;
  editable: boolean;
  onView: (v: ReviewView) => void;
  onCell: (index: number, key: ColKey, raw: string) => void;
  onResolve: (index: number) => void;
  onStep: (dir: 1 | -1) => void;
  /** The row the reviewer is pointing at (hover or keyboard focus), so the scan beside the rows can
   *  box it. Absent when there's no scan pane. */
  onPoint?: (index: number) => void;
  /** The row currently pointed at: tinted to match the box drawn on the scan. */
  pointed?: number | null;
  /** The page these rows are on, so a row (or the page) can be flagged (NICH-42). Needs a
   *  ReviewFlagsProvider above; without either, no Flag buttons show. */
  uploadId?: string;
  /** Add product row (NICH-42): the catalog to pick from, this page's printed number (for the
   *  "printed on another page" warning), and the parent's add/remove. Absent = no Add product. */
  addable?: AddableItem[];
  page?: number | null;
  onAddRow?: (row: ExtractedRow) => void;
  onRemoveRow?: (index: number) => void;
  /** The page's heading bands as read: paper total, written price, and the reviewer's price
   *  pick (QA Nov 25). A flagged band shows its pick on its first row. */
  bands?: PaperBand[];
  /** Pick (or take back, null) the price a flagged band is valued at on this form. Returns an
   *  error message, or null when saved. */
  onBandPrice?: (group: string, price: number | null) => Promise<string | null>;
};

/** The one-line "why this row is doubtful": the reader's cell marks and/or the
 *  alternative reading, combined so a flagged row shows a single reason, not three
 *  stacked amber lines. */
function reasonText(r: ExtractedRow, version?: string | null, known?: boolean, extra?: string): string | null {
  const parts: string[] = [];
  const m = marksText(r);
  if (m) parts.push(m);
  // The reader's note in column names (no "col3" / "off_manifest"), with no "Maybe:" prefix:
  // it is often a plain remark ("O/S"), not an alternative value.
  const note = readerNote(r.alt, noteLayout(version, r), {known});
  if (note) parts.push(note);
  if (extra) parts.push(extra);
  return parts.length ? parts.join(' · ') : null;
}

/** 'Paper reads: "BB 04 Beige"' — shown when the name printed on the row disagrees with
 *  the manifest name for its code, so a misread code or an out-of-date printed label is
 *  visible to the reviewer instead of being silently resolved to the manifest name. */
function printedNameHint(r: ExtractedRow, catalogName: string | undefined): string | null {
  return printedNameConflict(r.printed_name, catalogName) ? `Paper reads: “${r.printed_name}”` : null;
}

export function ReviewRows({
  rows,
  productNames,
  rowNames,
  catalog: catalogIn,
  flagged,
  rowNotes,
  resolved,
  active,
  view,
  version,
  query,
  onQuery,
  editable,
  onView,
  onCell,
  onResolve,
  onStep,
  onPoint,
  pointed,
  uploadId,
  addable,
  page,
  onAddRow,
  onRemoveRow,
  bands,
  onBandPrice,
}: Props) {
  const [adding, setAdding] = useState(false);
  // Added rows aren't in the page's catalog slice: borrow their line and price from the
  // picker list so they sit under their heading and count in its total.
  const catalog = useMemo(() => {
    const extra = rows.filter((r) => r.added && !catalogIn[r.item_code]);
    if (!extra.length || !addable) return catalogIn;
    const by = new Map(addable.map((a) => [a.code, a]));
    return {...catalogIn, ...Object.fromEntries(extra.map((r) => [r.item_code, {productLine: by.get(r.item_code)?.line ?? null, unitPrice: by.get(r.item_code)?.price ?? null}]))};
  }, [rows, catalogIn, addable]);
  const flagCtx = useReviewFlags();
  const onPage = useMemo(() => (flagCtx && uploadId ? flagCtx.marks.filter((m) => m.uploadId === uploadId) : []), [flagCtx, uploadId]);
  // A band's "Price written" mark is answered on the band itself (BandPrice), not as a chip.
  const flagsOf = (code: string) => rowMarks(onPage, code).filter((m) => m.kind !== 'price');
  const pageFlags = pageMarks(onPage);
  const canAdd = Boolean(editable && onAddRow && addable?.length);
  const pageCodes = useMemo(() => new Set(rows.map((r) => r.item_code)), [rows]);
  const pageLines = useMemo(() => new Set(rows.map((r) => catalog[r.item_code]?.productLine).filter((l): l is string => Boolean(l))), [rows, catalog]);
  const addProduct = async (it: AddableItem): Promise<string | null> => {
    const index = rows.length;
    onAddRow?.(addedRow(it));
    onView('all');
    requestAnimationFrame(() => {
      const el = reviewRowEl(index);
      el?.scrollIntoView({behavior: 'smooth', block: 'center'});
      el?.querySelector<HTMLInputElement>('input')?.focus({preventScroll: true});
    });
    // Flag it as written in, so the reports list it with its page and row.
    if (flagCtx?.canFlag && uploadId) {
      const err = await flagCtx.save({uploadId, itemCode: it.code, rowIndex: index, kind: 'added_row'});
      if (err) console.error('added_row flag', err);
    }
    return null;
  };
  const removeAdded = (r: {item_code: string; i: number}) => {
    onRemoveRow?.(r.i);
    const m = onPage.find((x) => x.status === 'open' && x.itemCode === r.item_code && x.kind === 'added_row' && x.source === 'reviewer');
    if (m && flagCtx) void flagCtx.clear(m.id);
  };
  const removeButton = (r: (typeof indexed)[number]) =>
    r.added && editable && onRemoveRow ? (
      <button
        type="button"
        onClick={() => removeAdded(r)}
        aria-label={`Remove ${r.item_code}`}
        title="Remove this added row"
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground outline-none transition-[transform,border-color,color] duration-150 ease-out active:scale-[0.97] focus-visible:ring-3 focus-visible:ring-ring/40 [@media(hover:hover)]:hover:border-foreground/25 [@media(hover:hover)]:hover:text-foreground"
      >
        <Trash2 aria-hidden className="size-3.5" />
      </button>
    ) : null;
  const flagTarget = (r: {item_code: string; i: number}) =>
    uploadId ? {uploadId, itemCode: r.item_code, rowIndex: r.i, label: `${r.item_code}${nameOf(r as (typeof indexed)[number]) ? ` · ${nameOf(r as (typeof indexed)[number])}` : ''}`} : null;
  const flaggedSet = useMemo(() => new Set(flagged), [flagged]);
  // Flagged bands sit on their first row; headings look a band up by any of its codes.
  const bandAt = useMemo(() => new Map((bands ?? []).filter((b) => b.kind != null && b.first_index != null).map((b) => [b.first_index as number, b])), [bands]);
  const bandByCode = useMemo(() => new Map((bands ?? []).filter((b) => b.kind != null).flatMap((b) => b.codes.map((c) => [c, b] as const))), [bands]);
  const piecesOf = (b: PaperBand) => rows.reduce((a, r) => a + (b.codes.includes(r.item_code) && typeof r.ending_on_hand === 'number' ? r.ending_on_hand : 0), 0);
  // A row flagged only for its band's price is answered by the price pick, not "Looks right".
  const bandOnly = (r: ExtractedRow & {i: number}) => {
    const b = bandAt.get(r.i);
    return Boolean(b && bandOpen(b) && rowConfidence(r.confidence) >= LOW_BELOW && !rowNotes?.[r.i]);
  };
  // "O/S" written in this cell on the paper (read as 0), while the cell still holds that 0.
  const osTag = (r: ExtractedRow & {i: number}, key: ColKey, at: 'table' | 'card') => {
    if (!r.oos?.cells.includes(key) || (r[key] != null && r[key] !== 0)) return null;
    return (
      <span
        title="O/S (out of stock) written on the paper, read as 0"
        className={cn(
          'font-mono font-semibold tracking-tight',
          at === 'table' ? 'pointer-events-none absolute top-1/2 left-1.5 -translate-y-1/2 text-[9px] leading-none' : 'text-[10px]',
        )}
        style={{color: toneText('var(--status-warn)')}}
      >
        O/S
      </span>
    );
  };
  const bandPrice = (r: ExtractedRow & {i: number}) => {
    const b = bandAt.get(r.i);
    return b ? <BandPrice band={b} pieces={piecesOf(b)} editable={editable} onPick={onBandPrice ? (price) => onBandPrice(b.group, price) : undefined} /> : null;
  };
  // Count columns in this version's printed order (V2 leads with Delivery); display only.
  const cols = useMemo(() => colsForPage(version, rows), [version, rows]);
  const q = query.trim().toLowerCase();
  const indexed = useMemo(() => rows.map((r, i) => ({...r, i})), [rows]);
  const nameOf = (r: (typeof indexed)[number]) => (rowNames ? rowNames[r.i] : productNames[r.item_code]) ?? r.printed_name ?? null;
  const knownName = (r: (typeof indexed)[number]) => (rowNames ? rowNames[r.i] : productNames[r.item_code]) ?? undefined;
  const matches = (r: (typeof indexed)[number]) =>
    !q || r.item_code.toLowerCase().includes(q) || (nameOf(r) ?? '').toLowerCase().includes(q);
  const visible = indexed.filter((r) => (view === 'all' || flaggedSet.has(r.i)) && matches(r));
  const groups = view === 'all' ? groupByFamily(visible, catalog) : null;
  // Rows under a heading whose items print different prices (Make-Up Collection: BESP ₱320,
  // CPC001 ₱350) show their own price, like the paper's per-item price lines.
  const ownPrice = new Set(groups?.filter((g) => g.price == null).flatMap((g) => g.items.map((r) => r.i)) ?? []);
  const priceOf = (code: string) => catalog[code]?.unitPrice ?? null;
  const resolvedCount = flagged.filter((i) => resolved.has(i)).length;
  const pos = active == null ? 0 : flagged.indexOf(active) + 1;

  const header = (
    <tr className="border-b border-border text-left text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
      <th className="py-2 pr-3 pl-3 font-medium">Item</th>
      {cols.map((c) => (
        <th key={c.key} className="py-2 pr-2 text-right leading-tight font-medium" title={c.title}>
          {c.label}
        </th>
      ))}
      <th className="py-2 pr-2 text-right font-medium">Conf.</th>
      {editable && <th className="py-2 font-medium sr-only">Decision</th>}
    </tr>
  );

  // A heading bar as printed: the band's name, its price when every item shares one, and on the
  // right the band's total amount (on hand × printed price), like the bracketed totals the
  // consultant writes beside each band.
  const heading = (g: {family: string; price: number | null; items: (typeof indexed)[number][]}) => {
    const t = pageTotal(g.items, catalog);
    // A band whose paper points at another price says so beside its price, and shows the paper
    // total next to Coop's (QA Nov 25: ₱180 written on a ₱225 band, ₱6,480 on paper).
    const b = g.items.length ? bandByCode.get(g.items[0].item_code) : undefined;
    const changed = b && b.use_price != null && b.use_price !== b.printed_price;
    return (
      <span className="flex items-baseline justify-between gap-3">
        <span>
          {g.family}
          {g.price != null && <span className="ml-1.5 font-mono font-normal text-muted-foreground">· ₱{g.price.toLocaleString('en-US')}</span>}
          {b && bandOpen(b) && b.offer_price != null && (
            <span className="ml-1.5 font-mono font-normal" style={{color: toneText('var(--status-warn)')}}>
              · ₱{b.offer_price.toLocaleString('en-US')} on paper
            </span>
          )}
          {changed && b.printed_price != null && (
            <span className="ml-1.5 font-mono font-normal text-muted-foreground">· printed ₱{b.printed_price.toLocaleString('en-US')}</span>
          )}
        </span>
        {t.priced > 0 && (
          <span className="shrink-0 font-mono font-normal text-muted-foreground tabular-nums" title={changed ? 'Total amount: on hand × the price picked for this form' : 'Total amount: on hand × printed price'}>
            {b?.amount != null && <span className="mr-2">Paper ₱{b.amount.toLocaleString('en-US')} ·</span>}
            ₱{t.total.toLocaleString('en-US')}
          </span>
        )}
      </span>
    );
  };

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
        onPointerEnter={onPoint ? () => onPoint(r.i) : undefined}
        onFocus={onPoint ? () => onPoint(r.i) : undefined}
        data-pointed={pointed === r.i || active === r.i || undefined}
        className={cn(
          'group/row scroll-mt-24 border-b border-border/60 transition-colors',
          isFlag && !done && 'bg-[color-mix(in_oklab,var(--status-crit)_6%,transparent)]',
          pointed === r.i && 'bg-[color-mix(in_oklab,var(--primary)_10%,transparent)] shadow-[inset_3px_0_0_var(--primary)]',
          active === r.i && 'outline-2 -outline-offset-2 outline-[var(--status-crit)]',
        )}
      >
        {/* pl-3 keeps the item clear of the 3px bar on the pointed row. */}
        <td className="py-3 pr-3 pl-3 align-top">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              {/* Primary: code + name. */}
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs font-medium">{r.item_code}</span>
                {nameOf(r) && <span className="min-w-0 text-xs text-muted-foreground">{nameOf(r)}</span>}
                {ownPrice.has(r.i) && priceOf(r.item_code) != null && (
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">₱{priceOf(r.item_code)!.toLocaleString('en-US')}</span>
                )}
              </div>
              {printedNameHint(r, knownName(r)) && (
                <span className="mt-0.5 block text-[11px] leading-snug" style={{color: toneText('var(--status-warn)')}}>{printedNameHint(r, knownName(r))}</span>
              )}
              {view === 'needs' && catalog[r.item_code]?.productLine && (
                <span className="mt-0.5 block max-w-[16rem] truncate text-[11px] text-muted-foreground/70">{catalog[r.item_code]?.productLine}</span>
              )}
              {/* Secondary: one reason line (marks + alt combined), then the Legacy
                  deducted context as a quieter tertiary line. */}
              {reasonText(r, version, Boolean(knownName(r)), rowNotes?.[r.i]) && (
                <span className="mt-1 block text-[11px] leading-snug" style={{color: toneText('var(--status-warn)')}}>{reasonText(r, version, Boolean(knownName(r)), rowNotes?.[r.i])}</span>
              )}
              {legacyExtraText(r) && (
                <span className="mt-0.5 block text-[11px] text-muted-foreground/60 tabular-nums">{legacyExtraText(r)}</span>
              )}
              {bandPrice(r)}
              <FlagChips marks={flagsOf(r.item_code)} className="mt-1" />
            </div>
            {removeButton(r)}
            {flagTarget(r) && <FlagButton target={flagTarget(r)!} count={flagsOf(r.item_code).length} />}
          </div>
        </td>
        {cols.map((col) => (
          <td key={col.key} className="py-1.5 pr-2 text-right">
            <span className="relative inline-block">
            {osTag(r, col.key, 'table')}
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
            </span>
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
            {isFlag && !bandOnly(r) &&
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
        onFocus={onPoint ? () => onPoint(r.i) : undefined}
        data-pointed={pointed === r.i || active === r.i || undefined}
        className={cn(
          'group/row flex scroll-mt-24 flex-col gap-2.5 px-4 py-3',
          isFlag && !done && 'bg-[color-mix(in_oklab,var(--status-crit)_6%,transparent)]',
          pointed === r.i && 'bg-[color-mix(in_oklab,var(--primary)_10%,transparent)] shadow-[inset_3px_0_0_var(--primary)]',
          active === r.i && 'outline-2 -outline-offset-2 outline-[var(--status-crit)]',
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <span className="font-mono text-xs font-medium">{r.item_code}</span>
            {nameOf(r) && <span className="block text-sm">{nameOf(r)}</span>}
            {ownPrice.has(r.i) && priceOf(r.item_code) != null && (
              <span className="block font-mono text-xs text-muted-foreground tabular-nums">₱{priceOf(r.item_code)!.toLocaleString('en-US')}</span>
            )}
            {printedNameHint(r, knownName(r)) && (
              <span className="mt-0.5 block text-xs leading-snug" style={{color: toneText('var(--status-warn)')}}>{printedNameHint(r, knownName(r))}</span>
            )}
            {reasonText(r, version, Boolean(knownName(r)), rowNotes?.[r.i]) && <span className="mt-1 block text-xs leading-snug" style={{color: toneText('var(--status-warn)')}}>{reasonText(r, version, Boolean(knownName(r)), rowNotes?.[r.i])}</span>}
            {legacyExtraText(r) && <span className="mt-0.5 block text-xs text-muted-foreground/60 tabular-nums">{legacyExtraText(r)}</span>}
            {bandPrice(r)}
            <FlagChips marks={flagsOf(r.item_code)} className="mt-1" />
          </div>
          <span className="flex shrink-0 items-center gap-1.5">
          {removeButton(r)}
          {flagTarget(r) && <FlagButton target={flagTarget(r)!} count={flagsOf(r.item_code).length} />}
          <span
            className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums"
            style={{color: toneText(tone), background: `color-mix(in oklab, ${tone} 14%, transparent)`}}
          >
            {Math.round(c * 100)}%
          </span>
          </span>
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {cols.map((col) => (
            <label key={col.key} className="flex min-w-0 flex-col gap-1">
              <span className="flex min-w-0 items-baseline gap-1 truncate text-[10.5px] text-muted-foreground">
                {MOBILE_LABEL[col.key]}
                {osTag(r, col.key, 'card')}
              </span>
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
        {editable && isFlag && !bandOnly(r) && (
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
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <CardTitle>
              Rows <span className="text-sm font-normal text-muted-foreground tabular-nums">({rows.length})</span>
            </CardTitle>
            {uploadId && <FlagButton size="page" target={{uploadId, itemCode: null, rowIndex: null, label: 'Whole page'}} count={pageFlags.length} />}
          </div>
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
        {pageFlags.length > 0 && <FlagChips marks={pageFlags} />}
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
          {canAdd && (
            <Button variant="outline" size="sm" onClick={() => setAdding(true)} className="ml-auto">
              <Plus aria-hidden className="size-4" /> Add product
            </Button>
          )}
          <div className={cn('relative min-w-[12rem]', !canAdd && 'ml-auto')}>
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
                    <div className="bg-muted/50 px-4 py-1.5 text-xs font-semibold">{heading(g)}</div>
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
                      <th colSpan={cols.length + (editable ? 3 : 2)} scope="rowgroup" className="px-2 py-1.5 text-left text-xs font-semibold">
                        {heading(g)}
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
      {adding && addable && (
        <AddRowDialog items={addable} pageCodes={pageCodes} pageLines={pageLines} page={page ?? null} onAdd={addProduct} onClose={() => setAdding(false)} />
      )}
    </Card>
  );
}
