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
// There is NO stockroom/drawer/selling split (the "Stockroom/Drawer/Selling" seen on
// some scans are the consultant's hand notes over the printed Beginning/Delivery/
// Beginning+Delivery headers — we key off the PRINTED meaning, never the handwriting).
//
// For reconciliation we only need the common core {delivery, ending_on_hand}; the rest
// (beginning, begin+delivery, deducted pcs/amount) is kept verbatim in a jsonb sidecar
// so nothing is lost and the printed identities can be self-checked. PURE module (no
// network/SDK/DB) so it unit-tests; the live call reuses the shared extract runner.

import {MANIFESTS, PAGE_COUNT} from './goldline-extract';

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

/** Map a Legacy row to the common core (delivery + ending), keeping the deducted-model
 *  fields in `extra` so they survive into the inventory sidecar. */
export function legacyRowToCore(r: LegacyExtractedRow): CoreRow {
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
export function buildLegacyManifestPrompt(page: number): string {
  const items = MANIFESTS[page];
  if (!items || items.length === 0) {
    throw new Error(`No extraction manifest for page ${page} (generate it from the blank template first)`);
  }
  const list = items.map((i) => `${i.code} ${i.product}`).join(' · ');
  return [
    `PAGE ${page} of ${PAGE_COUNT}. Form version LEGACY (the older 7-column "deducted" form).`,
    'Columns, left to right (handwritten int or null). Map each cell by its PRINTED',
    'header meaning, NOT by any handwritten sub-label:',
    '  beginning (col1, "Beginning Inventory") · delivery (col2, "Delivery MM/DD") ·',
    '  begin_plus_delivery (col3, "Beginning + Delivery") · deducted_pcs (col4, "Total',
    '  PCS Deducted") · ending_on_hand (col6, "Ending Inventory / Stock on Hand").',
    '  Skip col5 and col7 — those are peso amounts, derived downstream (leave them out).',
    'Printed identities you can use to resolve a doubtful digit: col3 = col1 + col2, and',
    'col6 = col3 − col4. If a reading makes them hold, prefer it, lower confidence, put',
    'the other candidate in "alt".',
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
