// Reader-set review flags (NICH-36, Nov 25), behind GOLDLINE_READ_MARKS=1. PURE so it unit-tests.
// Plan: knowledge/tasks/2026-11-25-review-marks-and-reco-reports.md.
//
// Syl: flag that a BA wrote a note or revision, wrote "Damage" in a count, or relabelled the
// printed columns, with the file, page and row; never capture what the note says. The read
// returns a small optional `flags` list per row and the printed headers the BA wrote over; the
// pipeline then writes them as review_marks (source 'reader'), alongside "Product written in"
// for the hand-written rows the read already returns as off-template extras.

import type {MarkKind} from './goldline-review-marks';
import {OS_FLAGS} from './out-of-stock';

export type ReaderFlag = 'note' | 'damage';
export const READER_FLAGS: readonly ReaderFlag[] = ['note', 'damage'];

/** The model's `flags` for a row, cleaned: only known values, once each. */
export function cleanReaderFlags(v: unknown): ReaderFlag[] {
  if (!Array.isArray(v)) return [];
  return READER_FLAGS.filter((f) => v.includes(f));
}

/** The printed headers the BA wrote over, cleaned (trimmed strings, at most 12). */
export function cleanHeaders(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))].slice(0, 12);
}

const FLAG_NOTE: Record<ReaderFlag, string> = {
  note: 'BA note or revision on this row',
  damage: '“Damage” written in a count, left blank',
};

/** Put a row's reader flags on it and send it to review: a note or Damage is worth a look. */
export function applyReaderFlags<R extends {confidence: number; alt?: string | null; reader_flags?: ReaderFlag[] | null}>(row: R, flags: ReaderFlag[]): R {
  if (!flags.length) return row;
  row.reader_flags = flags;
  row.confidence = Math.min(typeof row.confidence === 'number' ? row.confidence : 1, flags.includes('damage') ? 0.5 : 0.6);
  const say = flags.map((f) => FLAG_NOTE[f]).join('; ');
  row.alt = row.alt ? `${row.alt}; ${say}` : say;
  return row;
}

/** Prompt lines for the anchored read (blank cells are omitted there). */
export const MARKS_PROMPT_ANCHORED = [
  '- NOTES AND DAMAGE (flag only, never transcribe them): if the consultant wrote a note, arrow, circle or correction',
  '  on or beside a row (anything besides its counts), add "note" to that row\'s "flags". If a count cell holds a word',
  '  such as "Damage" instead of a number, add "damage" to "flags" and leave that cell out. Leave "flags" out for a',
  '  clean row.',
  '- If a count cell holds "O/S" (out of stock) instead of a number, add that cell\'s "os_" flag to "flags" (os_stockroom,',
  '  os_drawer, os_selling_area, os_delivery or os_ending) and leave the cell out.',
  '- If the consultant wrote their own column names over printed DATA-column headers, list those PRINTED headers in',
  '  "headers_written_over"; otherwise return [].',
];

/** The page-level "relabelled columns" question (QA Nov 26: Legacy never asked it, so a BA writing
 *  Stockroom / Drawer / Selling over the printed headers was never flagged). Shared by the Legacy
 *  and free V1/V2 reads; the anchored read states the same in MARKS_PROMPT_ANCHORED. */
export const HEADERS_PROMPT_LINES = [
  'COLUMN HEADERS: if the consultant wrote their own column names on or over printed DATA-column headers (e.g.',
  '"Stockroom", "Drawer", "Selling" written over "Beginning Inventory", "Delivery", "Beginning + Delivery"), list those',
  'PRINTED headers in "headers_written_over"; otherwise return []. Never let the handwritten names move a number.',
];

/** Prompt lines for the Legacy read (blank cells are null there). */
export const MARKS_PROMPT_LEGACY = [
  'NOTES AND DAMAGE (flag only, never transcribe them): if the consultant wrote a note, arrow, circle or correction on or',
  'beside a row (anything besides its counts), add "note" to that row\'s "flags". If a count cell holds a word such as',
  '"Damage" instead of a number, add "damage" to "flags" and set that cell to null. Leave "flags" out for a clean row.',
  ...HEADERS_PROMPT_LINES,
];

/** Add the page-level `headers_written_over` (required, so it costs no optional-param budget). */
export function withHeadersSchema<S extends {properties: object; required: readonly string[]}>(schema: S): S {
  return {
    ...schema,
    properties: {...schema.properties, headers_written_over: {type: 'array', items: {type: 'string'}}},
    required: [...schema.required, 'headers_written_over'],
  } as S;
}

/** The optional per-row `flags` property (one optional param; schema budgets are tight). */
export const FLAGS_PROPERTY = {type: 'array', items: {type: 'string', enum: [...READER_FLAGS, ...OS_FLAGS]}} as const;

export type ReaderMark = {itemCode: string | null; rowIndex: number | null; kind: MarkKind; reason?: string | null};

/** The store part of a page's classification (goldline-segment StoreSnap), as saved. */
type SavedSnap = {code?: unknown; status?: unknown; from?: unknown; by?: unknown; candidates?: unknown} | null | undefined;

/**
 * A page-level "Take a look" mark when Coop isn't sure of the store it read (QA Nov 26: 2414 read
 * as 2944 with nothing flagged), so it shows in the Flags hub as well as on the page. Corrected by
 * the name or by a near code, not a known store, or a real code the written name disagrees with.
 * A known store read cleanly, or one a reviewer confirmed, carries none.
 */
export function storeMarkFor(snap: SavedSnap): ReaderMark | null {
  if (!snap || typeof snap !== 'object') return null;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const code = s(snap.code);
  const from = s(snap.from);
  const first = Array.isArray(snap.candidates) ? s(snap.candidates[0]) : null;
  let reason: string | null = null;
  switch (snap.status) {
    case 'corrected':
      reason = from && code ? (snap.by === 'name' ? `Store read as ${from}; Coop used ${code} from the store name` : `Store read as ${from}; Coop used the nearest store, ${code}`) : null;
      break;
    case 'ambiguous':
    case 'unknown':
      reason = code ? `Store ${code} isn’t a known store${first ? `; did you mean ${first}?` : ''}` : null;
      break;
    case 'name_mismatch':
      reason = code ? `Store ${code} read, but the store name points to ${first ?? 'another store'}` : null;
      break;
  }
  return reason ? {itemCode: null, rowIndex: null, kind: 'other', reason} : null;
}

/** The page-level "Take a look" mark from the page's classification: the store doubt and/or a form
 *  version nothing proved (QA Nov 26, p30). One mark per page (the table keeps one reader mark per
 *  page and kind), its reason naming each doubt. Null when there is none. */
export function pageCheckMarkFor(cls: {store_snap?: SavedSnap; version_unsure?: unknown; version?: unknown} | null | undefined): ReaderMark | null {
  const reasons: string[] = [];
  const store = storeMarkFor(cls?.store_snap);
  if (store?.reason) reasons.push(store.reason);
  if (cls?.version_unsure === true) {
    const v = typeof cls.version === 'string' && cls.version !== 'unknown' ? cls.version.toUpperCase() : null;
    reasons.push(v ? `Form version unsure: read as ${v}, but the printed layout didn’t confirm it` : 'Form version unsure: the printed layout didn’t say V1 or V2');
  }
  return reasons.length ? {itemCode: null, rowIndex: null, kind: 'other', reason: reasons.join('. ')} : null;
}

type PageLike = {
  rows: Array<{item_code: string; off_manifest?: boolean | null; reader_flags?: ReaderFlag[] | null}>;
  headers_written_over?: string[] | null;
  /** How a Legacy page's columns were used, decided by its own arithmetic (legacyPageLayout). */
  legacy_layout?: 'locations' | 'printed' | null;
};

/** True when the BA repurposed the printed columns: the reader saw names written over the printed
 *  headers, or (backstop, no model needed) a Legacy page's sums show col1 to col3 were used as
 *  Stockroom / Drawer / Selling, which is a relabel even when the handwriting wasn't caught. */
export function columnsChanged(page: Pick<PageLike, 'headers_written_over' | 'legacy_layout'>): boolean {
  return cleanHeaders(page.headers_written_over).length > 0 || page.legacy_layout === 'locations';
}

/**
 * The review flags a read page carries: note and Damage per row, "Product written in" for each
 * hand-written row off the printed form (off-template extras), and "Columns changed" for the page
 * when the BA wrote over printed headers. One per row and kind (the table's own key), in page order.
 */
export function readerMarksFor(page: PageLike): ReaderMark[] {
  const out: ReaderMark[] = [];
  const seen = new Set<string>();
  const add = (m: ReaderMark) => {
    const k = `${m.itemCode ?? ''}|${m.kind}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(m);
  };
  page.rows.forEach((r, i) => {
    const code = (r.item_code ?? '').trim() || null;
    if (r.off_manifest) add({itemCode: code ?? `written-in ${i + 1}`, rowIndex: i, kind: 'added_row'});
    if (!code) return;
    for (const f of cleanReaderFlags(r.reader_flags)) add({itemCode: code, rowIndex: i, kind: f});
  });
  if (columnsChanged(page)) add({itemCode: null, rowIndex: null, kind: 'column_changed'});
  return out;
}
