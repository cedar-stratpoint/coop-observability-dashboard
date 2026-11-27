// "O/S" PRINTED on the forms (audit of the Oct scan, Nov 25). PURE so it unit-tests.
//
// The 98-page audit found that every "O/S" on the Oct scan is typeset by Nichido on the form
// itself, on the same rows of every store's copy (Legacy p.3 24HRMESGDE, 24HRMESGM, LEL091; V1/V2
// p.4 six accessories, ...). No BA wrote one. A printed O/S says the item was out of stock when
// the form was printed; it is not a count (store 5300 counted 11 of ACCS 150 #255 under one).
// So a printed O/S leaves the row as the BA filled it, is never flagged, and shows a quiet
// "O/S printed on the form". Only an O/S on a row NOT listed here (one a BA wrote) is read as 0.
//
// The list is keyed by form version and page, from the printed forms in the Oct scan. Several
// accessories share one printed code ("ACCS 288"), so those are told apart by the product name
// printed on their row (via rowNames), or by the code the Legacy read uses ("ACCS185").

import {rowNames} from './row-names';
import {applyOutOfStock, applyOutOfStockNote, cleanOsFlags, type OsLayout} from './out-of-stock';

const key = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '');

/** Printed-O/S accessories on page 4: the product names on shared codes, and the codes the
 *  Legacy read gives them. */
const ACCESSORY_NAMES = /#\s*185|#\s*183|#\s*255|#\s*197|belt\s*bag/i;
const ACCESSORY_CODES = ['ACCS185', 'ACCS183', 'ACCS255', 'ACCS197', 'ACCSBELTBAG'];

const PRINTED: Record<'legacy' | 'v1' | 'v2', Record<number, string[]>> = {
  legacy: {
    1: ['PP01115', 'BGPL01', 'BGSL02', 'LQFD093'],
    2: ['MPMLSCB06', 'MPMLSCB07'],
    3: ['24HRMESGDE', '24HRMESGM', 'LEL091'],
    4: ['MUR', 'FLBES', 'PKB', ...ACCESSORY_CODES],
    5: ['EFTT1112', 'EFTT1064', 'EFTT1904', 'EFTT1676', 'ELIF3125B'],
  },
  // V1 page 5: the INDIVIDUAL FLARE row printed on some copies only (QA Nov 27, stores 5300, 296).
  v1: {4: ['PKB', ...ACCESSORY_CODES], 5: ['ELIF3125B']},
  v2: {4: ['PKB', ...ACCESSORY_CODES]},
};

/** Row indexes whose O/S is printed on this version's page. Empty for an unknown version/page. */
export function printedOsRows(
  rows: ReadonlyArray<{item_code: string; printed_name?: string | null}>,
  version: string | null | undefined,
  page: number | null | undefined,
): Set<number> {
  const list = version && (version === 'legacy' || version === 'v1' || version === 'v2') ? PRINTED[version][page ?? 0] : undefined;
  const out = new Set<number>();
  if (!list) return out;
  const codes = new Set(list.map(key));
  const hasAccessories = list.includes('PKB') && page === 4;
  const names = hasAccessories ? rowNames(rows, version, page) : [];
  rows.forEach((r, i) => {
    const k = key(r.item_code ?? '');
    if (codes.has(k)) out.add(i);
    else if (hasAccessories && /^ACCS/.test(k) && ACCESSORY_NAMES.test(`${names[i] ?? ''} ${r.printed_name ?? ''}`)) out.add(i);
  });
  return out;
}

type Row = Parameters<typeof applyOutOfStock>[0] & {item_code: string; printed_name?: string | null; os_printed?: boolean | null};

const OS = /\bO\s*\/\s*S\b/i;

/** A printed O/S: the row stays as the BA filled it, the reader's O/S remark is dropped (it is
 *  the form talking, not the BA), and the row says the O/S is printed. Mutates and returns it. */
export function markPrintedOs<R extends Row>(row: R): R {
  row.os_printed = true;
  if (row.alt) {
    const rest = row.alt.split(';').map((s) => s.trim()).filter((s) => s && !OS.test(s));
    row.alt = rest.length ? rest.join('; ') : null;
  }
  return row;
}

/** O/S on a read page: printed rows get the quiet note; any other O/S the reader noted is a BA's,
 *  read as 0 in its cell (src/out-of-stock.ts). */
export function applyPageOutOfStock<R extends Row>(rows: R[], o: {version: string | null | undefined; page: number | null | undefined; layout: OsLayout}): R[] {
  const printed = printedOsRows(rows, o.version, o.page);
  rows.forEach((r, i) => (printed.has(i) ? markPrintedOs(r) : applyOutOfStockNote(r, o.layout)));
  return rows;
}

/** Same for a template read, whose O/S comes as per-cell flags (os_drawer, ...). */
export function applyPageOsFlags<R extends Row>(rows: R[], flags: ReadonlyArray<unknown>, o: {version: string | null | undefined; page: number | null | undefined}): R[] {
  const printed = printedOsRows(rows, o.version, o.page);
  rows.forEach((r, i) => {
    if (printed.has(i)) {
      markPrintedOs(r);
      return;
    }
    const cells = cleanOsFlags(flags[i]);
    if (cells.length) applyOutOfStock(r, {cells, row: false});
  });
  return rows;
}
