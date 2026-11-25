// Reader-set review flags (NICH-36, Nov 25), behind GOLDLINE_READ_MARKS=1. PURE so it unit-tests.
// Plan: knowledge/tasks/2026-11-25-review-marks-and-reco-reports.md.
//
// Syl: flag that a BA wrote a note or revision, wrote "Damage" in a count, or relabelled the
// printed columns, with the file, page and row; never capture what the note says. The read
// returns a small optional `flags` list per row and the printed headers the BA wrote over; the
// pipeline then writes them as review_marks (source 'reader'), alongside "Product written in"
// for the hand-written rows the read already returns as off-template extras.

import type {MarkKind} from './goldline-review-marks';

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
  '- If the consultant wrote their own column names over printed DATA-column headers, list those PRINTED headers in',
  '  "headers_written_over"; otherwise return [].',
];

/** Prompt lines for the Legacy read (blank cells are null there). */
export const MARKS_PROMPT_LEGACY = [
  'NOTES AND DAMAGE (flag only, never transcribe them): if the consultant wrote a note, arrow, circle or correction on or',
  'beside a row (anything besides its counts), add "note" to that row\'s "flags". If a count cell holds a word such as',
  '"Damage" instead of a number, add "damage" to "flags" and set that cell to null. Leave "flags" out for a clean row.',
];

/** The optional per-row `flags` property (one optional param; schema budgets are tight). */
export const FLAGS_PROPERTY = {type: 'array', items: {type: 'string', enum: [...READER_FLAGS]}} as const;

export type ReaderMark = {itemCode: string | null; rowIndex: number | null; kind: MarkKind};

type PageLike = {
  rows: Array<{item_code: string; off_manifest?: boolean | null; reader_flags?: ReaderFlag[] | null}>;
  headers_written_over?: string[] | null;
};

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
  if (cleanHeaders(page.headers_written_over).length) add({itemCode: null, rowIndex: null, kind: 'column_changed'});
  return out;
}
