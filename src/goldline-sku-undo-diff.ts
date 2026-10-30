// Undo for SKU linking (Oct 29): the pure half. A decision is recorded as the rows it
// actually changed, before and after, across four places: our items' link and retire
// fields, Coop's suggestion per Watsons SKU, the latest decision per SKU, and the latest
// note per item. Rejecting re-runs Coop's matching, which can touch other SKUs too, so
// the diff covers every row that moved, not just the one clicked. Undo restores `before`,
// but only while every changed row still equals `after` (so it never overwrites later
// work), and the confirm dialog explains each change in plain words (`undoEffects`).

export type Row = Record<string, unknown>;
export type Snap = {
  products: Record<string, Row>; // item_code -> link and retire fields
  chain: Record<string, Row>; // sku_code -> suggestion and dismissal fields
  review: Record<string, Row | null>; // sku_code -> latest decision row (or none)
  notes: Record<string, Row | null>; // item_code -> latest note row (or none)
};
export type Section = keyof Snap;
const SECTIONS: Section[] = ['products', 'chain', 'review', 'notes'];

export const PRODUCT_FIELDS = ['sku_code', 'sku_linked_by', 'sku_linked_at', 'category', 'retired_at', 'retired_by', 'retired_remark'] as const;
export const CHAIN_FIELDS = ['suggested_item_code', 'match_score', 'match_tier', 'dismissed_item_codes'] as const;
export const REVIEW_FIELDS = ['action', 'item_code', 'action_by', 'action_at', 'remark', 'remark_by', 'remark_at'] as const;
export const NOTE_FIELDS = ['note', 'note_by', 'note_at'] as const;

/** A stable form for comparing rows: sorted keys, numbers as numbers, timestamps as instants. */
export function norm(v: unknown): string {
  const n = (x: unknown): unknown => {
    if (x == null) return null;
    if (Array.isArray(x)) return [...x].map(n).sort();
    if (typeof x === 'object') return Object.fromEntries(Object.keys(x as Row).sort().map((k) => [k, n((x as Row)[k])]));
    if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(x) && !Number.isNaN(Date.parse(x))) return new Date(x).toISOString();
    if (typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x)) return Number(x);
    return x;
  };
  return JSON.stringify(n(v));
}

const same = (a: unknown, b: unknown) => norm(a) === norm(b);

/** Only the rows that changed, with their values before and after. */
export function diffSnaps(before: Snap, after: Snap): {before: Snap; after: Snap; changed: number} {
  const b: Snap = {products: {}, chain: {}, review: {}, notes: {}};
  const a: Snap = {products: {}, chain: {}, review: {}, notes: {}};
  let changed = 0;
  for (const s of SECTIONS) {
    const keys = new Set([...Object.keys(before[s]), ...Object.keys(after[s])]);
    for (const k of keys) {
      const x = before[s][k] ?? null;
      const y = after[s][k] ?? null;
      if (same(x, y)) continue;
      (b[s] as Record<string, Row | null>)[k] = x;
      (a[s] as Record<string, Row | null>)[k] = y;
      changed++;
    }
  }
  return {before: b, after: a, changed};
}

/** The changed rows whose current value no longer matches what the decision left. */
export function driftedRows(after: Snap, current: Snap): string[] {
  const out: string[] = [];
  for (const s of SECTIONS) for (const k of Object.keys(after[s])) if (!same(after[s][k] ?? null, current[s][k] ?? null)) out.push(`${s}:${k}`);
  return out;
}

const str = (v: unknown) => (v == null || v === '' ? null : String(v));
const ACTION_PAST: Record<string, string> = {approved: 'approved', rejected: 'rejected', linked: 'linked', unlinked: 'unlinked'};

/**
 * What undoing will do, one plain sentence per change, the clicked SKU or item first.
 * `before` and `after` are a recorded decision's changed rows.
 */
export function undoEffects(before: Snap, after: Snap, focus?: {target: 'sku' | 'item'; key: string}): string[] {
  const g = undoEffectGroups(before, after, focus);
  return [...g.here, ...g.elsewhere];
}

/** The same sentences split: changes to the clicked SKU or item, and changes elsewhere (Coop's re-matching). */
export function undoEffectGroups(before: Snap, after: Snap, focus?: {target: 'sku' | 'item'; key: string}): {here: string[]; elsewhere: string[]} {
  const lines: Array<{text: string; first: boolean}> = [];
  const add = (text: string, first: boolean) => lines.push({text, first});

  for (const item of Object.keys(after.products)) {
    const was = before.products[item] ?? {};
    const now = after.products[item] ?? {};
    const first = focus?.target === 'item' ? focus.key === item : str(was.sku_code) === focus?.key || str(now.sku_code) === focus?.key;
    const ws = str(was.sku_code);
    const ns = str(now.sku_code);
    if (ws !== ns) {
      if (ns && !ws) add(`Unlink Watsons SKU ${ns} from ${item}. Its sales stop counting for ${item}.`, first);
      else if (ws && !ns) add(`Link Watsons SKU ${ws} to ${item} again. Its sales count for ${item} again.`, first);
      else add(`Link ${item} back to Watsons SKU ${ws} instead of ${ns}.`, first);
    }
    const wr = str(was.retired_at);
    const nr = str(now.retired_at);
    if (Boolean(wr) !== Boolean(nr)) {
      if (nr) add(`Bring ${item} back: it returns to "Sold at Watsons?", SKU matching and restock.`, first);
      else add(`Mark ${item} as decommissioned again${str(was.retired_remark) ? ` (“${str(was.retired_remark)}”)` : ''}.`, first);
    }
  }

  for (const sku of Object.keys(after.chain)) {
    const was = before.chain[sku] ?? {};
    const now = after.chain[sku] ?? {};
    const first = focus?.target === 'sku' && focus.key === sku;
    const ws = str(was.suggested_item_code);
    const ns = str(now.suggested_item_code);
    if (ws !== ns) {
      if (ws && !ns) add(`Coop's suggestion ${ws} comes back for Watsons SKU ${sku}, under "Check Coop's match".`, first);
      else if (ns && !ws) add(`Coop's suggestion ${ns} for Watsons SKU ${sku} goes away.`, first);
      else add(`Coop's suggestion for Watsons SKU ${sku} goes back to ${ws} (from ${ns}).`, first);
    }
    const wd = new Set(((was.dismissed_item_codes as string[] | null) ?? []).map(String));
    const nd = ((now.dismissed_item_codes as string[] | null) ?? []).map(String).filter((c) => !wd.has(c));
    for (const c of nd) add(`Coop may suggest ${c} for Watsons SKU ${sku} again (it was turned down).`, first);
  }

  for (const sku of Object.keys(after.review)) {
    const was = before.review[sku];
    const now = after.review[sku];
    const first = focus?.target === 'sku' && focus.key === sku;
    if (!was) {
      add(`The decision on Watsons SKU ${sku} is cleared.`, first);
      continue;
    }
    if (str(was.action) !== str(now?.action) || str(was.item_code) !== str(now?.item_code)) {
      const act = str(was.action);
      add(act ? `The decision on Watsons SKU ${sku} goes back to "${ACTION_PAST[act] ?? act}${str(was.item_code) ? ` ${str(was.item_code)}` : ''}"${str(was.action_by) ? ` by ${str(was.action_by)}` : ''}.` : `The decision on Watsons SKU ${sku} is cleared.`, first);
    }
    if (str(was.remark) !== str(now?.remark)) add(str(was.remark) ? `The remark goes back to “${str(was.remark)}”.` : 'The remark is removed.', first);
  }

  for (const item of Object.keys(after.notes)) {
    const was = before.notes[item];
    const first = focus?.target === 'item' && focus.key === item;
    add(was ? `The note on ${item} goes back to “${str(was.note)}”.` : `The note on ${item} is removed.`, first);
  }

  if (!focus) return {here: lines.map((l) => l.text), elsewhere: []};
  return {here: lines.filter((l) => l.first).map((l) => l.text), elsewhere: lines.filter((l) => !l.first).map((l) => l.text)};
}
