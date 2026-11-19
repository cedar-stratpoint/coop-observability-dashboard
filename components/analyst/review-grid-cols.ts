// The review grid's count columns and their per-version printed order. Pure (no React/UI),
// so it unit-tests and is shared by the grid component. The grid mirrors the scanned paper,
// so the columns render in each form version's printed left-to-right order.

export const COLS = [
  {key: 'stockroom', label: 'Stk', title: 'Bilang sa stockroom / steel cabinet'},
  {key: 'drawer', label: 'Drw', title: 'Bilang sa drawer ng module'},
  {key: 'selling_area', label: 'Sell', title: 'Bilang sa selling area'},
  {key: 'delivery', label: 'Dlv', title: 'Delivery'},
  {key: 'ending_on_hand', label: 'End', title: 'Ending inventory (stock on hand)'},
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
