// Goldline restock recommendations (F11, pure, unit-tested). Turns F10's forecast lines
// into a number to send per store × item.
//
// Decided Oct 26 (meeting) and Oct 28:
// • Send = last year's window (need) − have + last year's safety months, 0 when covered.
//   Have = the store's latest count (on hand) + shipments still on the way.
// • No number without a real on hand: a store with no counted form holds (no_count), and
//   so does a product whose row on the latest form is blank or missing (blank_on_form,
//   decided Oct 28). A negative count counts as 0 (the checks flag it; an open flag
//   already holds the line).
// • Never more than the warehouse: when an item's lines want more than the warehouse holds
//   (less what this run already approved), each is scaled down in proportion, remainders to
//   the largest share, and marked warehouse_short.
// • Score per store = approved as is ÷ decided (approved, edited or rejected).

import {inTransitFor, type Shipment} from './goldline-supply';
import {HOLD_REASONS, type ForecastLine, type HoldReason} from './goldline-forecast';

export type Decision = 'pending' | 'approved' | 'edited' | 'rejected';
export const DECIDED: Decision[] = ['approved', 'edited', 'rejected'];

/** A store's latest count: its period end and on hand per item (null = row with no figure). */
export type StoreCount = {periodEnd: string; onHand: Map<string, number | null>};

export type Recommendation = {
  storeCode: string;
  itemCode: string;
  lyUnits: Array<number | null>;
  need: number | null;
  safety: number | null;
  onHand: number | null; // null = no figure on the form (held)
  onHandPeriodEnd: string | null;
  onTheWay: number;
  rawSend: number | null; // before the warehouse cap
  suggested: number | null; // null = check data first
  warehouseShort: boolean;
  holds: HoldReason[];
};

/** Line half of the working: cover = need + safety; send = cover − have, never below 0. */
export function sendFor(need: number, safety: number, onHand: number | null, onTheWay: number) {
  const have = Math.max(0, onHand ?? 0) + Math.max(0, onTheWay);
  const cover = need + safety;
  return {cover, have, send: Math.max(0, cover - have)};
}

const byOrder = (holds: HoldReason[]) => HOLD_REASONS.filter((r) => holds.includes(r));

export function buildRecommendations(input: {
  lines: ForecastLine[]; // F10's lines, holds included
  counts: Map<string, StoreCount>; // store → its latest count
  shipments: Shipment[]; // in transit
  warehouse: Record<string, number>; // item → warehouse on hand
  reserved?: Record<string, number>; // item → units this run already approved
}): Recommendation[] {
  const recs: Recommendation[] = input.lines.map((l) => {
    const count = input.counts.get(l.storeCode) ?? null;
    const onHand = count ? (count.onHand.get(l.itemCode) ?? null) : null;
    const holds = !count ? byOrder([...l.holds, 'no_count']) : onHand == null ? byOrder([...l.holds, 'blank_on_form']) : [...l.holds];
    const onTheWay = inTransitFor(input.shipments, l.storeCode, l.itemCode, count?.periodEnd ?? null)?.qty ?? 0;
    const ready = !holds.length && l.need != null && l.safety != null;
    const rawSend = ready ? sendFor(l.need!, l.safety!, onHand, onTheWay).send : null;
    return {
      storeCode: l.storeCode,
      itemCode: l.itemCode,
      lyUnits: l.units,
      need: l.need,
      safety: l.safety,
      onHand,
      onHandPeriodEnd: count?.periodEnd ?? null,
      onTheWay,
      rawSend,
      suggested: rawSend,
      warehouseShort: false,
      holds,
    };
  });
  return capToWarehouse(recs, input.warehouse, input.reserved ?? {});
}

/**
 * Scale each item's sends down to what the warehouse can spare (on hand − reserved), in
 * proportion to each store's raw send. Floors first, then the units left over go one each
 * to the largest remainders (ties: larger raw send, then store code). An item with no
 * warehouse row has nothing to spare.
 */
export function capToWarehouse(recs: Recommendation[], warehouse: Record<string, number>, reserved: Record<string, number> = {}): Recommendation[] {
  const byItem = new Map<string, Recommendation[]>();
  for (const r of recs) {
    if (!r.rawSend) continue;
    const xs = byItem.get(r.itemCode) ?? [];
    xs.push(r);
    byItem.set(r.itemCode, xs);
  }
  for (const [item, xs] of byItem) {
    const spare = Math.max(0, (warehouse[item] ?? 0) - (reserved[item] ?? 0));
    const want = xs.reduce((a, r) => a + r.rawSend!, 0);
    if (want <= spare) continue;
    const shares = xs.map((r) => {
      const exact = (r.rawSend! * spare) / want;
      return {r, floor: Math.floor(exact), rest: exact - Math.floor(exact)};
    });
    let left = spare - shares.reduce((a, s) => a + s.floor, 0);
    shares.sort((a, b) => b.rest - a.rest || b.r.rawSend! - a.r.rawSend! || a.r.storeCode.localeCompare(b.r.storeCode, undefined, {numeric: true}));
    for (const s of shares) {
      s.r.suggested = s.floor + (left > 0 ? 1 : 0);
      if (left > 0) left--;
      s.r.warehouseShort = true;
    }
  }
  return recs;
}

export type RunLineState = 'send' | 'covered' | 'held';
export const lineState = (r: Pick<Recommendation, 'suggested' | 'holds'>): RunLineState =>
  r.holds.length || r.suggested == null ? 'held' : r.suggested > 0 ? 'send' : 'covered';
/** Only a line with something to send gets a decision. */
export const decidable = (r: Pick<Recommendation, 'suggested' | 'holds'>) => lineState(r) === 'send';

export type StoreScore = {storeCode: string; decided: number; approved: number; edited: number; rejected: number; pending: number; score: number | null};

/** Per store: approved as is ÷ decided. Pending lines don't count yet; null when none decided. */
export function storeScores(rows: Array<{storeCode: string; decision: Decision; suggested: number | null; holds: HoldReason[]}>): StoreScore[] {
  const by = new Map<string, StoreScore>();
  for (const r of rows) {
    if (r.decision === 'pending' && !decidable(r)) continue;
    const s = by.get(r.storeCode) ?? {storeCode: r.storeCode, decided: 0, approved: 0, edited: 0, rejected: 0, pending: 0, score: null};
    s[r.decision]++;
    if (r.decision !== 'pending') s.decided++;
    by.set(r.storeCode, s);
  }
  for (const s of by.values()) s.score = s.decided ? s.approved / s.decided : null;
  return [...by.values()].sort((a, b) => a.storeCode.localeCompare(b.storeCode, undefined, {numeric: true}));
}

/** One score over many stores (the run's header): approved as is ÷ decided. */
export function overallScore(scores: StoreScore[]): number | null {
  const decided = scores.reduce((a, s) => a + s.decided, 0);
  return decided ? scores.reduce((a, s) => a + s.approved, 0) / decided : null;
}

/** The half-month a run belongs to: days 1 to 15 are 'a', the rest 'b'. */
export const runCycle = (runDate: string) => `${runDate.slice(0, 7)}-${Number(runDate.slice(8, 10)) <= 15 ? 'a' : 'b'}`;

/** Which lines a run saves: in-scope stores with a count. The rest become totals. */
export function splitForSave(recs: Recommendation[]) {
  const keep: Recommendation[] = [];
  const skipped = {no_count: {stores: new Set<string>(), lines: 0}, out_of_scope: {stores: new Set<string>(), lines: 0}};
  for (const r of recs) {
    const why = r.holds.includes('out_of_scope') ? 'out_of_scope' : r.holds.includes('no_count') ? 'no_count' : null;
    if (!why) keep.push(r);
    else {
      skipped[why].stores.add(r.storeCode);
      skipped[why].lines++;
    }
  }
  return {
    keep,
    skipped: {
      no_count: {stores: skipped.no_count.stores.size, lines: skipped.no_count.lines},
      out_of_scope: {stores: skipped.out_of_scope.stores.size, lines: skipped.out_of_scope.lines},
    },
  };
}
export type RunSkipped = ReturnType<typeof splitForSave>['skipped'];
