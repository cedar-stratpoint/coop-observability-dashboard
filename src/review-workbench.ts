// Pure helpers for the scan review workbench (no I/O, unit-tested): grouping rows the
// way the paper form groups them, the page's computed total for the totals check, and
// the flag/resolve bookkeeping that gates commit.

import {onHandOf, type InventoryRowIn} from './goldline-inventory';

export type CatalogLite = {productLine: string | null; unitPrice: number | null};

/** Case-, space- and punctuation-insensitive key for comparing product names, so
 *  "BB 03  Beige", "bb03 beige" and "BB-03-BEIGE" all match. */
function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Word-level normalisation: parenthetical tags dropped (a "(Bestseller)" is not part of the
 *  name), lowercased, punctuation collapsed to single spaces, trimmed. Keeps word boundaries
 *  so a whole-word prefix/suffix can be compared. */
function normWords(s: string): string {
  return s
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True when the name printed on the paper for a row disagrees with the catalog/manifest
 *  name for its (matched) code — a soft signal the code may have been misread, or the
 *  printed form is out of date. Both must be present; a blank on either side never
 *  conflicts, so old scans with no printed_name stay quiet.
 *
 *  A pure prefix/suffix difference is NOT a conflict: the paper routinely prints just the
 *  variant and drops the family/type prefix the catalog name carries (catalog "Lip Stain
 *  Caramel Swirl" vs paper "Caramel Swirl"), and may add a "(Bestseller)" tag. Only a genuine
 *  mismatch (e.g. "BB 03 Beige" vs "BB 04 Beige") still flags. */
export function printedNameConflict(printed: string | null | undefined, catalog: string | null | undefined): boolean {
  if (!printed || !catalog) return false;
  const a = normName(printed);
  const b = normName(catalog);
  if (!a || !b) return false;
  if (a === b) return false;
  // One name is the other with a leading family/type prefix dropped or added (on a word
  // boundary) — same product, so stay quiet. Tags like "(Bestseller)" are already stripped.
  const wa = normWords(printed);
  const wb = normWords(catalog);
  if (wa && wb && (wa === wb || wa.endsWith(` ${wb}`) || wb.endsWith(` ${wa}`))) return false;
  return true;
}

export type FamilyGroup<T> = {family: string; price: number | null; items: T[]};

/**
 * Group rows (already in printed order) into consecutive product families, like the
 * form's black heading bars. A family's price is shown only when all its items share
 * one (mixed groups like Accessories print a price per item). Unknown codes fall
 * into "Other items".
 */
export function groupByFamily<T extends {item_code: string}>(rows: T[], catalog: Record<string, CatalogLite>): FamilyGroup<T>[] {
  const groups: FamilyGroup<T>[] = [];
  for (const r of rows) {
    const family = catalog[r.item_code]?.productLine?.trim() || 'Other items';
    const last = groups[groups.length - 1];
    if (last && last.family === family) last.items.push(r);
    else groups.push({family, price: null, items: [r]});
  }
  for (const g of groups) {
    const prices = new Set(g.items.map((i) => catalog[i.item_code]?.unitPrice ?? null));
    g.price = prices.size === 1 ? [...prices][0] : null;
  }
  return groups;
}

/** The page's ending value as the form computes it: on hand × printed price, summed
 *  over rows that have both. `priced`/`unpriced` say how complete it is. */
export function pageTotal(rows: InventoryRowIn[], catalog: Record<string, CatalogLite>): {total: number; priced: number; unpriced: number} {
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  for (const r of rows) {
    const {onHand} = onHandOf(r);
    if (onHand == null) continue;
    const price = catalog[r.item_code]?.unitPrice;
    if (typeof price === 'number' && Number.isFinite(price)) {
      total += onHand * price;
      priced++;
    } else unpriced++;
  }
  return {total, priced, unpriced};
}

export type Reconcile = {state: 'none' | 'match' | 'off'; diff: number};

/** Compare the computed total with the total written on the form (₱1 tolerance for
 *  rounding on the paper). `none` until a written total is entered. */
export function reconcile(computed: number, written: string): Reconcile {
  const n = Number(written.replace(/[₱,\s]/g, ''));
  if (!written.trim() || !Number.isFinite(n)) return {state: 'none', diff: 0};
  const diff = Math.round((computed - n) * 100) / 100;
  return {state: Math.abs(diff) <= 1 ? 'match' : 'off', diff};
}

/** Indices of flagged rows still awaiting a decision, in row order. */
export function unresolvedFlags(flagged: number[], resolved: ReadonlySet<number>): number[] {
  return flagged.filter((i) => !resolved.has(i));
}

/** The flag to go to next/previous from `current` (wraps around). */
export function stepFlag(flags: number[], current: number | null, dir: 1 | -1): number | null {
  if (!flags.length) return null;
  const at = current == null ? -1 : flags.indexOf(current);
  if (at < 0) return dir === 1 ? flags[0] : flags[flags.length - 1];
  return flags[(at + dir + flags.length) % flags.length];
}
