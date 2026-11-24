// The form prints accessories under price codes, not product codes: five brushes all say
// "ACCS 288", three "ACCS 150", four "ACCS 125". Inventory keeps one count per item code, so a page 4
// read against the printed form could not be committed (the save refused the repeated code). The
// product list has one code per accessory, matching the number in the printed name ("Stippling Brush
// #185" -> ACCS185); on all three form versions that pairs 19 of 19, with the same prices. Rows follow
// the paper, so the Nth row with a printed code is the Nth printed line with it. Pure.

import {printedPageItems, type PrintedItem} from './goldline-printed-page';

const key = (s: string) => s.toUpperCase().replace(/[^A-Z0-9/#]+/g, '');

/** The product code for a printed accessory line ("ACCS 288" + "...Brush #185" -> ACCS185), else null. */
export function accessorySku(item: Pick<PrintedItem, 'code' | 'product'>): string | null {
  if (!/^ACCS\s+\d+$/i.test(item.code.trim())) return null;
  const n = /#\s?(\d+)/.exec(item.product)?.[1];
  if (n) return `ACCS${n}`;
  if (/belt\s*bag/i.test(item.product)) return 'ACCSBELTBAG';
  return null;
}

/** The rows with each printed accessory code replaced by its product code; every other row as is. */
export function withProductCodes<T extends {item_code: string}>(rows: T[], version: string | null | undefined, page: number | null | undefined): T[] {
  const lines = new Map<string, PrintedItem[]>();
  for (const i of printedPageItems(version, page)) lines.set(key(i.code), [...(lines.get(key(i.code)) ?? []), i]);
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const k = key(r.item_code);
    const list = lines.get(k);
    if (!list) return r;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    const sku = list[n] ? accessorySku(list[n]) : null;
    return sku ? {...r, item_code: sku} : r;
  });
}

/** A plain message when two rows would still save under one code, else null. */
export function duplicateCodeMessage(rows: ReadonlyArray<{item_code: string}>): string | null {
  const at = new Map<string, number[]>();
  rows.forEach((r, i) => at.set(r.item_code, [...(at.get(r.item_code) ?? []), i + 1]));
  const dup = [...at].filter(([, rs]) => rs.length > 1);
  if (!dup.length) return null;
  const [code, rs] = dup[0];
  return `Rows ${rs.join(', ')} all have item code ${code}, and a count can only be saved once per code. Fix the code on all but one of them, then commit.`;
}
