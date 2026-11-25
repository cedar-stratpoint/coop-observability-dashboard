import {MANIFESTS, INVENTORY_PAGES, type FormVersion, type ManifestItem} from './goldline-extract';

// Phase 0 of template-anchored extraction (plan: knowledge/tasks/2026-11-12-template-anchored-extraction.md).
//
// The authoritative, structural model of a Nichido inventory form page, per version. It is a
// faithful map of the printed page, not a flat word list: the exact column layout for the
// version, every row in printed order, and the shaded family-header bands (group name + printed
// price, no count cells) kept as structure. Phase 1's reader anchors to this — it fills only the
// handwritten number cells for each known item row, never re-reading the codes or names.
//
// The template is DERIVED (no fabricated data): the per-page printed order + membership comes
// from `MANIFESTS` (the blank-template item list), and the family grouping + printed price comes
// from the catalog (`products.product_line` + `products.unit_price`), joined by `catalogForCodes`
// — the same source the review grid already groups by. A family-header band is emitted wherever
// `product_line` changes down the printed order. (A Coop-maintainable `inventory_templates` table
// can later override this derivation; the loader shape stays the same.)

/** A handwritten column the reader fills, by its key. v1/v2 share the three-location set;
 *  Legacy keeps `beginning` / `begin_plus_delivery` / `deducted_pcs` as well. */
export type HandwrittenKey =
  | 'stockroom'
  | 'drawer'
  | 'selling_area'
  | 'delivery'
  | 'ending_on_hand'
  | 'beginning'
  | 'begin_plus_delivery'
  | 'deducted_pcs';

/** One handwritten column, in its printed left-to-right position for the version. */
export type TemplateColumn = {
  key: HandwrittenKey;
  /** The printed column label, as it reads on the form. */
  label: string;
  /** 1-based printed position, left to right (the fidelity the reader maps cells by). */
  position: number;
};

/** The shaded family-header band on the form (e.g. "Ultra Stay Matte Liquid Lip Color").
 *  Structural only: it carries the group name + printed price, never count cells. */
export type TemplateGroupRow = {
  kind: 'group';
  line: string;
  unitPrice: number | null;
};

/** One printed item row: the reader fills this row's handwritten cells, never its code/name. */
export type TemplateItemRow = {
  kind: 'item';
  itemCode: string;
  /** The variant / product name printed beside the code, e.g. "O' So Spice". */
  product: string;
  /** The family this row sits under (its band's line); null when the code is uncatalogued. */
  group: string | null;
  unitPrice: number | null;
};

export type TemplateRow = TemplateGroupRow | TemplateItemRow;

export type FormTemplate = {
  page: number;
  version: FormVersion;
  /** Handwritten columns the reader fills, in printed order. */
  columns: TemplateColumn[];
  /** Family-header bands + item rows, in printed order (the structural map of the page). */
  rows: TemplateRow[];
  /** Item rows only (bands excluded) — the number of counts to read. */
  itemCount: number;
};

// The printed column order per version. v1/v2 differ only by where Delivery sits (col 4 vs
// col 1); Legacy is the older 7-column "deducted" form (its two peso-amount columns, col5 and
// col7, are derived downstream and not read, so they are left out of the fill set).
const V1_COLUMNS: TemplateColumn[] = [
  {key: 'stockroom', label: 'Bilang sa Stockroom', position: 1},
  {key: 'drawer', label: 'Bilang sa Drawer', position: 2},
  {key: 'selling_area', label: 'Bilang sa Selling Area', position: 3},
  {key: 'delivery', label: 'Delivery', position: 4},
  {key: 'ending_on_hand', label: 'Ending (Stock on Hand)', position: 5},
];
const V2_COLUMNS: TemplateColumn[] = [
  {key: 'delivery', label: 'Delivery', position: 1},
  {key: 'stockroom', label: 'Bilang sa Stockroom', position: 2},
  {key: 'drawer', label: 'Bilang sa Drawer', position: 3},
  {key: 'selling_area', label: 'Bilang sa Selling Area', position: 4},
  {key: 'ending_on_hand', label: 'Ending (Stock on Hand)', position: 5},
];
const LEGACY_COLUMNS: TemplateColumn[] = [
  {key: 'beginning', label: 'Beginning Inventory', position: 1},
  {key: 'delivery', label: 'Delivery (MM/DD)', position: 2},
  {key: 'begin_plus_delivery', label: 'Beginning + Delivery', position: 3},
  {key: 'deducted_pcs', label: 'Total PCS Deducted', position: 4},
  {key: 'ending_on_hand', label: 'Ending Inventory', position: 6},
];

/** The handwritten column layout for a form version. `unknown` falls back to v1, matching the
 *  extractor's current default so a not-yet-classified page still has a column map. */
export function columnsForVersion(version: FormVersion): TemplateColumn[] {
  switch (version) {
    case 'v2':
      return V2_COLUMNS;
    case 'legacy':
      return LEGACY_COLUMNS;
    case 'v1':
    default:
      return V1_COLUMNS;
  }
}

/**
 * Compose the structural template for a page from the printed manifest + the catalog. Pure:
 * the caller supplies `items` (printed order) and `catalog` (product_line + unit_price per
 * code). A family-header band is emitted wherever `product_line` changes down the order; an
 * uncatalogued code (no product_line) just continues under no band, never crashing. Item rows
 * keep their printed order exactly — the reader must fill them one for one.
 */
export function buildFormTemplate(
  page: number,
  version: FormVersion,
  items: ManifestItem[],
  catalog: Record<string, {productLine: string | null; unitPrice: number | null}>,
): FormTemplate {
  const rows: TemplateRow[] = [];
  let currentGroup: string | null | undefined; // undefined = no band emitted yet
  for (const it of items) {
    const info = catalog[it.code];
    const group = info?.productLine ?? null;
    const unitPrice = info?.unitPrice ?? null;
    if (group !== currentGroup) {
      // Open a new band only for a known family; a null group continues under the last band
      // (or under none), so an uncatalogued code never invents an empty band.
      if (group != null) rows.push({kind: 'group', line: group, unitPrice});
      currentGroup = group;
    }
    rows.push({kind: 'item', itemCode: it.code, product: it.product, group, unitPrice});
  }
  return {page, version, columns: columnsForVersion(version), rows, itemCount: items.length};
}

/** True when a page carries an item template (an inventory page 1 to 5 with a manifest); false
 *  for the page 6 sales report and any non-inventory page. The server-side `getFormTemplate`
 *  (in goldline-form-template-data.ts) returns null for anything this rejects. */
export function isTemplatePage(page: number): boolean {
  return INVENTORY_PAGES.includes(page) && (MANIFESTS[page]?.length ?? 0) > 0;
}

/** The printed manifest rows for a template page, in order (empty for a non-template page). */
export function templateManifest(page: number): ManifestItem[] {
  return isTemplatePage(page) ? MANIFESTS[page] : [];
}

/** The item rows (bands excluded), in printed order — the rows the reader fills. */
export function templateItems(t: FormTemplate): TemplateItemRow[] {
  return t.rows.filter((r): r is TemplateItemRow => r.kind === 'item');
}
