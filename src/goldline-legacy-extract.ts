// Goldline Phase 1 — the LEGACY ("deducted") inventory form.
//
// Legacy is the only layout that doesn't map 1:1 onto our three-location schema. Its
// seven printed columns are:
//   col1 Beginning Inventory (= last cut-off's Ending, "kopyahin mo column 6")
//   col2 Delivery (MM/DD)
//   col3 Beginning + Delivery            (printed identity: col3 = col1 + col2)
//   col4 Total PCS Deducted              (printed: col3 − col6, i.e. what sold/left)
//   col5 Total Amount Deducted (value)
//   col6 Ending Inventory (Stock on Hand)
//   col7 Total Amount of Ending Inventory (value)
// In practice the consultants fill this form as a THREE-LOCATION count: they write
// "Stockroom / Drawer / Selling" over the printed Beginning / Delivery / Beginning+Delivery
// headers, and col1 + col2 + col3 = col6 (Ending). On staging every Legacy page with counts
// (104 pages, 3 stores, 3,964 rows) adds up that way and not one row fits the printed
// identities, so the old "always key off the printed meaning" mapping filed drawer counts
// as Delivery and selling counts as Beginning+Delivery (QA, Nov 23/24).
//
// So the reader still returns each cell by its printed column POSITION, and the page's own
// arithmetic decides what the columns mean (legacyPageLayout): a page whose rows add up as
// col1 + col2 + col3 = Ending is filed as stockroom / drawer / selling_area / ending; any other
// page keeps the printed deducted model (delivery + ending core, the rest in a jsonb sidecar).
// PURE module (no network/SDK/DB) so it unit-tests; the live call reuses the shared runner.

import {MANIFESTS, PAGE_COUNT} from './goldline-extract';
import {generatedTemplateItems} from './goldline-form-templates.generated';

/** One Legacy item row, in printed column order (handwritten int or null each). */
export type LegacyExtractedRow = {
  item_code: string;
  beginning: number | null; // col1
  delivery: number | null; // col2
  begin_plus_delivery: number | null; // col3
  deducted_pcs: number | null; // col4
  ending_on_hand: number | null; // col6
  confidence: number;
  alt?: string | null;
};

/** The core row our pipeline reconciles against (shape-compatible with the three-
 *  location extractor's row), plus the Legacy-only values tucked in `extra`. The three
 *  location counts are null — Legacy doesn't have them. */
export type CoreRow = {
  item_code: string;
  stockroom: number | null;
  drawer: number | null;
  selling_area: number | null;
  delivery: number | null;
  ending_on_hand: number | null;
  confidence: number;
  alt?: string | null;
  extra?: Record<string, number | null>;
};

/** How a Legacy page's handwritten columns are used. `locations`: col1-col3 are stockroom /
 *  drawer / selling area and add up to Ending. `printed`: the printed deducted model. */
export type LegacyLayout = 'locations' | 'printed';

/** Decide a page's layout from its own arithmetic: `locations` when at least 80% of the rows
 *  that have an Ending and any of col1-col3 satisfy col1 + col2 + col3 = Ending (blank = 0),
 *  with at least 3 such rows; otherwise `printed`, the form's own meaning. Pure. */
export function legacyPageLayout(rows: LegacyExtractedRow[]): LegacyLayout {
  let n = 0;
  let fit = 0;
  for (const r of rows) {
    const parts = [r.beginning, r.delivery, r.begin_plus_delivery];
    if (r.ending_on_hand == null || parts.every((v) => v == null)) continue;
    n++;
    if (parts.reduce<number>((a, v) => a + (v ?? 0), 0) === r.ending_on_hand) fit++;
  }
  return n >= 3 && fit >= 0.8 * n ? 'locations' : 'printed';
}

/** Map one Legacy row to the common core. `locations`: col1/col2/col3 become stockroom /
 *  drawer / selling area (no delivery column in that use; a deducted count, if any, is kept
 *  in `extra`). `printed`: delivery + ending, with the deducted-model fields in `extra` so
 *  they survive into the inventory sidecar. */
export function legacyRowToCore(r: LegacyExtractedRow, layout: LegacyLayout = 'printed'): CoreRow {
  if (layout === 'locations') {
    return {
      item_code: r.item_code,
      stockroom: r.beginning,
      drawer: r.delivery,
      selling_area: r.begin_plus_delivery,
      delivery: null,
      ending_on_hand: r.ending_on_hand,
      confidence: r.confidence,
      alt: r.alt ?? null,
      ...(r.deducted_pcs != null ? {extra: {deducted_pcs: r.deducted_pcs}} : {}),
    };
  }
  return {
    item_code: r.item_code,
    stockroom: null,
    drawer: null,
    selling_area: null,
    delivery: r.delivery,
    ending_on_hand: r.ending_on_hand,
    confidence: r.confidence,
    alt: r.alt ?? null,
    extra: {
      beginning: r.beginning,
      begin_plus_delivery: r.begin_plus_delivery,
      deducted_pcs: r.deducted_pcs,
    },
  };
}

/** Map a whole Legacy page: decide its layout once from its arithmetic, then map each row. */
export function legacyPageToCore(rows: LegacyExtractedRow[]): {layout: LegacyLayout; rows: CoreRow[]} {
  const layout = legacyPageLayout(rows);
  return {layout, rows: rows.map((r) => legacyRowToCore(r, layout))};
}

/**
 * Legacy self-check using the form's own PRINTED identities, so Legacy is validated
 * even though it has no three-location sum:
 *   col3 = col1 + col2          (begin+delivery = beginning + delivery)
 *   col6 = col3 − col4          (ending = begin+delivery − deducted)
 * Returns the offending identity (with written vs expected) or null when consistent.
 * Only checks an identity when all of its inputs are present (a blank cell is not a
 * mismatch). The extractor should re-read doubtful digits before this fires downstream.
 */
export function legacyRowMathOff(r: LegacyExtractedRow): {rule: string; written: number; expected: number} | null {
  const {beginning: b, delivery: d, begin_plus_delivery: bd, deducted_pcs: dp, ending_on_hand: e} = r;
  if (b != null && d != null && bd != null && bd !== b + d) {
    return {rule: 'begin_plus_delivery = beginning + delivery', written: bd, expected: b + d};
  }
  if (bd != null && dp != null && e != null && e !== bd - dp) {
    return {rule: 'ending = begin_plus_delivery - deducted', written: e, expected: bd - dp};
  }
  // Fallback when col3 wasn't written but col1/col2 were: ending = (begin+delivery) − deducted.
  if (bd == null && b != null && d != null && dp != null && e != null && e !== b + d - dp) {
    return {rule: 'ending = beginning + delivery - deducted', written: e, expected: b + d - dp};
  }
  return null;
}

/** Per-page manifest text for the Legacy 7-column form. Same item rows as the other
 *  versions (the product list is identical across versions), different columns. */
/** The Legacy form's own printed rows for a page (it carries items the shared page list lacks,
 *  e.g. Double Espresso, Macchiato and LEL091 on page 3), else the shared page list. */
export function legacyPageItems(page: number): Array<{code: string; product: string}> {
  return generatedTemplateItems('legacy', page) ?? MANIFESTS[page] ?? [];
}

/** code → printed product name for a page of the given form version: the Legacy form's own
 *  rows on a Legacy page, the shared page list otherwise. */
export function pageItemNames(version: string | null | undefined, page: number | null | undefined): Record<string, string> {
  const names: Record<string, string> = {};
  const items = version === 'legacy' ? legacyPageItems(page ?? 0) : MANIFESTS[page ?? 0] ?? [];
  for (const it of items) names[it.code] = it.product;
  return names;
}

export function buildLegacyManifestPrompt(page: number): string {
  const items = legacyPageItems(page);
  if (!items || items.length === 0) {
    throw new Error(`No extraction manifest for page ${page} (generate it from the blank template first)`);
  }
  const list = items.map((i) => `${i.code} ${i.product}`).join(' · ');
  return [
    `PAGE ${page} of ${PAGE_COUNT}. Form version LEGACY (the older 7-column "deducted" form).`,
    'Columns, left to right (handwritten int or null). Put each number in the field for',
    'the column POSITION it is written in, whatever is handwritten over the header:',
    '  beginning (col1) · delivery (col2) · begin_plus_delivery (col3) · deducted_pcs (col4)',
    '  · ending_on_hand (col6, "Ending Inventory / Stock on Hand").',
    '  Skip col5 and col7 — those are peso amounts, derived downstream (leave them out).',
    'Most consultants use col1, col2 and col3 as Stockroom, Drawer and Selling area (often',
    'written over the printed headers); then col1 + col2 + col3 = col6. On a page filled',
    'the printed way instead, col3 = col1 + col2 and col6 = col3 − col4. Use whichever holds',
    'on this page to resolve a doubtful digit: prefer the reading that makes it hold, lower',
    'the confidence, and put the other candidate in "alt".',
    'Name columns in "alt" by what this page uses them for (Stockroom, Drawer, Selling area,',
    'or Beginning, Delivery, Beginning + Delivery, Deducted) and Ending, never "col3".',
    'Read the header: store code + name, period (MM/DD–MM/DD), beauty consultant.',
    'Item rows on this page, in printed order — read a value or null for each:',
    `  ${list}`,
  ].join('\n');
}

/** JSON schema for a Legacy page extraction (header + one object per item). */
export const LEGACY_EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    store_code: {type: ['string', 'null']},
    store_name: {type: ['string', 'null']},
    period_start: {type: ['string', 'null']},
    period_end: {type: ['string', 'null']},
    consultant: {type: ['string', 'null']},
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          item_code: {type: 'string'},
          beginning: {type: ['integer', 'null']},
          delivery: {type: ['integer', 'null']},
          begin_plus_delivery: {type: ['integer', 'null']},
          deducted_pcs: {type: ['integer', 'null']},
          ending_on_hand: {type: ['integer', 'null']},
          confidence: {type: 'number'},
          alt: {type: ['string', 'null']},
        },
        required: ['item_code', 'ending_on_hand', 'confidence'],
      },
    },
  },
  required: ['rows'],
} as const;
