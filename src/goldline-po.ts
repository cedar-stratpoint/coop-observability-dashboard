// Goldline purchase orders (F12) — pure, unit-tested. One PO per store per restock run,
// laid out like Nichido's paper PURCHASE ORDER FORM. The rules (plan, decided Nov 3):
//
// • The owner approves, edits or rejects on the Restock run (F11); that's the only
//   decision. "Approved lines become a PO": making POs puts the approved and edited lines
//   on each store's PO and ships them (record_shipment). The PO's Line and Remarks columns
//   show the F11 decision and remark; lines rejected on the run are shown struck through.
// • A PO's status is worked out from its lines, never stored:
//     shipped          nothing received yet
//     partly_received  some lines received
//     received         every line received
// • The received section takes qty and date per line. A short receipt is kept as
//   entered ("2 short").
// • Delivered (F6 form vs. sales, F9 board): the received qty wins over the form's
//   Delivery column for the same store, item and period; the form is the fallback.

import type {Decision} from './goldline-restock';

export type PoStatus = 'empty' | 'shipped' | 'partly_received' | 'received';

export const PO_STATUS_LABEL: Record<PoStatus, string> = {
  empty: 'No lines',
  shipped: 'Shipped',
  partly_received: 'Partly received',
  received: 'Received',
};

/** PO-0042 */
export const poNumber = (n: number) => `PO-${String(n).padStart(4, '0')}`;

export const lineAmount = (qty: number, price: number | null) => (price == null ? null : Math.round(qty * price * 100) / 100);

/** Peso total of the PO's lines, all approved on the run (the mockup's "Approved total"). Unpriced lines add 0. */
export const approvedTotal = (lines: Array<{qty: number; unitPrice: number | null}>) => lines.reduce((a, l) => a + (lineAmount(l.qty, l.unitPrice) ?? 0), 0);

export function poStatus(lines: Array<{receivedQty: number | null}>): PoStatus {
  if (!lines.length) return 'empty';
  const received = lines.filter((l) => l.receivedQty != null).length;
  if (!received) return 'shipped';
  return received === lines.length ? 'received' : 'partly_received';
}

/** Units missing from a receipt (0 when it's complete or not received yet). */
export const shortBy = (l: {qty: number; receivedQty: number | null}) => (l.receivedQty == null ? 0 : Math.max(0, l.qty - l.receivedQty));

export type ReceiveError = 'bad_qty' | 'over_qty' | 'bad_date';

/** Why a receipt can't be saved (null = fine). Mirrors receive_po_lines() in p3d. */
export function receiveError(line: {qty: number; shippedOn: string | null}, qty: number | null, date: string | null, today: string): ReceiveError | null {
  if (qty == null || !Number.isInteger(qty) || qty < 0) return 'bad_qty';
  if (qty > line.qty) return 'over_qty';
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || (line.shippedOn && date < line.shippedOn) || date > today) return 'bad_date';
  return null;
}

export type Receipt = {storeCode: string; itemCode: string; qty: number; receivedOn: string};

/** Received units per store|item|YYYY-MM (the month of the received date). */
export function receiptsByMonth(receipts: Receipt[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of receipts) {
    const k = `${r.storeCode}|${r.itemCode}|${r.receivedOn.slice(0, 7)}`;
    out.set(k, (out.get(k) ?? 0) + r.qty);
  }
  return out;
}

/** Received units for a store and item between two dates (inclusive); undefined when none. */
export function receivedBetween(receipts: Receipt[], store: string, item: string, start: string, end: string): number | undefined {
  const hits = receipts.filter((r) => r.storeCode === store && r.itemCode === item && r.receivedOn >= start && r.receivedOn <= end);
  return hits.length ? hits.reduce((a, r) => a + r.qty, 0) : undefined;
}

/** Delivered = the receipt when there is one, else the form's Delivery column. */
export const deliveredFrom = (formDelivered: number, received: number | undefined) => (received === undefined ? formDelivered : received);

/**
 * Units a run's decided lines still hold back from the warehouse when the run is made
 * again: approved and edited lines not on a PO yet. A line on a PO has shipped and left
 * warehouse_stock already (record_shipment), so it isn't held back twice.
 */
export function reservedByItem(decided: Array<{item_code: string; decision: Decision; final_qty: number | null; on_po: boolean}>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of decided) {
    if (d.decision === 'rejected' || d.on_po) continue;
    out[d.item_code] = (out[d.item_code] ?? 0) + (d.final_qty ?? 0);
  }
  return out;
}

/**
 * Lines grouped the way the paper form prints them: the product line as a heading, its
 * shades under it. Lines and shades are in alphabetical order; lines with no product line
 * go last under "Other".
 */
export function groupByProductLine<T extends {productLine: string | null; shade: string; itemCode: string}>(lines: T[]): Array<{line: string; items: T[]}> {
  const by = new Map<string, T[]>();
  for (const l of lines) {
    const k = l.productLine?.trim() || '';
    by.set(k, [...(by.get(k) ?? []), l]);
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([line, items]) => ({line: line || 'Other', items: [...items].sort((a, b) => a.shade.localeCompare(b.shade) || a.itemCode.localeCompare(b.itemCode))}));
}

/**
 * The shade printed under a product line: the variant minus the words it repeats from the
 * line (like itemDisplayName), also when the line has a prefix the variant leaves
 * out ("24/7 Stylo Eyeliner Pen" over "Stylo Eyeliner Pen Umber Matte" → "Umber Matte"). The whole variant, or the item
 * code, when nothing is left.
 */
export function shadeOf(productLine: string | null, variant: string | null, itemCode: string): string {
  const v = (variant ?? '').trim();
  const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, '');
  const line = (productLine ?? '').trim().split(/\s+/).map(norm).filter(Boolean);
  const words = v.split(/\s+/).filter(Boolean);
  let drop = 0;
  for (let start = 0; start < line.length; start++) {
    let k = 0;
    while (k < words.length && start + k < line.length && norm(words[k]) === line[start + k]) k++;
    // The variant repeats the line from its start, or the line's tail.
    if (start === 0 || start + k === line.length) drop = Math.max(drop, k);
  }
  return words.slice(drop).join(' ') || v || itemCode;
}
