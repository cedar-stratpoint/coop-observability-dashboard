// Reopen for review (Nov 27). PURE so it unit-tests. Plan:
// knowledge/tasks/2026-11-27-reopen-flare-band-wording.md (W3).
//
// A committed page is read-only, and commit writes the reviewed counts to `inventory` only: the
// page's read (extractions.rows) still holds what the reader saw. So reopening gives the read back
// its committed cells, header and BA before the counts leave Inventory, and the page returns to
// review the way it was committed, not the way it was read. Rows the reviewer committed are marked
// `reviewed` (their flags start answered).

import {withProductCodes} from './accessory-codes';
import type {ExtractedPage, ExtractedRow, ReopenRecord} from './goldline-extract-run';

/** One committed count of the page (inventory, source_upload_id = the page). */
export type CommittedRow = {
  item_code: string;
  store_code: string;
  period_start: string;
  period_end: string;
  consultant: string | null;
  stockroom: number | null;
  drawer: number | null;
  selling_area: number | null;
  delivery: number | null;
  ending_on_hand: number | null;
  extra?: Record<string, unknown> | null;
};

const CELLS = ['stockroom', 'drawer', 'selling_area', 'delivery', 'ending_on_hand'] as const;

/** The code each read row commits under (shared accessory price codes become product codes). */
export function committedCodes(page: Pick<ExtractedPage, 'rows'>, version: string | null | undefined, pageNo: number | null | undefined): string[] {
  return withProductCodes(page.rows ?? [], version, pageNo).map((r) => r.item_code);
}

/**
 * The read with its committed counts restored. Each read row takes the committed cells saved
 * under its code (Legacy's own counts too, where the read has them); a committed row the read
 * doesn't have (a product the reviewer added) is appended. The header takes the committed store,
 * period and BA. `keptElsewhere` lists codes whose Inventory count now comes from another page:
 * those rows keep what was read, and the record says so.
 */
export function restoreCommitted(
  page: ExtractedPage,
  committed: readonly CommittedRow[],
  o: {version: string | null | undefined; pageNo: number | null | undefined; at: string; by: string | null; keptElsewhere?: readonly string[]},
): {page: ExtractedPage; restored: number} {
  const head = committed[0];
  if (!head) return {page, restored: 0};
  const byCode = new Map(committed.map((c) => [c.item_code, c]));
  const codes = committedCodes(page, o.version, o.pageNo);
  const used = new Set<string>();
  let restored = 0;
  const rows: ExtractedRow[] = (page.rows ?? []).map((r, i) => {
    const c = byCode.get(codes[i]) ?? byCode.get(r.item_code);
    if (!c || used.has(c.item_code)) return r;
    used.add(c.item_code);
    restored++;
    const next: ExtractedRow = {...r, reviewed: true};
    for (const k of CELLS) next[k] = c[k] ?? null;
    // Legacy's own counts (beginning, ...) live in extra on both sides; the read's other extras stay.
    if (r.extra && c.extra) {
      const extra = {...r.extra};
      for (const k of Object.keys(extra)) if (typeof c.extra[k] === 'number' || c.extra[k] === null) extra[k] = c.extra[k] as number | null;
      next.extra = extra;
    }
    return next;
  });
  for (const c of committed) {
    if (used.has(c.item_code)) continue;
    restored++;
    const row: ExtractedRow = {item_code: c.item_code, confidence: 1, added: true, reviewed: true, stockroom: null, drawer: null, selling_area: null, delivery: null, ending_on_hand: null};
    for (const k of CELLS) row[k] = c[k] ?? null;
    rows.push(row);
  }
  const reopened: ReopenRecord = {
    at: o.at,
    by: o.by,
    store_code: head.store_code,
    period_start: head.period_start,
    period_end: head.period_end,
    consultant: head.consultant,
    restored,
    kept_elsewhere: [...(o.keptElsewhere ?? [])],
  };
  return {
    page: {...page, rows, store_code: head.store_code, period_start: head.period_start, period_end: head.period_end, consultant: head.consultant ?? page.consultant ?? null, reopened},
    restored,
  };
}

/** Row indexes a reopened page starts with answered: the rows a reviewer already committed. */
export function reviewedRows(rows: ReadonlyArray<{reviewed?: boolean}> | null | undefined): Set<number> {
  const out = new Set<number>();
  (rows ?? []).forEach((r, i) => {
    if (r.reviewed) out.add(i);
  });
  return out;
}

/** "Nov 27" (UTC), for the reopened note. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'Asia/Manila'});
}

/** The one line a reopened page shows above its rows. No dashes. */
export function reopenedNote(r: Pick<ReopenRecord, 'at' | 'by' | 'kept_elsewhere'>): string {
  const who = r.by ? r.by.split('@')[0] : 'someone';
  const when = shortDate(r.at);
  const base = `Reopened for review by ${who}${when ? ` on ${when}` : ''}. Your committed counts are back on the rows; commit again to put them back in Inventory.`;
  const n = r.kept_elsewhere.length;
  return n ? `${base} ${n} ${n === 1 ? 'count stays' : 'counts stay'} in Inventory from another page (${r.kept_elsewhere.slice(0, 4).join(', ')}${n > 4 ? ', …' : ''}).` : base;
}
