// Phase 2 — compare two extractions of the SAME form page (same {store · period ·
// version · page} key), so a re-upload shows WHAT differs before a reviewer decides
// which copy to keep. Pure (no network/DB) so it unit-tests. Flag-only: this never
// chooses a winner, it only surfaces the differences.

/** The five handwritten count fields compared between two reads of a page. */
export const COUNT_FIELDS = ['stockroom', 'drawer', 'selling_area', 'delivery', 'ending_on_hand'] as const;
export type CountField = (typeof COUNT_FIELDS)[number];

/** Minimal row shape the diff needs (a subset of the extracted row). */
export type DiffRow = {item_code: string} & Partial<Record<CountField, number | null>>;

/** One field that differs between the two reads of an item. */
export type FieldDelta = {field: CountField; from: number | null; to: number | null};

/** One item that differs, added, or removed between the two reads. */
export type RowDelta = {
  item_code: string;
  kind: 'changed' | 'added' | 'removed'; // added = only in current, removed = only in prior
  fields: FieldDelta[];
};

export type ExtractionDiff = {
  identical: boolean;
  changed: RowDelta[]; // items present in both whose counts differ
  added: RowDelta[]; // items only in the current read
  removed: RowDelta[]; // items only in the prior read
  /** Count of items with any difference (changed + added + removed). */
  differingItems: number;
};

function byCode(rows: DiffRow[]): Map<string, DiffRow> {
  const m = new Map<string, DiffRow>();
  for (const r of rows) if (r && typeof r.item_code === 'string') m.set(r.item_code, r);
  return m;
}

const val = (r: DiffRow, f: CountField): number | null => {
  const v = r[f];
  return typeof v === 'number' ? v : null;
};

/**
 * Diff the CURRENT read against the PRIOR read of the same page. "from" is the prior
 * value, "to" is the current one, so a reviewer reads it as "what this new upload
 * changes". Only the five count fields are compared; confidence/marks are ignored.
 */
export function diffExtractions(current: DiffRow[], prior: DiffRow[]): ExtractionDiff {
  const cur = byCode(current);
  const old = byCode(prior);
  const changed: RowDelta[] = [];
  const added: RowDelta[] = [];
  const removed: RowDelta[] = [];

  for (const [code, c] of cur) {
    const p = old.get(code);
    if (!p) {
      added.push({item_code: code, kind: 'added', fields: COUNT_FIELDS.filter((f) => val(c, f) != null).map((f) => ({field: f, from: null, to: val(c, f)}))});
      continue;
    }
    const fields = COUNT_FIELDS.filter((f) => val(c, f) !== val(p, f)).map((f) => ({field: f, from: val(p, f), to: val(c, f)}));
    if (fields.length) changed.push({item_code: code, kind: 'changed', fields});
  }
  for (const [code, p] of old) {
    if (!cur.has(code)) {
      removed.push({item_code: code, kind: 'removed', fields: COUNT_FIELDS.filter((f) => val(p, f) != null).map((f) => ({field: f, from: val(p, f), to: null}))});
    }
  }

  const differingItems = changed.length + added.length + removed.length;
  return {identical: differingItems === 0, changed, added, removed, differingItems};
}
