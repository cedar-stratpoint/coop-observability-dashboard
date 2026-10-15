// Pure logic behind the Goldline Inventory page (no I/O, unit-tested). Input is the
// committed gl_inventory rows for ONE store × form period — i.e. the semi-monthly
// handwritten form after review — plus the catalog (gl_products) and the printed
// form manifests (page order + shade names).
//
// Rules (stated on the page too, so nobody has to guess):
// • On hand = the form's "Ending" column when the consultant wrote it; otherwise the
//   sum of the three physical counts (stockroom + drawer + selling area). Delivery is
//   what arrived during the period — already inside the physical counts — so it is
//   not added again.
// • A blank form row is NOT zero. If nothing was written, the item is "Not counted",
//   never "Out of stock".
// • Status: 0 on hand → Out; fewer than LOW_STOCK_AT → Low; otherwise OK.
// • Value = on hand × catalog unit price; unknown when the item has no price yet.

export const LOW_STOCK_AT = 10;
export const FORM_PAGES = [1, 2, 3, 4, 5] as const;

export type InventoryRowIn = {
  item_code: string;
  stockroom: number | null;
  drawer: number | null;
  selling_area: number | null;
  delivery: number | null;
  ending_on_hand: number | null;
};

export type CatalogEntry = {productLine: string | null; variant: string | null; unitPrice: number | null; bestseller: boolean};
export type ManifestEntry = {page: number; index: number; shade: string};

export type StockStatus = 'ok' | 'low' | 'out' | 'uncounted';

export type InventoryItem = InventoryRowIn & {
  name: string; // shade / variant as printed
  productLine: string | null;
  bestseller: boolean;
  page: number | null; // form page the item is printed on
  onHand: number | null;
  onHandSource: 'ending' | 'counted' | null;
  unitPrice: number | null;
  value: number | null;
  status: StockStatus;
};

export type InventorySummary = {
  items: InventoryItem[]; // form order (page, then printed position)
  tracked: number; // rows committed for this store + period
  counted: number; // rows with an on-hand figure
  low: number;
  out: number;
  uncounted: number;
  value: number; // sum over priced, counted rows
  pricedCounted: number;
  unpricedCounted: number;
};

const n = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export function onHandOf(r: InventoryRowIn): {onHand: number | null; source: 'ending' | 'counted' | null} {
  if (n(r.ending_on_hand)) return {onHand: r.ending_on_hand, source: 'ending'};
  const parts = [r.stockroom, r.drawer, r.selling_area].filter(n);
  if (!parts.length) return {onHand: null, source: null};
  return {onHand: parts.reduce((a, b) => a + b, 0), source: 'counted'};
}

export function stockStatus(onHand: number | null): StockStatus {
  if (onHand == null) return 'uncounted';
  if (onHand <= 0) return 'out';
  if (onHand < LOW_STOCK_AT) return 'low';
  return 'ok';
}

export function buildInventory(
  rows: InventoryRowIn[],
  catalog: Map<string, CatalogEntry>,
  manifest: Map<string, ManifestEntry>,
): InventorySummary {
  const items: InventoryItem[] = rows.map((r) => {
    const c = catalog.get(r.item_code);
    const m = manifest.get(r.item_code);
    const {onHand, source} = onHandOf(r);
    const unitPrice = n(c?.unitPrice) ? (c?.unitPrice as number) : null;
    return {
      ...r,
      name: c?.variant?.trim() || m?.shade || r.item_code,
      productLine: c?.productLine?.trim() || null,
      bestseller: Boolean(c?.bestseller),
      page: m?.page ?? null,
      onHand,
      onHandSource: source,
      unitPrice,
      value: onHand != null && unitPrice != null ? onHand * unitPrice : null,
      status: stockStatus(onHand),
    };
  });

  // Form order: printed page, then printed position; unknown codes last, A–Z.
  items.sort((a, b) => {
    const ma = manifest.get(a.item_code);
    const mb = manifest.get(b.item_code);
    if (ma && mb) return ma.page - mb.page || ma.index - mb.index;
    if (ma) return -1;
    if (mb) return 1;
    return a.item_code.localeCompare(b.item_code);
  });

  let value = 0;
  let pricedCounted = 0;
  let unpricedCounted = 0;
  for (const it of items) {
    if (it.onHand == null) continue;
    if (it.value != null) {
      value += it.value;
      pricedCounted++;
    } else unpricedCounted++;
  }
  const count = (s: StockStatus) => items.filter((i) => i.status === s).length;
  return {
    items,
    tracked: items.length,
    counted: items.length - count('uncounted'),
    low: count('low'),
    out: count('out'),
    uncounted: count('uncounted'),
    value,
    pricedCounted,
    unpricedCounted,
  };
}

export type Snapshot = {
  store_code: string;
  period_start: string;
  period_end: string;
  items: number;
  uploads: number;
  consultant: string | null;
  last_committed_at: string | null;
};

/** "2026-10-01_2026-10-15" — the URL form of a period. */
export const periodParam = (s: {period_start: string; period_end: string}) => `${s.period_start}_${s.period_end}`;

/**
 * The snapshot to show. A requested store/period wins when it exists; otherwise the
 * latest period (by end date), and within it the requested store if present, else
 * the lowest store code. Null when there's nothing committed yet.
 */
export function pickSnapshot(snapshots: Snapshot[], store?: string | null, period?: string | null): Snapshot | null {
  if (!snapshots.length) return null;
  const exact = snapshots.find((s) => s.store_code === store && periodParam(s) === period);
  if (exact) return exact;
  const byStore = store ? snapshots.filter((s) => s.store_code === store) : [];
  // A period on its own still narrows the choice (lowest store code within it).
  const byPeriod = !byStore.length && period ? snapshots.filter((s) => periodParam(s) === period) : [];
  const pool = byStore.length ? byStore : byPeriod.length ? byPeriod : snapshots;
  return [...pool].sort(
    (a, b) =>
      b.period_end.localeCompare(a.period_end) ||
      b.period_start.localeCompare(a.period_start) ||
      a.store_code.localeCompare(b.store_code, undefined, {numeric: true}),
  )[0];
}

/** Which of the form's inventory pages (1–5) are in for this snapshot, and which aren't. */
export function pageCoverage(pages: Array<number | null | undefined>): {have: number[]; missing: number[]} {
  const have = [...new Set(pages.filter((p): p is number => typeof p === 'number' && FORM_PAGES.includes(p as 1)))].sort(
    (a, b) => a - b,
  );
  return {have, missing: FORM_PAGES.filter((p) => !have.includes(p))};
}
