// History check (QA fix 8): a count that adds up within its own row can still be wrong on its own. Compare each row with the same store's last committed
// count of that item: stock can't grow beyond what was there plus what was delivered. Flags only;
// nothing is changed. Becomes useful as stores' forms get committed (each form is the next one's
// history). Rule from the offline test of 2026-11-23 (4 wrong rows flagged, 2 of
// them not caught elsewhere, and 32 right rows). Located Legacy rows carry no Delivery, so a restocked
// item there is flagged too. Pure.

export type PrevCount = {item_code: string; period_end: string; ending_on_hand: number | null};

type Row = {
  item_code: string;
  stockroom?: number | null;
  drawer?: number | null;
  selling_area?: number | null;
  delivery?: number | null;
  ending_on_hand?: number | null;
  extra?: Record<string, number | null> | null;
};

const fmtDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
};

/** The latest committed count per item, ending before `before` (YYYY-MM-DD). */
export function latestBefore(prev: PrevCount[], before: string): Map<string, PrevCount> {
  const out = new Map<string, PrevCount>();
  for (const p of prev) {
    if (!(p.period_end < before)) continue;
    const cur = out.get(p.item_code);
    if (!cur || p.period_end > cur.period_end) out.set(p.item_code, p);
  }
  return out;
}

/** A plain note when this row can't follow from the last count, else null. */
export function historyNote(row: Row, prev: PrevCount | undefined, version: string | null | undefined): string | null {
  if (!prev || prev.ending_on_hand == null) return null;
  const last = prev.ending_on_hand;
  const when = fmtDay(prev.period_end);
  const located = row.stockroom != null || row.drawer != null || row.selling_area != null;
  // A Legacy page on the printed deducted model: its Beginning is the last count's Ending.
  const beginning = row.extra?.beginning;
  if (version === 'legacy' && !located && typeof beginning === 'number') {
    return beginning === last ? null : `Beginning ${beginning} differs from the last count's ending (${last} on ${when})`;
  }
  if (row.ending_on_hand == null) return null;
  const delivery = row.delivery ?? 0;
  if (row.ending_on_hand <= last + delivery) return null;
  return delivery
    ? `Ending ${row.ending_on_hand} is more than the last count (${last} on ${when}) plus delivery ${delivery}`
    : `Ending ${row.ending_on_hand} is more than the last count (${last} on ${when}) with no delivery`;
}

/** Row index → note, for every row the history can't explain. */
export function historyNotes(rows: Row[], prev: Map<string, PrevCount>, version: string | null | undefined): Record<number, string> {
  const out: Record<number, string> = {};
  rows.forEach((r, i) => {
    const n = historyNote(r, prev.get(r.item_code), version);
    if (n) out[i] = n;
  });
  return out;
}
