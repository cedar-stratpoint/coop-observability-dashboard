// Review marks (NICH-42, Nov 25): "look at this row on this page". PURE (no DB) so it
// unit-tests; reads/writes are in goldline-review-marks-data.ts, the actions in
// app/uploads/review-marks-actions.ts. Plan: knowledge/tasks/2026-11-25-review-marks-and-reco-reports.md.
//
// A mark never counts against the BA (that is public.flags, the scorecard). It names the
// page (upload) and the row (item code); null item = the whole page. Syl: flag that a note
// exists, never capture what it says.

export type MarkKind = 'illegible' | 'note' | 'damage' | 'column_changed' | 'added_row' | 'other';
export type MarkSource = 'reviewer' | 'reader';
export type MarkStatus = 'open' | 'cleared';

export const MARK_KINDS: MarkKind[] = ['illegible', 'note', 'damage', 'column_changed', 'added_row', 'other'];

/** What a reviewer can pick on a row, in menu order. */
export const ROW_KINDS: MarkKind[] = ['illegible', 'note', 'damage', 'other'];
/** What a reviewer can pick for the whole page. */
export const PAGE_KINDS: MarkKind[] = ['column_changed', 'note', 'other'];

export const MARK_LABEL: Record<MarkKind, string> = {
  illegible: 'Can’t read the number',
  note: 'Note or revision',
  damage: 'Damage written',
  column_changed: 'Columns changed',
  added_row: 'Product written in',
  other: 'Other',
};

/** One line under each choice, so the reviewer picks the right one. */
export const MARK_HINT: Record<MarkKind, string> = {
  illegible: 'Leave the cell blank instead of guessing',
  note: 'The BA wrote a note, arrow or correction',
  damage: '“Damage” written in a count',
  column_changed: 'The BA wrote over the printed headers',
  added_row: 'A product hand-written between printed rows',
  other: 'Anything else worth a second look',
};

export const REASON_MAX = 200;

export type ReviewMark = {
  id: string;
  uploadId: string;
  itemCode: string | null;
  rowIndex: number | null;
  kind: MarkKind;
  source: MarkSource;
  reason: string | null;
  status: MarkStatus;
  createdBy: string | null;
  createdAt: string;
  clearedBy: string | null;
  clearedAt: string | null;
};

export const isMarkKind = (s: unknown): s is MarkKind => MARK_KINDS.includes(s as MarkKind);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FlagInput = {uploadId: string; itemCode: string | null; rowIndex: number | null; kind: MarkKind; reason: string | null};

/** Check a Flag request from the browser. Never trusts it: shape, kind for row vs page, lengths. */
export function parseFlagInput(raw: unknown): {ok: true; input: FlagInput} | {ok: false; error: string} {
  if (!raw || typeof raw !== 'object') return {ok: false, error: 'Nothing to flag.'};
  const o = raw as Record<string, unknown>;
  const uploadId = typeof o.uploadId === 'string' ? o.uploadId.trim() : '';
  if (!UUID.test(uploadId)) return {ok: false, error: 'That page could not be found.'};
  const code = typeof o.itemCode === 'string' ? o.itemCode.trim() : '';
  if (code.length > 64) return {ok: false, error: 'That row could not be found.'};
  const itemCode = code || null;
  if (!isMarkKind(o.kind)) return {ok: false, error: 'Pick what to flag.'};
  const allowed = itemCode ? ROW_KINDS : PAGE_KINDS;
  if (!allowed.includes(o.kind)) return {ok: false, error: itemCode ? 'That kind of flag is for the whole page.' : 'That kind of flag is for one row.'};
  const row = typeof o.rowIndex === 'number' && Number.isInteger(o.rowIndex) && o.rowIndex >= 0 && o.rowIndex < 5000 ? o.rowIndex : null;
  const text = typeof o.reason === 'string' ? o.reason.replace(/\s+/g, ' ').trim() : '';
  if (text.length > REASON_MAX) return {ok: false, error: `Keep the note under ${REASON_MAX} characters.`};
  if (o.kind === 'other' && !text) return {ok: false, error: 'Say what to look at.'};
  return {ok: true, input: {uploadId, itemCode, rowIndex: itemCode ? row : null, kind: o.kind, reason: text || null}};
}

/** Open marks on one row of a page (by item code), newest first. */
export function rowMarks(marks: readonly ReviewMark[], itemCode: string): ReviewMark[] {
  return marks.filter((m) => m.status === 'open' && m.itemCode === itemCode).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Open marks on the page itself (no row). */
export function pageMarks(marks: readonly ReviewMark[]): ReviewMark[] {
  return marks.filter((m) => m.status === 'open' && m.itemCode == null);
}

/** Apply a saved mark to a local list: replaces the same page, row, kind and source, else adds. */
export function upsertLocal(marks: readonly ReviewMark[], m: ReviewMark): ReviewMark[] {
  const same = (x: ReviewMark) => x.uploadId === m.uploadId && x.itemCode === m.itemCode && x.kind === m.kind && x.source === m.source;
  return marks.some(same) ? marks.map((x) => (same(x) ? m : x)) : [...marks, m];
}
