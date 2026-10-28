// Goldline supply planning (pure, unit-tested) — the numbers behind the combined
// Inventory board. Builds on storeMovement (status, cover, stock-out date, suggested
// order) and adds the warehouse side the business asked for:
//
//   Benta per month              → perMonth: recent pace per day × 30.4
//   How many months will it last → monthsLeft: on hand ÷ perMonth
//   Ilan ung need ng <store>     → need: the suggested top-up, less what's already on the way
//   Ilan pa ung nasa warehouse   → warehouse on hand (sample data until real figures arrive)
//   Gano katagal umabot sa store → transit days per store → ship by / arrives
//   Gano katagal gumawa          → production days per product line → produce by
//
// Rules:
// • Ship by = the store's stock-out date − its transit days ("Now" once that's today or
//   past, or the item is already out). Arrives = today + transit days, if sent today.
// • A shipment is in transit until the store's latest count covers its arrival date
//   (that count's "Delivery" column records it), so it's never counted twice.
// • Warehouse, per item, across every store loaded: after covering all stores' needs,
//   what's left lasts (left ÷ total daily pace) days → produce by = that date − the
//   line's production days ("Now" when that's past, or the needs already exceed stock).

import {addDays, daysBetween, type ItemMovement} from './goldline-movement';
import type {InventoryRowIn} from './goldline-inventory';

export const DAYS_PER_MONTH = 30.4;

/** Today's date in the Philippines (the business's day), not the server's UTC date. */
export const manilaDate = (d: Date = new Date()) => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Manila'}).format(d);

export type SupplyConfig = {
  defaultProductionDays: number;
  defaultTransitDays: number;
  lineProductionDays: Record<string, number>; // product line → days
  storeTransitDays: Record<string, number>; // store code → days
  isSample: boolean; // any value still a seeded sample
};

export type Shipment = {id: string; storeCode: string; itemCode: string; qty: number; shippedOn: string; arrivesOn: string};

export type StoreBlock = {
  storeCode: string;
  storeName: string | null;
  latestEnd: string | null; // the store's latest count (any item)
  cycleDays: number | null;
  items: Array<{
    itemCode: string;
    movement: ItemMovement;
    row: InventoryRowIn | null; // the latest count's row for this item
    monthly: Map<string, number>; // YYYY-MM → units sold
  }>;
};

export type CatalogItem = {name: string; productLine: string | null; price: number | null; bestseller: boolean; hidden: boolean; retired?: boolean};

export type DateOrNow = {kind: 'now'} | {kind: 'date'; date: string} | null;

export type BoardRow = {
  itemCode: string;
  name: string;
  productLine: string | null;
  price: number | null;
  bestseller: boolean;
  hidden: boolean;
  retired: boolean; // no longer sold: left out of SKU matching and the restock (F2)
  status: ItemMovement['status'] | 'not_moving';
  storesNeeding: number; // all-stores view: stores out or to reorder
  storesCounted: number;
  onHand: number | null;
  backRoom: number | null; // stockroom + drawer
  display: number | null; // selling area
  delivered: number | null; // delivery column of the latest count (F9)
  trend: [number | null, number | null, number | null]; // two months ago → this month
  thisMonth: number | null;
  lastMonth: number | null;
  threeMonths: number | null;
  perMonth: number | null;
  coverDays: number | null; // Infinity = nothing selling
  stockOutDate: string | null;
  suggested: number; // top-up to target cover (before what's in transit)
  inTransit: {qty: number; arrivesOn: string} | null;
  need: number; // suggested − in transit
  transitDays: number | null; // single store only
  shipBy: DateOrNow;
  arrivesIfSentToday: string | null; // single store only
  warehouse: number | null;
  warehouseAfterNeeds: number | null; // warehouse − every store's need
  warehouseShort: boolean;
  productionDays: number;
  produceBy: DateOrNow;
};

export type BoardSummary = {
  rows: number;
  reorder: number; // out or reorder
  out: number;
  shipNow: number;
  warehouseShort: number;
  produceSoon: number; // produce by within PRODUCE_SOON_DAYS (or now)
  // F9 · peso value at selling price (the catalog price; no cost or margin in v1).
  stockValue: number; // on hand × price, counted and priced rows
  deliveredValue: number; // latest count's delivery × price
  deliveredUnits: number;
  unpriced: number; // counted rows with no price (left out of the values)
};

export const PRODUCE_SOON_DAYS = 14;
const STATUS_RANK: Record<BoardRow['status'], number> = {out: 0, reorder: 1, watch: 2, healthy: 3, not_moving: 4, no_history: 5, not_counted: 6};

export const transitDaysFor = (cfg: SupplyConfig, store: string) => cfg.storeTransitDays[store] ?? cfg.defaultTransitDays;
export const productionDaysFor = (cfg: SupplyConfig, line: string | null) => (line != null ? cfg.lineProductionDays[line] : undefined) ?? cfg.defaultProductionDays;

const perDayOf = (mv: ItemMovement, cycleDays: number | null) => (mv.velocity != null && cycleDays ? mv.velocity / cycleDays : null);
const dateOrNow = (date: string | null, today: string): DateOrNow => (date == null ? null : date <= today ? {kind: 'now'} : {kind: 'date', date});
const earliest = (xs: DateOrNow[]): DateOrNow => {
  if (xs.some((x) => x?.kind === 'now')) return {kind: 'now'};
  const ds = xs.filter((x): x is {kind: 'date'; date: string} => x?.kind === 'date').map((x) => x.date).sort();
  return ds.length ? {kind: 'date', date: ds[0]} : null;
};
const sum = (xs: Array<number | null>) => (xs.some((x) => x != null) ? xs.reduce<number>((a, b) => a + (b ?? 0), 0) : null);
export const addMonthKey = (key: string, n: number) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};

/** Shipments still on the way to a store (arrival after its latest count). */
export function inTransitFor(shipments: Shipment[], store: string, item: string, storeLatestEnd: string | null) {
  const open = shipments.filter((s) => s.storeCode === store && s.itemCode === item && (storeLatestEnd == null || s.arrivesOn > storeLatestEnd));
  if (!open.length) return null;
  return {qty: open.reduce((a, s) => a + s.qty, 0), arrivesOn: open.map((s) => s.arrivesOn).sort()[0]};
}

type Cell = {
  store: StoreBlock;
  mv: ItemMovement;
  row: InventoryRowIn | null;
  monthly: Map<string, number>;
  perDay: number | null;
  inTransit: {qty: number; arrivesOn: string} | null;
  need: number;
  shipBy: DateOrNow;
  status: BoardRow['status'];
};

/**
 * The board: one row per item. `store` picks one store's view (null = all stores added
 * up). Warehouse figures always weigh every store in `stores` (the warehouse serves them all).
 */
export function buildBoard(input: {
  stores: StoreBlock[];
  catalog: Record<string, CatalogItem>;
  warehouse: Record<string, number>;
  config: SupplyConfig;
  shipments: Shipment[];
  currentMonth: string; // YYYY-MM
  today: string; // YYYY-MM-DD
  store: string | null;
}): BoardRow[] {
  const {stores, catalog, warehouse, config, shipments, currentMonth, today} = input;
  const months = [addMonthKey(currentMonth, -2), addMonthKey(currentMonth, -1), currentMonth];

  // Every store × item cell.
  const byItem = new Map<string, Cell[]>();
  for (const st of stores) {
    for (const it of st.items) {
      const perDay = perDayOf(it.movement, st.cycleDays);
      const inTransit = inTransitFor(shipments, st.storeCode, it.itemCode, st.latestEnd);
      const need = Math.max(0, it.movement.suggestedOrder - (inTransit?.qty ?? 0));
      const transit = transitDaysFor(config, st.storeCode);
      // Nothing left to send once what's on the way covers the need.
      const covered = inTransit != null && need === 0;
      const shipBy: DateOrNow = covered
        ? null
        : it.movement.status === 'out'
          ? {kind: 'now'}
          : it.movement.stockOutDate && it.movement.status !== 'not_counted'
            ? dateOrNow(addDays(it.movement.stockOutDate, -transit), today)
            : null;
      const status: BoardRow['status'] = it.movement.deadStock ? 'not_moving' : it.movement.status;
      const cells = byItem.get(it.itemCode) ?? [];
      cells.push({store: st, mv: it.movement, row: it.row, monthly: it.monthly, perDay, inTransit, need, shipBy, status});
      byItem.set(it.itemCode, cells);
    }
  }

  const rows: BoardRow[] = [];
  for (const [itemCode, all] of byItem) {
    const c = catalog[itemCode] ?? {name: itemCode, productLine: null, price: null, bestseller: false, hidden: false, retired: false};
    const cells = input.store ? all.filter((x) => x.store.storeCode === input.store) : all;
    if (!cells.length) continue;

    // Warehouse — across every store it serves.
    const wh = warehouse[itemCode] ?? null;
    const totalNeed = all.reduce((a, x) => a + x.need, 0);
    const totalPerDay = all.reduce((a, x) => a + (x.perDay ?? 0), 0);
    const productionDays = productionDaysFor(config, c.productLine);
    const after = wh == null ? null : wh - totalNeed;
    let produceBy: DateOrNow = null;
    if (after != null) {
      if (after < 0) produceBy = {kind: 'now'};
      else if (totalPerDay > 0) produceBy = dateOrNow(addDays(addDays(today, after / totalPerDay), -productionDays), today);
    }

    const counted = cells.filter((x) => x.mv.onHand != null);
    const onHand = sum(counted.map((x) => x.mv.onHand));
    const perDay = cells.some((x) => x.perDay != null) ? cells.reduce((a, x) => a + (x.perDay ?? 0), 0) : null;
    const monthly = months.map((m) => sum(cells.map((x) => (x.monthly.has(m) ? (x.monthly.get(m) as number) : null))));
    const status = cells.map((x) => x.status).sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b])[0];
    const inTransitQty = cells.reduce((a, x) => a + (x.inTransit?.qty ?? 0), 0);
    const single = cells.length === 1 && input.store ? cells[0] : null;
    const coverDays = single ? single.mv.coverDays : onHand == null || perDay == null ? null : perDay > 0 ? onHand / perDay : onHand > 0 ? Infinity : 0;

    rows.push({
      itemCode,
      name: c.name,
      productLine: c.productLine,
      price: c.price,
      bestseller: c.bestseller,
      hidden: c.hidden,
      retired: Boolean(c.retired),
      status,
      storesNeeding: cells.filter((x) => x.mv.status === 'out' || x.mv.status === 'reorder').length,
      storesCounted: counted.length,
      onHand,
      backRoom: sum(counted.map((x) => (x.row ? sum([x.row.stockroom, x.row.drawer]) : null))),
      display: sum(counted.map((x) => x.row?.selling_area ?? null)),
      delivered: sum(counted.map((x) => x.row?.delivery ?? null)),
      trend: monthly as BoardRow['trend'],
      thisMonth: monthly[2],
      lastMonth: monthly[1],
      threeMonths: sum(monthly),
      perMonth: perDay == null ? null : Math.round(perDay * DAYS_PER_MONTH),
      coverDays,
      stockOutDate: single
        ? single.mv.stockOutDate
        : coverDays != null && Number.isFinite(coverDays)
          ? addDays(cells.map((x) => x.store.latestEnd).filter(Boolean).sort().pop() ?? today, Math.floor(coverDays))
          : null,
      suggested: cells.reduce((a, x) => a + x.mv.suggestedOrder, 0),
      inTransit: inTransitQty ? {qty: inTransitQty, arrivesOn: cells.map((x) => x.inTransit?.arrivesOn).filter((d): d is string => !!d).sort()[0]} : null,
      need: cells.reduce((a, x) => a + x.need, 0),
      transitDays: single ? transitDaysFor(config, single.store.storeCode) : null,
      shipBy: earliest(cells.map((x) => x.shipBy)),
      arrivesIfSentToday: single ? addDays(today, transitDaysFor(config, single.store.storeCode)) : null,
      warehouse: wh,
      warehouseAfterNeeds: after,
      warehouseShort: after != null && after < 0,
      productionDays,
      produceBy,
    });
  }
  return rows;
}

/** The summary tiles double as table filters; one predicate per tile keeps a tile's count and its filtered rows in step. */
export type BoardFocus = 'reorder' | 'out' | 'shipNow' | 'warehouseShort' | 'produceSoon';

export function inFocus(r: BoardRow, focus: BoardFocus, today: string): boolean {
  switch (focus) {
    case 'reorder':
      return r.status === 'out' || r.status === 'reorder';
    case 'out':
      return r.status === 'out';
    case 'shipNow':
      return r.shipBy?.kind === 'now' && r.need > 0;
    case 'warehouseShort':
      return r.warehouseShort;
    case 'produceSoon':
      return r.produceBy?.kind === 'now' || (r.produceBy?.kind === 'date' && r.produceBy.date <= addDays(today, PRODUCE_SOON_DAYS));
  }
}

export function boardSummary(rows: BoardRow[], today: string): BoardSummary {
  const visible = rows.filter((r) => !r.hidden);
  const count = (f: BoardFocus) => visible.filter((r) => inFocus(r, f, today)).length;
  return {
    rows: visible.length,
    reorder: count('reorder'),
    out: count('out'),
    shipNow: count('shipNow'),
    warehouseShort: count('warehouseShort'),
    produceSoon: count('produceSoon'),
    stockValue: visible.reduce((a, r) => a + (r.price != null && r.onHand != null && r.onHand > 0 ? r.onHand * r.price : 0), 0),
    deliveredValue: visible.reduce((a, r) => a + (r.price != null && r.delivered ? r.delivered * r.price : 0), 0),
    deliveredUnits: visible.reduce((a, r) => a + (r.delivered ?? 0), 0),
    unpriced: visible.filter((r) => r.price == null && r.onHand != null).length,
  };
}

/** "~12 days" under ~6 weeks, else "~2.1 mo" (the business thinks in months). */
export function lastsLabel(coverDays: number | null): string | null {
  if (coverDays == null) return null;
  if (!Number.isFinite(coverDays)) return 'not selling';
  if (coverDays < 1) return 'runs out';
  if (coverDays < 45) return `~${Math.floor(coverDays)} days`;
  return `~${(coverDays / DAYS_PER_MONTH).toFixed(1)} mo`;
}

export const sortRank = (s: BoardRow['status']) => STATUS_RANK[s];
export {daysBetween};
