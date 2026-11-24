// The product name to show for each extracted row. Names can't be looked up by code alone: on page
// 4 several accessories share one printed code (five "ACCS 288"), so a code lookup showed one
// brush's name on all five; and older reads carry codes the printed list doesn't ("ACCS185"), which
// showed as a bare code. Rows follow the paper, so the Nth row with a code is the Nth printed line
// with it. Pure.

import {MANIFESTS} from './goldline-extract';
import {printedPageItems} from './goldline-printed-page';

const key = (s: string) => s.toUpperCase().replace(/[^A-Z0-9/#]+/g, '');
type Named = {code: string; product: string};

function only(items: Named[]): Map<string, string> {
  const m = new Map<string, string | null>();
  for (const i of items) m.set(key(i.code), m.has(key(i.code)) && m.get(key(i.code)) !== i.product ? null : i.product);
  return new Map([...m].filter((e): e is [string, string] => e[1] !== null));
}

/** A name per row, or null when there is none we can stand behind. */
export function rowNames(rows: ReadonlyArray<{item_code: string; printed_name?: string | null}>, version: string | null | undefined, page: number | null | undefined): (string | null)[] {
  const here = printedPageItems(version, page);
  const byCode = new Map<string, string[]>();
  for (const i of here) byCode.set(key(i.code), [...(byCode.get(key(i.code)) ?? []), i.product]);
  const others = [1, 2, 3, 4, 5].filter((p) => p !== page);
  // Fallbacks, nearest first: the shared list for this page (older codes), then the other pages (a page
  // whose number was read wrong). A code that means several products there is never used.
  const fallbacks = [only(MANIFESTS[page ?? 0] ?? []), only(others.flatMap((p) => printedPageItems(version, p))), only(others.flatMap((p) => MANIFESTS[p] ?? []))];
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const k = key(r.item_code);
    if (!k) return r.printed_name?.trim() || null;
    const list = byCode.get(k);
    if (list) {
      const n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      if (n < list.length) return list[n];
      return r.printed_name?.trim() || null;
    }
    for (const f of fallbacks) if (f.has(k)) return f.get(k)!;
    return r.printed_name?.trim() || null;
  });
}
