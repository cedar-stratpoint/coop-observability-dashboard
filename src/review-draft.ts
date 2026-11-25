// Unsaved review edits for an upload batch (pure, unit-tested). A reviewer can leave
// the batch review (back to Uploads, another page) and return: their edited counts and
// the flags they marked as checked come back. Drafts live in the browser (per batch),
// NOT in extractions: that table keeps the reader's original values, which the
// writer profile compares with the confirmed ones. A draft is tied to the exact reading
// it was made on, so a re-read page starts fresh, and it's dropped once committed.

export const DRAFT_COLS = ['stockroom', 'drawer', 'selling_area', 'delivery', 'ending_on_hand'] as const;
type Col = (typeof DRAFT_COLS)[number];
type Row = {item_code: string; printed_name?: string | null; added?: boolean} & Partial<Record<Col, number | null>>;

/** `added`: products the reviewer added (Add product row), after the read's rows, in order; their
 *  counts are the last entries of `values`. */
export type DraftPage = {reading: string; values: (number | null)[][]; resolved: number[]; added?: Array<{code: string; name: string | null}>};
export type Draft = {v: 1; savedAt: number; pages: Record<string, DraftPage>};

export const draftKey = (batchId: string) => `gl-review-draft:${batchId}`;

/** Identifies one reading of a page: its item codes and the reader's values. */
export function readingId(rows: Row[] | null | undefined): string {
  let h = 5381;
  const s = (rows ?? []).map((r) => `${r.item_code}:${DRAFT_COLS.map((c) => r[c] ?? '').join(',')}`).join('|');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${(rows ?? []).length}:${h >>> 0}`;
}

const val = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);

/** The draft for one page, or null when nothing differs from the reading (nothing to keep). */
export function packPage(original: Row[], edited: Row[], resolved: Iterable<number>): DraftPage | null {
  const res = [...resolved].sort((a, b) => a - b);
  const extra = edited.slice(original.length).filter((r) => r.added);
  const base = edited.slice(0, original.length);
  if (base.length !== original.length) return null;
  const changed = base.some((r, i) => DRAFT_COLS.some((c) => val(r[c]) !== val(original[i][c])));
  if (!changed && !res.length && !extra.length) return null;
  const page: DraftPage = {reading: readingId(original), values: [...base, ...extra].map((r) => DRAFT_COLS.map((c) => val(r[c]))), resolved: res};
  if (extra.length) page.added = extra.map((r) => ({code: r.item_code, name: r.printed_name ?? null}));
  return page;
}

/** Apply a saved page draft onto the reading's rows. Null if it was made on a different
 *  reading (re-read, other page) or is malformed: the caller then keeps the fresh rows. */
export function unpackPage<R extends Row>(original: R[], draft: DraftPage | undefined | null): {rows: R[]; resolved: Set<number>} | null {
  if (!draft || draft.reading !== readingId(original)) return null;
  const added = (Array.isArray(draft.added) ? draft.added : []).filter((a) => a && typeof a.code === 'string' && a.code.trim());
  if (!Array.isArray(draft.values) || draft.values.length !== original.length + added.length) return null;
  const counts = (i: number) => {
    const v = draft.values[i];
    return Array.isArray(v) && v.length === DRAFT_COLS.length ? Object.fromEntries(DRAFT_COLS.map((c, k) => [c, val(v[k])])) : null;
  };
  const rows = original.map((r, i) => ({...r, ...(counts(i) ?? {})}) as R);
  added.forEach((a, k) => {
    const blank = Object.fromEntries(DRAFT_COLS.map((c) => [c, null]));
    rows.push({item_code: a.code, printed_name: typeof a.name === 'string' ? a.name : null, ...blank, ...(counts(original.length + k) ?? {}), confidence: 1, added: true} as unknown as R);
  });
  const resolved = new Set((Array.isArray(draft.resolved) ? draft.resolved : []).filter((i) => Number.isInteger(i) && i >= 0 && i < original.length));
  return {rows, resolved};
}

/** Parse a stored draft; null for anything that isn't one. */
export function parseDraft(raw: string | null): Draft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Draft;
    return d && d.v === 1 && d.pages && typeof d.pages === 'object' ? d : null;
  } catch {
    return null;
  }
}
