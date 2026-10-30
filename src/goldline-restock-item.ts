// Goldline Restock · one product (pure, unit-tested). The product page under Restock:
// the product's last 12 months of POS Sales Data, then the run's months forecast from last
// year's same months, with stock on hand running down with and without the send.
//
// Decided Oct 28: "a year" = the 12 months before the run (salesYear, the Inputs month
// strip), then the run's window. Each store's line is worked out by the same F10 and F11
// code the run uses (buildForecastLines, buildRecommendations), for this product only; the
// warehouse cap is per product, so it stays exact. When the half month's run is saved, its
// line (and the owner's decision) wins over the live numbers.

import {buildForecastLines, type ForecastWindow, type HoldReason, type MonthStatus} from './goldline-forecast';
import {buildRecommendations, lineState, type Decision, type RunLineState, type StoreCount} from './goldline-restock';
import type {Shipment} from './goldline-supply';

export type YearMonth = {month: string; loaded: boolean; units: number | null; inWindow: boolean; safety: boolean};

/** The 12 months before the run, summed over the stores in view. Not loaded = null. */
export function itemYear(year: MonthStatus[], window: ForecastWindow, units: number[]): YearMonth[] {
  const inWindow = new Set(window.lastYear);
  const safety = new Set(window.safety);
  return year.map((m, i) => ({month: m.month, loaded: m.loaded, units: m.loaded ? (units[i] ?? 0) : null, inWindow: inWindow.has(m.month), safety: safety.has(m.month)}));
}

export type ProjectionMonth = {month: string; lastYear: string; units: number | null; stockWith: number | null; stockWithout: number | null};

/**
 * The run's months: each sells what the same month sold last year. Stock with the send
 * starts at have + send (the send lands at the start of the window); without it, it runs
 * down from have and stops at 0. With the full send it ends at the safety stock.
 */
export function itemProjection(input: {window: ForecastWindow; lastYearUnits: Array<number | null>; have: number | null; send: number | null}): ProjectionMonth[] {
  const {window, lastYearUnits, have, send} = input;
  let sold = 0;
  let known = have != null;
  return window.months.map((month, i) => {
    const u = lastYearUnits[i] ?? null;
    if (u == null) known = false;
    else sold += u;
    return {
      month,
      lastYear: window.lastYear[i],
      units: u,
      stockWith: known && send != null ? have! + send - sold : null,
      stockWithout: known ? Math.max(0, have! - sold) : null,
    };
  });
}

export type SavedLine = {id: string; suggested: number | null; rawSend: number | null; warehouseShort: boolean; holds: HoldReason[]; decision: Decision; finalQty: number | null; remark: string | null};

export type ItemStoreLine = {
  storeCode: string;
  lyUnits: Array<number | null>; // the window's last-year months
  need: number | null;
  safety: number | null;
  onHand: number | null;
  onHandPeriodEnd: string | null;
  onTheWay: number;
  rawSend: number | null;
  suggested: number | null;
  warehouseShort: boolean;
  holds: HoldReason[];
  state: RunLineState;
  saved: boolean; // from the half month's saved run (false = live preview)
  decision: Decision | null;
  finalQty: number | null;
  remark: string | null;
  id: string | null;
};

/** What a line sends: the owner's number once decided, else the suggestion. */
export const sendOf = (l: Pick<ItemStoreLine, 'state' | 'decision' | 'finalQty' | 'suggested'>) =>
  l.state !== 'send' ? (l.state === 'covered' ? 0 : null) : l.decision && l.decision !== 'pending' ? (l.finalQty ?? 0) : (l.suggested ?? 0);

/**
 * Every store's line for one product. Mirrors makeRestockRun: lines the owner already
 * decided keep their numbers and take their units off the warehouse first; the rest are
 * worked out live and capped. A saved line then replaces the live one.
 */
export function itemStoreLines(input: {
  itemCode: string;
  window: ForecastWindow;
  months: MonthStatus[];
  history: Array<{storeCode: string; units: number[]}>; // aligned with window.lastYear
  inScope: Set<string>;
  retired: boolean;
  openFlagStores: Set<string>;
  counts: Map<string, StoreCount>; // each store's latest count (onHand holds this item only)
  shipments: Shipment[];
  warehouse: number | null; // this item's warehouse on hand (null = no row)
  saved: Map<string, SavedLine>; // store → its line in the saved run
}): ItemStoreLine[] {
  const {itemCode, window, saved} = input;
  const counted = [...input.counts].filter(([, c]) => c.onHand.has(itemCode)).map(([storeCode]) => ({storeCode, itemCode}));
  const lines = buildForecastLines({
    window,
    months: input.months,
    history: input.history.map((h) => ({...h, itemCode})),
    inScope: input.inScope,
    retired: input.retired ? new Set([itemCode]) : new Set(),
    openFlags: new Set([...input.openFlagStores].map((s) => `${s}|${itemCode}`)),
    counted,
  });
  const decided = (s: string) => {
    const d = saved.get(s)?.decision;
    return d != null && d !== 'pending';
  };
  const reserved = [...saved.values()].reduce((a, l) => a + (l.decision === 'approved' || l.decision === 'edited' ? (l.finalQty ?? 0) : 0), 0);
  const live = buildRecommendations({
    lines: lines.filter((l) => !decided(l.storeCode)),
    counts: input.counts,
    shipments: input.shipments,
    warehouse: input.warehouse == null ? {} : {[itemCode]: input.warehouse},
    reserved: {[itemCode]: reserved},
  });
  const liveBy = new Map(live.map((r) => [r.storeCode, r]));
  // Decided lines skipped the live math; give them their inputs back for display.
  const inputsOnly = new Map(
    buildRecommendations({lines: lines.filter((l) => decided(l.storeCode)), counts: input.counts, shipments: input.shipments, warehouse: {[itemCode]: Number.MAX_SAFE_INTEGER}}).map((r) => [r.storeCode, r]),
  );

  return lines.map((l) => {
    const r = liveBy.get(l.storeCode) ?? inputsOnly.get(l.storeCode)!;
    const s = saved.get(l.storeCode);
    const base = {
      storeCode: l.storeCode,
      lyUnits: r.lyUnits,
      need: r.need,
      safety: r.safety,
      onHand: r.onHand,
      onHandPeriodEnd: r.onHandPeriodEnd,
      onTheWay: r.onTheWay,
    };
    if (s) {
      return {...base, rawSend: s.rawSend, suggested: s.suggested, warehouseShort: s.warehouseShort, holds: s.holds, state: lineState(s), saved: true, decision: s.decision, finalQty: s.finalQty, remark: s.remark, id: s.id};
    }
    return {...base, rawSend: r.rawSend, suggested: r.suggested, warehouseShort: r.warehouseShort, holds: r.holds, state: lineState(r), saved: false, decision: null, finalQty: null, remark: null, id: null};
  });
}

export type ItemTotals = {
  stores: number;
  ready: number; // lines with a number (send or covered)
  held: number;
  need: number; // last year's window, every line
  safety: number;
  onHand: number; // ready lines
  onTheWay: number;
  send: number;
  lyUnits: Array<number | null>; // window months, ready lines (what the projection sells)
};

/** All stores added up. Held lines count in last year's units but not in stock or send. */
export function itemTotals(lines: ItemStoreLine[], monthsInWindow: number): ItemTotals {
  const t: ItemTotals = {stores: lines.length, ready: 0, held: 0, need: 0, safety: 0, onHand: 0, onTheWay: 0, send: 0, lyUnits: Array.from({length: monthsInWindow}, () => 0)};
  for (const l of lines) {
    t.need += l.need ?? 0;
    t.safety += l.safety ?? 0;
    if (l.state === 'held') {
      t.held++;
      continue;
    }
    t.ready++;
    t.onHand += Math.max(0, l.onHand ?? 0);
    t.onTheWay += l.onTheWay;
    t.send += sendOf(l) ?? 0;
    l.lyUnits.forEach((u, i) => {
      const cur = t.lyUnits[i];
      t.lyUnits[i] = u == null || cur == null ? null : cur + u;
    });
  }
  if (!t.ready) t.lyUnits = t.lyUnits.map(() => null);
  return t;
}

/** The Restock product page for an item (codes can contain "/", so it's encoded whole). */
export function restockItemHref(itemCode: string, store?: string | null, asOf?: string | null) {
  const q = new URLSearchParams();
  if (store) q.set('store', store);
  if (asOf) q.set('asOf', asOf);
  return `/stock/restock/${encodeURIComponent(itemCode)}${q.size ? `?${q}` : ''}`;
}
