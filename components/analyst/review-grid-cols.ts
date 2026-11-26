// The review grid's count columns and their per-version printed order. Pure (no React/UI),
// so it unit-tests and is shared by the grid component. The grid mirrors the scanned paper,
// so the columns render in each form version's printed left-to-right order.

export const COLS = [
  // Full names (QA: "Stk / Drw / Sell" read as codes, not columns).
  {key: 'stockroom', label: 'Stockroom', title: 'Bilang sa stockroom / steel cabinet'},
  {key: 'drawer', label: 'Drawer', title: 'Bilang sa drawer ng module'},
  {key: 'selling_area', label: 'Selling area', title: 'Bilang sa selling area'},
  {key: 'delivery', label: 'Delivery', title: 'Delivery'},
  {key: 'ending_on_hand', label: 'Ending', title: 'Ending inventory (stock on hand)'},
] as const;
export type ColKey = (typeof COLS)[number]['key'];

/** Count-column order per form version, when it differs from the default COLS order. Only V2
 *  differs (it prints Delivery first); V1 already matches, and Legacy's deducted model doesn't
 *  map to these three-location columns, so both keep the default. Display only: cells stay keyed
 *  by field, so no value moves, the columns just re-sequence to match the paper. */
const VERSION_COL_ORDER: Record<string, ColKey[]> = {
  v2: ['delivery', 'stockroom', 'drawer', 'selling_area', 'ending_on_hand'],
};

/** COLS in the version's printed order; the default order for V1/Legacy/unknown/missing. */
export function colsForVersion(version: string | null | undefined): readonly (typeof COLS)[number][] {
  const order = version ? VERSION_COL_ORDER[version] : undefined;
  if (!order) return COLS;
  const byKey = new Map(COLS.map((c) => [c.key, c] as const));
  return order.map((k) => byKey.get(k)!);
}

/** The columns to show for one page: the version's order, minus Delivery on a Legacy page that
 *  has none. A Legacy form filled as Stockroom / Drawer / Selling has no delivery column on the
 *  paper (its 4th column is "Deducted"), so an always-empty Delivery column would break the
 *  match with the scan. A Legacy page that does carry deliveries keeps it. */
export function colsForPage(
  version: string | null | undefined,
  rows: ReadonlyArray<Partial<Record<ColKey, number | null>>>,
): readonly (typeof COLS)[number][] {
  const cols = colsForVersion(version);
  if (version !== 'legacy' || rows.some((r) => r.delivery != null)) return cols;
  return cols.filter((c) => c.key !== 'delivery');
}

/** What the PAPER prints above each review column on a Legacy page (QA Nov 26: Coop labels the
 *  columns Stockroom / Drawer / Selling area, which is how BAs fill them, but the printed form says
 *  Beginning Inventory / Delivery / Beginning + Delivery, and QA couldn't tell they were the same
 *  columns). Shown under the label so review and paper line up. Null where the label already
 *  matches the paper, and on V1/V2 (their labels are the printed ones). */
const LEGACY_PRINTED: Partial<Record<ColKey, string>> = {
  stockroom: 'Beginning Inventory',
  drawer: 'Delivery',
  selling_area: 'Beginning + Delivery',
  ending_on_hand: 'Ending Inventory',
};
export function printedHeader(version: string | null | undefined, key: ColKey): string | null {
  return version === 'legacy' ? LEGACY_PRINTED[key] ?? null : null;
}
