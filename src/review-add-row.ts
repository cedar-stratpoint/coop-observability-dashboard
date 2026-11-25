// Add product row (NICH-42, Nov 25): a BA hand-writes a product onto the form between the
// printed rows (e.g. "P.Glow" under Creamy Glow). The reviewer adds it as a row from the
// catalog, enters its counts, and it commits with the page like any printed row. PURE so
// it unit-tests; the catalog list is built server-side (goldline-add-row-data.ts).

import type {ExtractedRow} from './goldline-extract-run';

/** One catalog product the reviewer can add. `printedPage`: the page of this form version
 *  that prints it (its count there would be replaced on commit), or null when it isn't printed. */
export type AddableItem = {code: string; name: string; line: string | null; price: number | null; printedPage: number | null};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Products matching a search, best first: an exact code, then a code that starts with it,
 * then names containing every word. With no search, the lines already on the page come
 * first (a hand-written product is usually a shade of a printed line). Capped at `limit`.
 */
export function searchAddable(items: readonly AddableItem[], query: string, pageLines: ReadonlySet<string>, limit = 30): AddableItem[] {
  const q = norm(query);
  const words = q ? q.split(' ') : [];
  const scored: Array<{it: AddableItem; score: number}> = [];
  for (const it of items) {
    const code = it.code.toLowerCase();
    const hay = norm(`${it.code} ${it.name} ${it.line ?? ''}`);
    let score: number;
    if (!q) score = it.line && pageLines.has(it.line) ? 1 : 2;
    else if (code === q.replace(/ /g, '')) score = 0;
    else if (code.startsWith(q.replace(/ /g, ''))) score = 1;
    else if (words.every((w) => hay.includes(w))) score = it.line && pageLines.has(it.line) ? 2 : 3;
    else continue;
    scored.push({it, score});
  }
  return scored
    .sort((a, b) => a.score - b.score || (a.it.line ?? '').localeCompare(b.it.line ?? '') || a.it.name.localeCompare(b.it.name))
    .slice(0, limit)
    .map((s) => s.it);
}

/** The row an added product becomes: no counts yet, full confidence (the reviewer typed it). */
export function addedRow(it: AddableItem): ExtractedRow {
  return {item_code: it.code, printed_name: it.name, stockroom: null, drawer: null, selling_area: null, delivery: null, ending_on_hand: null, confidence: 1, added: true};
}

/** Why a product can't or shouldn't be added here; null when it is fine. */
export function addWarning(it: AddableItem, pageCodes: ReadonlySet<string>, page: number | null): {block: boolean; text: string} | null {
  if (pageCodes.has(it.code)) return {block: true, text: 'Already a row on this page.'};
  if (it.printedPage != null && it.printedPage !== page) return {block: false, text: `Printed on page ${it.printedPage} of this form. Committing both replaces that page’s count for the store and period.`};
  return null;
}
