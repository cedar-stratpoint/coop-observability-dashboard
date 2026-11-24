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
// headers, and col1 + col2 + col3 = col6 (Ending). On the 104 staging pages re-filed
// this way 3,984 of 4,137 counted rows (96.3%) add up; they are only 32 distinct reads, nearly
// all store 473. Not one row with the inputs fits the printed identities, so the old "always key off the printed meaning" mapping filed drawer counts
// as Delivery and selling counts as Beginning+Delivery (QA, Nov 23/24).
//
// So the reader still returns each cell by its printed column POSITION, and the page's own
// arithmetic decides what the columns mean (legacyPageLayout): a page whose rows add up as
// col1 + col2 + col3 = Ending is filed as stockroom / drawer / selling_area / ending; any other
// page keeps the printed deducted model (delivery + ending core, the rest in a jsonb sidecar).
// PURE module (no network/SDK/DB) so it unit-tests; the live call reuses the shared runner.

import {MANIFESTS, PAGE_COUNT} from './goldline-extract';
import {generatedTemplateItems} from './goldline-form-templates.generated';
import {printedNames, printedPageItems, type PrintedItem} from './goldline-printed-page';

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

/** Consecutive printed rows under one heading band, with the band's price when its rows share
 *  one (mixed bands like Make-Up Collection print a price per item: null). Pure. */
export function bandsOf(items: PrintedItem[]): Array<{group: string; price: number | null; items: PrintedItem[]}> {
  const bands: Array<{group: string; price: number | null; items: PrintedItem[]}> = [];
  for (const it of items) {
    const g = it.group ?? '';
    const last = bands[bands.length - 1];
    if (last && last.group === g) last.items.push(it);
    else bands.push({group: g, price: null, items: [it]});
  }
  for (const b of bands) {
    const prices = new Set(b.items.map((i) => i.price));
    b.price = prices.size === 1 ? b.items[0].price : null;
  }
  return bands;
}

/** A band's written total, and the unit price the consultant wrote for it when they changed the printed one. */
export type FamilyTotal = {family: string; amount: number; written_price?: number | null};
const bandKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9#&]+/g, '');

/**
 * Band totals: compare the handwritten "Total Amount of Ending Inventory" for each printed
 * heading band with sum(ending) × the printed price. A band that disagrees has a misread or
 * misplaced number somewhere in it, even when every row adds up on its own (QA questioned BMEPP02,
 * 60 + 18 = 78; unconfirmed against the paper).
 * The band's counted rows drop under the review flag line with a plain note; nothing is changed.
 * Only a written total that is a whole number of units at the band's price is trusted. Bands with
 * mixed prices are checked against each row's own price. Mutates and returns `rows`.
 */
export function legacyBandCheck(rows: CoreRow[], items: PrintedItem[], totals: FamilyTotal[]): {checked: number; mismatched: number} {
  let checked = 0;
  let mismatched = 0;
  const byCode = new Map(rows.map((r) => [r.item_code, r] as const));
  const paper = totals.filter((t) => t && typeof t.amount === 'number' && Number.isFinite(t.amount)).map((t) => ({k: bandKey(t.family), amount: t.amount, price: typeof t.written_price === 'number' && t.written_price > 0 ? t.written_price : null}));
  for (const band of bandsOf(items)) {
    if (!band.group || band.items.some((i) => i.price == null)) continue;
    const k = bandKey(band.group);
    const written = paper.find((t) => t.k === k || (t.k.length > 4 && (t.k.includes(k) || k.includes(t.k))));
    if (!written) continue;
    const bandRows = band.items.map((i) => byCode.get(i.code)).filter((r): r is CoreRow => Boolean(r));
    if (!bandRows.length) continue;
    // The price the consultant wrote for the band wins over the printed one: on San Pablo p.7 the
    // answer key reconciles ₱14,910 = 70 x 213, ₱9,353 = 47 x 199, ₱3,861 = 39 x 99, ₱7,110 = 45 x 158.
    // Only a total that is a whole number of units at that price can say the counts are off.
    const price = written.price ?? band.price ?? null;
    if (price != null && price > 0 && Math.abs(written.amount / price - Math.round(written.amount / price)) > 1e-6) continue;
    checked++;
    const sum = band.items.reduce((a, i) => a + (byCode.get(i.code)?.ending_on_hand ?? 0) * (written.price ?? (i.price as number)), 0);
    if (Math.abs(sum - written.amount) <= 1) continue;
    mismatched++;
    const peso = (n: number) => `₱${n.toLocaleString('en-US')}`;
    const note = `Written total for this band is ${peso(written.amount)}; these rows add up to ${peso(sum)}`;
    for (const r of bandRows) {
      if (r.ending_on_hand == null) continue; // an empty row can't be the misread; keep it quiet
      r.confidence = Math.min(r.confidence ?? 1, 0.55);
      r.alt = r.alt ? `${r.alt}; ${note}` : note;
    }
  }
  return {checked, mismatched};
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

/** code → printed product name for a page of the given form version (the printed list for
 *  Legacy, V1 or V2; the shared page list when the version is unknown). */
export function pageItemNames(version: string | null | undefined, page: number | null | undefined): Record<string, string> {
  return printedNames(printedPageItems(version, page));
}

export function buildLegacyManifestPrompt(page: number): string {
  const items = legacyPageItems(page);
  if (!items || items.length === 0) {
    throw new Error(`No extraction manifest for page ${page} (generate it from the blank template first)`);
  }
  // Rows grouped under their printed heading (when the printed list has them), so the reader
  // can name a band when it transcribes the band's written total.
  const printed = printedPageItems('legacy', page);
  const banded = printed.some((i) => i.group);
  const list = banded
    ? bandsOf(printed)
        .map((b) => `[${b.group}${b.price != null ? ` ₱${b.price}` : ''}] ${b.items.map((i) => `${i.code} ${i.product}`).join(' · ')}`)
        .join('\n  ')
    : items.map((i) => `${i.code} ${i.product}`).join(' · ');
  return [
    `PAGE ${page} of ${PAGE_COUNT}. Form version LEGACY (the older 7-column "deducted" form).`,
    'Columns, left to right (handwritten int or null). Put each number in the field for',
    'the column POSITION it is written in, whatever is handwritten over the header:',
    '  beginning (col1) · delivery (col2) · begin_plus_delivery (col3) · deducted_pcs (col4)',
    '  · ending_on_hand (col6, "Ending Inventory / Stock on Hand").',
    '  Skip col5 (a peso amount) in the rows.',
    'Band totals: col7 ("Total Amount of Ending Inventory") has a handwritten peso amount per',
    'heading band, often with a bracket spanning the band. Transcribe each into "family_totals"',
    'with the band\'s heading exactly as listed below in [brackets] and the amount as a number.',
    'If a different unit price is handwritten beside the band or its product names (a 213 near a',
    'printed ₱285), put it in that total\'s "written_price"; it is a price, never a count. Else null.',
    'Most consultants use col1, col2 and col3 as Stockroom, Drawer and Selling area (often',
    'written over the printed headers); then col1 + col2 + col3 = col6. On a page filled',
    'the printed way instead, col3 = col1 + col2 and col6 = col3 − col4.',
    'Sums only tell you where to look again. Consultants do write sums that do not add up, so',
    'never change a digit, or pick one reading over another, to make a row or a band add up:',
    'return what is written. If a digit is doubtful, lower the confidence and put the other',
    'candidate in "alt". This overrides any general rule about making rows add up.',
    'Name columns in "alt" by what this page uses them for (Stockroom, Drawer, Selling area,',
    'or Beginning, Delivery, Beginning + Delivery, Deducted) and Ending, never "col3".',
    'Read the header: store code + name, period (MM/DD–MM/DD), beauty consultant.',
    banded
      ? 'Item rows on this page, in printed order under their [heading ₱price] — read a value or null for each:'
      : 'Item rows on this page, in printed order — read a value or null for each:',
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
    family_totals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {family: {type: 'string'}, amount: {type: 'number'}, written_price: {type: ['number', 'null']}},
        required: ['family', 'amount', 'written_price'],
      },
    },
  },
  required: ['rows', 'family_totals'],
} as const;
