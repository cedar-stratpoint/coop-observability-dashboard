// Which page of a store's form a product is printed on (NICH-17). PURE.
//
// "Not on the form" has to mean NOT PRINTED on that store's form version. A product with no
// row because its page was never uploaded is unknown, not missing. The printed templates
// reuse shelf codes for accessories ("ACCS 288" for five brushes) and print two Stylo pens
// short, so they are mapped to catalog codes here.

import {GENERATED_FORM_TEMPLATES} from './goldline-form-templates.generated';

const PRINTED_ALIAS: Record<string, string> = {'24/7SEPM': '24/7SEPMM', '24/7SEPU': '24/7SEPUM'};

/** The catalog code for one printed template row. */
export function catalogCodeOf(row: {code: string; product: string}): string {
  if (PRINTED_ALIAS[row.code]) return PRINTED_ALIAS[row.code];
  if (/^ACCS\s/i.test(row.code)) {
    const n = row.product.match(/#\s*(\d+)/);
    if (n) return `ACCS${n[1]}`;
    if (/belt bag/i.test(row.product)) return 'ACCSBELTBAG';
  }
  return row.code;
}

export type FormVersionKey = keyof typeof GENERATED_FORM_TEMPLATES;

const cache = new Map<FormVersionKey, Map<string, number>>();

/** item code → printed page for a form version; null for an unknown version. */
export function printedPages(version: string | null): Map<string, number> | null {
  if (!version || !(version in GENERATED_FORM_TEMPLATES)) return null;
  const v = version as FormVersionKey;
  let m = cache.get(v);
  if (!m) {
    m = new Map();
    for (const [page, rows] of Object.entries(GENERATED_FORM_TEMPLATES[v])) for (const r of rows) m.set(catalogCodeOf(r), Number(page));
    cache.set(v, m);
  }
  return m;
}

export type FormCount = {onHand: number | null; version: string | null};

/**
 * The inventory answer for one product at one store: a number, or why there isn't one.
 * `rows` = the store's latest form row per item this month (null = no form at all).
 */
export function inventoryAnswer(rows: Map<string, FormCount> | null, item: string): number | 'absent' | 'no_count' | 'blank' | 'page_missing' {
  if (!rows || rows.size === 0) return 'no_count';
  const row = rows.get(item);
  if (row) return row.onHand == null ? 'blank' : row.onHand;
  const votes = new Map<string, number>();
  for (const r of rows.values()) if (r.version) votes.set(r.version, (votes.get(r.version) ?? 0) + 1);
  const version = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const pages = printedPages(version);
  if (!pages) return 'page_missing'; // version not known: can't say it isn't printed
  const page = pages.get(item);
  if (page == null) return 'absent'; // this form doesn't list the product
  for (const code of rows.keys()) if (pages.get(code) === page) return 'blank'; // its page is in, the row isn't
  return 'page_missing';
}
