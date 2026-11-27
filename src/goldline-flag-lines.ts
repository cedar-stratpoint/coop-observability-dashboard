// Every flag as one line (NICH-43 §3, §4; Syl, Nov 25): "if there's a flag, can I see the page
// and row where it was flagged and why, which store, which BA", and "export all SKUs that need
// flagging per store". Pulls the BA scorecard flags (Coop's checks) and the review flags (reader
// and reviewer) into one shape. PURE so it unit-tests; the reader is goldline-flag-lines-data.ts.

import {MARK_LABEL, type MarkKind} from './goldline-review-marks';

export type FlagSource = 'check' | 'reader' | 'reviewer';
export const FLAG_SOURCES: FlagSource[] = ['check', 'reader', 'reviewer'];
export const SOURCE_LABEL: Record<FlagSource, string> = {check: 'Coop check', reader: 'Reader', reviewer: 'Reviewer'};

/** The BA scorecard's checks, in the words the Flags page uses. */
export const CHECK_LABEL: Record<string, string> = {
  unreadable: 'Messy handwriting',
  row_math: 'Row doesn’t add up',
  zero_or_below: 'Count at 0 or below',
  sales_gap: 'Counts and POS sales disagree',
};

export type FlagLine = {
  key: string;
  source: FlagSource;
  /** What to look at: the check or the review flag's kind, in plain words. */
  why: string;
  /** The reviewer's own note, or the check's remark. Never the BA's handwriting. */
  note: string | null;
  open: boolean;
  storeCode: string | null;
  storeName: string | null;
  ba: string | null;
  /** YYYY-MM of the form's period. */
  month: string | null;
  itemCode: string | null;
  product: string | null;
  uploadId: string | null;
  /** The scan or file the page came from, and the page's place in it ("Page 7 of 98"). */
  file: string | null;
  page: number | null;
  pageOf: number | null;
  createdAt: string;
  /** The mark's or check's own id (no prefix), for the hub's inline actions. */
  id?: string;
  /** The raw kind: a MarkKind for marks, a check kind for checks. */
  kind?: string;
  /** The page's upload status ('needs_review', 'committed', ...); null when no page. */
  uploadStatus?: string | null;
  /** For an open "Price written" mark on a page still in review: the band, so the hub can
   *  offer the same two prices the review page does. */
  band?: {group: string; printed: number; offer: number} | null;
  /** A check's stored details (what Coop saw), for its one-sentence reason. */
  details?: Record<string, unknown> | null;
};

export const markWhy = (kind: MarkKind) => MARK_LABEL[kind];
export const checkWhy = (kind: string) => CHECK_LABEL[kind] ?? kind;

/** "Oct scan (page 7 of 98).pdf" → the scan's name and the page's place in it. */
export function filePage(filename: string | null | undefined, batchName?: string | null): {file: string | null; page: number | null; pageOf: number | null} {
  if (!filename) return {file: batchName ?? null, page: null, pageOf: null};
  const m = /^(.*) \(page (\d+) of (\d+)\)\.pdf$/i.exec(filename);
  return m ? {file: batchName?.trim() || m[1], page: Number(m[2]), pageOf: Number(m[3])} : {file: batchName?.trim() || filename, page: null, pageOf: null};
}

/** "Page 7 of 98", "Page 7", or null. */
export const pageLabel = (l: Pick<FlagLine, 'page' | 'pageOf'>) => (l.page == null ? null : l.pageOf ? `Page ${l.page} of ${l.pageOf}` : `Page ${l.page}`);

export type FlagFilter = {store: string | null; month: string | null; source: FlagSource | null; open: 'open' | 'all'; q: string};

export function parseFlagFilter(p: Record<string, string | null | undefined>): FlagFilter {
  const store = (p.store ?? '').trim();
  const month = (p.month ?? '').trim();
  return {
    store: store && store !== 'all' ? store.slice(0, 32) : null,
    month: /^\d{4}-\d{2}$/.test(month) ? month : null,
    source: FLAG_SOURCES.includes(p.source as FlagSource) ? (p.source as FlagSource) : null,
    open: p.status === 'all' ? 'all' : 'open',
    q: (p.q ?? '').trim().slice(0, 80),
  };
}

const storeOrder = (a: string | null, b: string | null) => (a ?? '￿').localeCompare(b ?? '￿', undefined, {numeric: true});

/** The lines a filter shows, by store, then file and page, then newest. */
export function filterLines(lines: readonly FlagLine[], f: FlagFilter): FlagLine[] {
  const needle = f.q.toLowerCase();
  return lines
    .filter(
      (l) =>
        (f.open === 'all' || l.open) &&
        (!f.store || l.storeCode === f.store) &&
        (!f.month || l.month === f.month) &&
        (!f.source || l.source === f.source) &&
        (!needle || [l.itemCode, l.product, l.ba, l.storeName, l.file, l.why].some((s) => (s ?? '').toLowerCase().includes(needle))),
    )
    .sort(
      (a, b) =>
        storeOrder(a.storeCode, b.storeCode) ||
        (a.file ?? '').localeCompare(b.file ?? '') ||
        (a.page ?? 0) - (b.page ?? 0) ||
        b.createdAt.localeCompare(a.createdAt),
    );
}

export const EXPORT_HEAD = ['Store code', 'Store', 'BA', 'Month', 'Item code', 'Product', 'Why', 'Note', 'Source', 'File', 'Page', 'Status', 'Flagged on'];

/** One CSV row per line, in the head's order. */
export function exportRow(l: FlagLine): (string | number)[] {
  return [
    l.storeCode ?? '',
    l.storeName ?? '',
    l.ba ?? '',
    l.month ?? '',
    l.itemCode ?? '',
    l.product ?? '',
    l.why,
    l.note ?? '',
    SOURCE_LABEL[l.source],
    l.file ?? '',
    pageLabel(l) ?? '',
    l.open ? 'Open' : l.source === 'check' ? 'Resolved' : 'Cleared',
    l.createdAt.slice(0, 10),
  ];
}

/** The note on a check withdrawn by a reopen (Nov 27), shown under Cleared; any remark follows. */
export function withdrawnNote(remark: string | null | undefined): string {
  const base = 'Withdrawn: its page was reopened for review, so it no longer counts against the BA.';
  return remark?.trim() ? `${base} ${remark.trim()}` : base;
}
