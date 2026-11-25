// "O/S" written on the form (QA San Pablo, Nov 25). PURE so it unit-tests.
//
// BAs write "O/S" (out of stock) in a count cell instead of a number. The reader only ever said
// so in its note ("O/S written in Delivery"), so the cell stayed blank, the row read as
// uncounted, and Reconcile could only say "Can't tell yet". Decided Nov 25:
//  - O/S makes THAT cell 0, tagged O/S; the row's other counts stand (Drawer O/S + Stockroom 5
//    ends at 5);
//  - a row with O/S and nothing else ends at 0;
//  - O/S and a number in the same cell: the number wins, and the row is flagged;
//  - a row whose only entry is O/S goes to Needs review once.
// Where O/S was written comes from the reader's note (Legacy and the free read always carry
// one) or, on the template read, from its per-cell flags (os_drawer, ...).

export type CountKey = 'stockroom' | 'drawer' | 'selling_area' | 'delivery' | 'ending_on_hand';
const COUNTS: CountKey[] = ['stockroom', 'drawer', 'selling_area', 'delivery', 'ending_on_hand'];

/** What O/S did to a row: the cells it set to 0 (or tagged), and whether the row wants a look. */
export type OutOfStock = {cells: CountKey[]; check: boolean};

/** How the page's columns are used, which decides what a column word in the note means. */
export type OsLayout = 'legacy-locations' | 'legacy-printed' | 'v1' | 'v2';

/** The template read's per-cell O/S flags (one optional `flags` list per row, NICH-36). */
export const OS_FLAGS = ['os_stockroom', 'os_drawer', 'os_selling_area', 'os_delivery', 'os_ending'] as const;
const OS_FLAG_CELL: Record<(typeof OS_FLAGS)[number], CountKey> = {
  os_stockroom: 'stockroom',
  os_drawer: 'drawer',
  os_selling_area: 'selling_area',
  os_delivery: 'delivery',
  os_ending: 'ending_on_hand',
};

/** The cells a template read flagged as O/S, once each. */
export function cleanOsFlags(v: unknown): CountKey[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(OS_FLAGS.filter((f) => v.includes(f)).map((f) => OS_FLAG_CELL[f]))];
}

const OS = /\bO\s*\/\s*S\b/i;

/** Column words in a note, most specific first, with the cell each means on a layout. */
function columnWords(layout: OsLayout): Array<[RegExp, CountKey | null]> {
  if (layout === 'legacy-locations') {
    // A Legacy page used as Stockroom / Drawer / Selling: its printed Beginning, Delivery and
    // Beginning + Delivery columns hold those counts.
    return [
      [/\bbegin(?:ning)?\s*(?:\+|plus|_plus_)\s*delivery\b|\bbegin_plus_delivery\b|\bselling(?:\s*area)?\b|\bcol(?:umn)?\s*3\b/i, 'selling_area'],
      [/\bdeducted\b|\bcol(?:umn)?\s*4\b/i, null],
      [/\bstockroom\b|\bbeginning\b|\bcol(?:umn)?\s*1\b/i, 'stockroom'],
      [/\bdrawer\b|\bdelivery\b|\bcol(?:umn)?\s*2\b/i, 'drawer'],
      [/\bending\b|\bstock on hand\b/i, 'ending_on_hand'],
    ];
  }
  if (layout === 'legacy-printed') {
    return [
      [/\bbegin(?:ning)?\s*(?:\+|plus|_plus_)\s*delivery\b|\bbegin_plus_delivery\b|\bcol(?:umn)?\s*3\b/i, null],
      [/\bdeducted\b|\bbeginning\b|\bcol(?:umn)?\s*[14]\b/i, null],
      [/\bdelivery\b|\bcol(?:umn)?\s*2\b/i, 'delivery'],
      [/\bending\b|\bstock on hand\b/i, 'ending_on_hand'],
    ];
  }
  return [
    [/\bstockroom\b/i, 'stockroom'],
    [/\bdrawer\b/i, 'drawer'],
    [/\bselling(?:\s*area)?\b/i, 'selling_area'],
    [/\bdelivery\b/i, 'delivery'],
    [/\bending\b|\bstock on hand\b/i, 'ending_on_hand'],
  ];
}

/**
 * Where the note says O/S was written: the cells (by this layout's column meaning), or
 * `row: true` when it names none ("O/S written, no counts"). Null when the note has no O/S.
 * The note is read clause by clause (";" and ","), so "O/S written in Delivery; Ending crossed
 * out" puts O/S in Delivery only, and the column word nearest the O/S wins.
 */
export function osFromNote(alt: string | null | undefined, layout: OsLayout): {cells: CountKey[]; row: boolean} | null {
  if (!alt || !OS.test(alt)) return null;
  const cells = new Set<CountKey>();
  let row = false;
  for (const piece of alt.split(/[;,]/)) {
    const at = piece.search(OS);
    if (at < 0) continue;
    let best: {cell: CountKey | null; dist: number} | null = null;
    let rest = piece;
    for (const [re, cell] of columnWords(layout)) {
      const m = re.exec(rest);
      if (!m) continue;
      const dist = Math.abs(m.index - at);
      if (!best || dist < best.dist) best = {cell, dist};
      // Blank out the match so a wider phrase ("Beginning + Delivery") isn't read again as "Delivery".
      rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length);
    }
    if (best?.cell) cells.add(best.cell);
    else row = true;
  }
  return {cells: [...cells], row: row && cells.size === 0};
}

type RowLike = {[K in CountKey]: number | null} & {confidence: number; alt?: string | null; oos?: OutOfStock | null};

/**
 * Apply O/S to a read row: each O/S cell that is blank becomes 0; a row with O/S and no other
 * count ends at 0. A number already in an O/S cell stays (the number wins) and the row is
 * flagged, with a line saying so. Mutates and returns the row; no O/S = unchanged.
 */
export function applyOutOfStock<R extends RowLike>(row: R, os: {cells: CountKey[]; row: boolean} | null): R {
  if (!os || (!os.cells.length && !os.row)) return row;
  const hadCount = COUNTS.some((k) => typeof row[k] === 'number');
  const tagged: CountKey[] = [];
  const clash: CountKey[] = [];
  for (const k of os.cells) {
    if (row[k] == null) {
      (row as Record<CountKey, number | null>)[k] = 0;
      tagged.push(k);
    } else if (row[k] !== 0) clash.push(k);
    else tagged.push(k);
  }
  // Nothing but O/S on the row: it ends at 0.
  if (!hadCount && row.ending_on_hand == null) {
    (row as Record<CountKey, number | null>).ending_on_hand = 0;
    if (!tagged.includes('ending_on_hand') && (os.row || !tagged.length)) tagged.push('ending_on_hand');
  }
  // A bare "O/S" note on a row that has counts names no cell: nothing to set.
  if (!tagged.length && !clash.length) return row;
  if (clash.length) {
    const say = `O/S and a number both written in ${clash.map((k) => k.replace(/_/g, ' ').replace('ending on hand', 'ending')).join(', ')}; the number is kept`;
    row.alt = row.alt ? `${row.alt}; ${say}` : say;
  }
  row.oos = {cells: tagged, check: !hadCount || clash.length > 0};
  return row;
}

/** O/S from a row's note on this layout, applied. */
export function applyOutOfStockNote<R extends RowLike>(row: R, layout: OsLayout): R {
  return applyOutOfStock(row, osFromNote(row.alt, layout));
}

/** True when O/S put this row in Needs review (O/S only, or O/S and a number in one cell). */
export const osNeedsLook = (r: {oos?: OutOfStock | null} | null | undefined): boolean => Boolean(r?.oos?.check);

/**
 * Keep "written as O/S" on committed rows (inventory.extra.out_of_stock = 1) for the rows the
 * read tagged, while their O/S cells are still 0. Rows are matched to the read by code, in page
 * order (several accessories share a code). Rows the reviewer changed away from 0 lose the tag.
 */
export function stampOutOfStock<R extends {item_code: string; extra?: Record<string, number | null> | null} & Partial<Record<CountKey, number | null>>>(
  rows: R[],
  read: ReadonlyArray<{item_code: string; oos?: OutOfStock | null}> | null | undefined,
): R[] {
  const queue = new Map<string, Array<OutOfStock | null>>();
  for (const r of read ?? []) queue.set(r.item_code, [...(queue.get(r.item_code) ?? []), r.oos ?? null]);
  return rows.map((r) => {
    const os = queue.get(r.item_code)?.shift();
    if (!os || !os.cells.length || !os.cells.every((k) => r[k] === 0)) return r;
    return {...r, extra: {...(r.extra ?? {}), out_of_stock: 1}};
  });
}
