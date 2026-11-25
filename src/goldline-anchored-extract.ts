import {PAGE_COUNT, type FormVersion} from './goldline-extract';
import {columnsForVersion, templateItems, type FormTemplate} from './goldline-form-template';
import type {ExtractedPage, ExtractedRow} from './goldline-extract-run';
import {checkBands, type PaperTotal} from './band-prices';
import {applyPageOsFlags} from './printed-os';
import {applyReaderFlags, cleanHeaders, cleanReaderFlags, FLAGS_PROPERTY, MARKS_PROMPT_ANCHORED} from './goldline-reader-marks';

// Phase 1 of template-anchored extraction (plan: knowledge/tasks/2026-11-12-template-anchored-extraction.md).
//
// "Fill the form, don't re-read it." Instead of asking the model to free-generate one row per
// item it thinks it sees (which drops rows it reads as empty and invents rows from the reference
// list), we give it the fixed template's ordered item rows and ask it to return ONLY the
// handwritten numbers per row, by index. The row set is then non-negotiable: every template row
// is reconstructed here with its code + name from the template, so a drop is impossible and an
// invented row can only land in `extras` (flagged), never in the body. Output shrinks to numbers,
// so cost falls and the densest pages stop truncating.
//
// This module is PURE (prompt builder + output schema + mapper back to ExtractedPage). The live
// Vision call is a thin server wrapper added separately; nothing here is wired into the pipeline
// yet. Scope: the three-location layouts (V1, V2). Legacy already reads template-anchored via its
// own path and is left unchanged.

/** The three-location count columns the model returns per row (by meaning, not printed order). */
type CountCols = {
  stockroom?: number | null;
  drawer?: number | null;
  selling_area?: number | null;
  delivery?: number | null;
  ending_on_hand?: number | null;
};

/** One filled row: the template item-row index `i` plus its handwritten numbers. */
export type AnchoredRow = CountCols & {
  i: number;
  confidence?: number;
};

/** A handwritten row printed on the page that is NOT on the template (a write-in). Kept, flagged. */
export type AnchoredExtra = CountCols & {
  code?: string | null;
  name?: string | null;
  confidence?: number;
};

/** A handwritten price that differs from a family's printed price (page-1 ₱225 to 180 case). */
export type AnchoredPriceNote = {
  group?: string | null;
  printed_price?: number | null;
  written_price: number;
  confidence?: number;
};

export type AnchoredHeader = {
  store_code?: string | null;
  store_name?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  consultant?: string | null;
};

/** The model's numbers-only output for one page, aligned to the template by row index. */
export type AnchoredOutput = {
  header?: AnchoredHeader;
  rows: AnchoredRow[];
  extras?: AnchoredExtra[];
  price_notes?: AnchoredPriceNote[];
  // Safeguard (B): the printed data-column header labels, transcribed left to right from THIS
  // page's header row. Used to verify the page's real layout against the classified version — a
  // confident version mis-tag (QA page 16: a V2 page read V1 at 0.9) would otherwise read every
  // count from the wrong column. This is a transcription, not a judgement, so it does not repeat
  // the version call the classifier already got wrong.
  column_headers?: (string | null)[] | null;
};

/**
 * The minimum classification confidence to trust the detected version enough to anchor to its
 * template. A template-anchored read fills every cell by the version's column map, so a wrong
 * version (the QA found V2 pages tagged V1) would read every count from the wrong column. Below
 * this bar, or for a non-V1/V2 version, we stay on the free read, which maps cells by printed
 * meaning and is safer when the version is in doubt.
 */
export const ANCHOR_MIN_CONFIDENCE = 0.75;

/** The version to anchor to, or null to fall back to the free read: only a confidently-classified
 *  V1 or V2 (Legacy already reads template-anchored via its own path; unknown never anchors). */
export function anchorVersion(version: FormVersion, confidence: number): 'v1' | 'v2' | null {
  if (!(confidence >= ANCHOR_MIN_CONFIDENCE)) return null;
  return version === 'v1' || version === 'v2' ? version : null;
}

/* ---- Safeguard (B): in-read version self-check ----------------------------------------------
 * The confidence gate only saves a mis-tag the classifier is UNSURE of. QA page 16 is a V2 page
 * the classifier reads V1 at 0.90 on every pass, which the gate cannot catch, so a pure-gate
 * design anchors it to the V1 column map and reads every count from the wrong column. The read
 * therefore transcribes the page's actual printed column headers; the helpers below locate the
 * real "Delivery" column from that transcription (a layout fact, not a version judgement) so the
 * caller can detect the mismatch and re-anchor against the correct-version template. */

/** 1-based position of the printed "Delivery" data column as transcribed from the header row, or
 *  null when no header mentions delivery / none were transcribed. Deterministic, case-insensitive. */
export function deliveryColumnFromHeaders(headers: (string | null)[] | null | undefined): number | null {
  if (!Array.isArray(headers)) return null;
  const idx = headers.findIndex((h) => typeof h === 'string' && /deliver/i.test(h));
  return idx >= 0 ? idx + 1 : null;
}

/** The expected 1-based position of the Delivery column for a version's template (V1 = 4, V2 = 1). */
export function expectedDeliveryColumn(version: FormVersion): number | null {
  const col = columnsForVersion(version).find((c) => c.key === 'delivery');
  return col ? col.position : null;
}

/** The version implied by where "Delivery" is actually printed: col 1 -> v2, col 4 -> v1. Null
 *  for any other position (don't guess from a mis-transcription). */
export function versionFromDeliveryColumn(pos: number | null): 'v1' | 'v2' | null {
  if (pos === 1) return 'v2';
  if (pos === 4) return 'v1';
  return null;
}

/**
 * Unbiased "where is the Delivery column" read, used to pick the anchor version BEFORE the template
 * is built. It deliberately states NO expected column order: measured empirically, stating one
 * primes the model to the wrong answer (QA page 16 is a V2 page the classifier — and an anchored
 * read that is first told "delivery is col 4" — both read as V1 at high confidence; asked this way,
 * with no order stated, the model reads Delivery at column 1 = V2 every time). Since V1 vs V2 differ
 * ONLY by the Delivery position, this layout read is the reliable version signal for anchoring.
 */
export function buildDeliveryLocatorPrompt(): string {
  return [
    'This is a NICHIDO COSMETICS semi-monthly inventory form. Look ONLY at the printed column',
    'header row. Reading strictly LEFT TO RIGHT, list the DATA column headers (the columns to the',
    'RIGHT of the PRODUCT column; exclude ITEM# and PRODUCT) exactly in the order they are physically',
    'printed. Do NOT reorder them into any standard or expected order. Then give delivery_column: the',
    '1-based position (counting from the first data column) where the column literally labelled',
    '"Delivery" physically appears, or null if there is none. Return JSON only.',
  ].join('\n');
}

/** Tiny schema for the delivery-column locator (its own call, well under the union/optional caps). */
export const DELIVERY_LOCATOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    columns_left_to_right: {type: 'array', items: {type: 'string'}},
    delivery_column: {type: ['integer', 'null']},
  },
  required: ['delivery_column'],
} as const;

export type DeliveryLocatorOutput = {columns_left_to_right?: (string | null)[] | null; delivery_column?: number | null};

/** The Delivery column position from a locator read: prefer the transcribed header order (so the
 *  position is derived deterministically in code), else the model's own delivery_column. */
export function deliveryColumnFromLocator(out: DeliveryLocatorOutput | null | undefined): number | null {
  const fromHeaders = deliveryColumnFromHeaders(out?.columns_left_to_right);
  if (fromHeaders != null) return fromHeaders;
  return typeof out?.delivery_column === 'number' ? out.delivery_column : null;
}

/**
 * Minimum confidence to accept a "sales"/"blank" classification as final. Below it, a real
 * inventory page may have been misread as sales/blank and set aside with no retry (the current
 * pipeline rejects these outright). A low-confidence reject gets one blind re-read first.
 */
export const SET_ASIDE_MIN_CONFIDENCE = 0.75;

/** True when a sales/blank classification is uncertain enough to re-read before setting aside. */
export function shouldRetrySetAside(kind: string, confidence: number): boolean {
  return (kind === 'sales' || kind === 'blank') && confidence < SET_ASIDE_MIN_CONFIDENCE;
}

const COUNT_KEYS = ['stockroom', 'drawer', 'selling_area', 'delivery', 'ending_on_hand'] as const;

/**
 * The user-turn prompt for a template-anchored read: the ordered item rows (index · code · name,
 * with family bands for context) and the version's column positions, with the fill-only rules.
 * The model returns numbers by index — never codes, names, or a different row set.
 */
export function buildAnchoredPrompt(template: FormTemplate): string {
  const cols = columnsForVersion(template.version);
  const order = cols.map((c) => `${c.key} (col ${c.position}, "${c.label}")`).join(' · ');
  const lines: string[] = [];
  let idx = 0;
  for (const r of template.rows) {
    if (r.kind === 'group') {
      const price = r.unitPrice == null ? '' : ` (printed ₱${r.unitPrice})`;
      lines.push(`  [FAMILY] ${r.line}${price}`);
    } else {
      lines.push(`  ${idx} · ${r.itemCode} · ${r.product}`);
      idx++;
    }
  }
  return [
    `PAGE ${template.page} of ${PAGE_COUNT}. Form version ${template.version.toUpperCase()}.`,
    'FILL IN THE FORM. The rows below are the fixed, printed template for this page. Read ONLY the',
    'handwritten count cells for each row and return them by index. Do NOT re-type the codes or',
    'names, and do NOT decide the row set.',
    `Columns to read, left to right (handwritten integer or null): ${order}.`,
    'Rules:',
    `- Return exactly one entry for each of the ${idx} item rows below (i = 0 to ${idx - 1}), in this order.`,
    '  Never add, drop, reorder, or rename a row. A row with no counts (blank, or only an "O/S"',
    '  mark) is still returned, with null in every cell.',
    '- OMIT a blank cell entirely (do not return that field for the row); only a written "0" is 0.',
    '  Read the WRITTEN ending_on_hand value; do not',
    '  compute or overwrite it with a sum.',
    '- Map each cell by the PRINTED column position above, not by any handwritten sub-label.',
    '- Also transcribe the printed DATA-column header labels into "column_headers", left to right,',
    '  exactly as printed above the count cells (e.g. the Tagalog "Bilang sa ..." labels and',
    '  "Delivery"). Transcribe the real printed order on THIS page; do NOT reorder them to match',
    '  the list above. This is a verification of the layout, so copy what you see.',
    '- Read the header once: store code + name, period (MM/DD to MM/DD), beauty consultant.',
    '- If a handwritten row is printed that is NOT one of the rows below, put it in "extras" with',
    '  its printed code/name and numbers (never force it into the numbered rows).',
    '- If a handwritten price is written that differs from a family\'s printed price above, put it in',
    '  "price_notes" with the family line, the printed price, and the written price. Never change a count.',
    '- Give each row a confidence 0 to 1. Return JSON only.',
    'ROWS (family bands are context only; do NOT return a row for a [FAMILY] line):',
    ...lines,
  ].join('\n');
}

/** The fixed system role for a template-anchored read (prompt-cached). */
export function buildAnchoredSystemPrompt(): string {
  return [
    'You read NICHIDO COSMETICS "Semi-Monthly Inventory" form pages by FILLING A FIXED TEMPLATE.',
    "You are given the page's exact printed rows in order. Transcribe only the handwritten count",
    'cells for each row and return them by row index. Never re-type the codes or product names,',
    'never add, drop, reorder, or rename a row, and never infer, estimate, average, or fill a blank.',
    'Return JSON only.',
  ].join('\n');
}

/**
 * Structured-output schema for the numbers-only anchored read (three-location V1/V2).
 * Two hard API limits shape this schema (both exceeded a 400 on the live call): a schema may have
 * at most 24 OPTIONAL params and at most 16 UNION-typed params. So the header fields are
 * required-but-nullable (frees optional budget) and the per-row count cells are single-type
 * `integer` that are simply OMITTED when blank (frees union budget) rather than `['integer','null']`.
 * The mapper treats a missing cell as null, so the data is identical. Do not re-add `null` to the
 * count fields or the live read will fail.
 */
export const ANCHORED_EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    header: {
      type: 'object',
      additionalProperties: false,
      properties: {
        store_code: {type: ['string', 'null']},
        store_name: {type: ['string', 'null']},
        period_start: {type: ['string', 'null']},
        period_end: {type: ['string', 'null']},
        consultant: {type: ['string', 'null']},
      },
      // All required (still nullable): structured outputs caps a schema at 24 OPTIONAL params and
      // this schema sits right at the limit. Pinning the five header fields as required-but-nullable
      // frees the budget for column_headers below without changing the data (the mapper already
      // treats every header field as possibly null).
      required: ['store_code', 'store_name', 'period_start', 'period_end', 'consultant'],
    },
    // Safeguard (B): the printed data-column header labels, left to right, so the read's real
    // layout can be checked against the classified version (QA page 16: a V2 page read as V1).
    column_headers: {
      type: 'array',
      items: {type: ['string', 'null']},
    },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          i: {type: 'integer'},
          stockroom: {type: 'integer'},
          drawer: {type: 'integer'},
          selling_area: {type: 'integer'},
          delivery: {type: 'integer'},
          ending_on_hand: {type: 'integer'},
          confidence: {type: 'number'},
        },
        required: ['i', 'confidence'],
      },
    },
    extras: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: {type: ['string', 'null']},
          name: {type: ['string', 'null']},
          stockroom: {type: 'integer'},
          drawer: {type: 'integer'},
          selling_area: {type: 'integer'},
          delivery: {type: 'integer'},
          ending_on_hand: {type: 'integer'},
          confidence: {type: 'number'},
        },
      },
    },
    price_notes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: {type: ['string', 'null']},
          printed_price: {type: ['number', 'null']},
          written_price: {type: 'number'},
          confidence: {type: 'number'},
        },
        required: ['written_price'],
      },
    },
  },
  required: ['rows'],
} as const;

const n = (v: number | null | undefined): number | null => (typeof v === 'number' ? v : null);

/** Build one body row from a template item + the model's numbers for it (or a kept blank). */
function toExtractedRow(code: string, name: string, cells: CountCols | null, confidence: number, filledBlank: boolean): ExtractedRow {
  return {
    item_code: code,
    printed_name: name,
    stockroom: n(cells?.stockroom),
    drawer: n(cells?.drawer),
    selling_area: n(cells?.selling_area),
    delivery: n(cells?.delivery),
    ending_on_hand: n(cells?.ending_on_hand),
    confidence,
    off_manifest: false,
    ...(filledBlank ? {alt: 'not read; kept blank for review'} : {}),
  };
}

export type AnchoredMapResult = {
  /** Standard ExtractedPage, drop-in for saveExtraction: every template item row is present
   *  (in printed order) followed by any extras. */
  page: ExtractedPage;
  /** Template rows the model returned NO entry for — kept blank (confidence 0), never dropped. */
  filledBlanks: number;
  /** Handwritten rows not on the template (write-ins), appended as flagged off_manifest rows. */
  extras: number;
  /** Handwritten price overrides to surface for review (not written into counts). */
  priceNotes: AnchoredPriceNote[];
  /** Safeguard (B): the Delivery column the read actually saw (from the transcribed headers), the
   *  position the anchored template expected, and whether they disagree. A true `versionMismatch`
   *  means the page was read against the wrong column map and the caller must re-anchor on the
   *  corrected version. `deliverySeen` null = the header could not be verified (not a mismatch). */
  deliverySeen: number | null;
  deliveryExpected: number | null;
  versionMismatch: boolean;
};

/**
 * Reconstruct the full page from the template + the numbers-only output. Every template item row
 * is emitted in printed order with its code + name from the template and its numbers from the
 * output (null, confidence 0, flagged when the model skipped it — so a drop is impossible). Any
 * off-template handwritten row is appended as a flagged `off_manifest` extra. Price overrides are
 * returned for the caller to surface; counts are never changed by them.
 */
export function mapAnchoredToExtractedPage(template: FormTemplate, out: AnchoredOutput): AnchoredMapResult {
  const items = templateItems(template);
  const byIndex = new Map<number, AnchoredRow>();
  for (const r of out.rows ?? []) if (typeof r.i === 'number' && !byIndex.has(r.i)) byIndex.set(r.i, r);

  let filledBlanks = 0;
  const rows: ExtractedRow[] = items.map((it, i) => {
    const got = byIndex.get(i);
    if (!got) {
      filledBlanks++;
      return toExtractedRow(it.itemCode, it.product, null, 0, true);
    }
    const cells: CountCols = {};
    for (const k of COUNT_KEYS) cells[k] = n(got[k]);
    return toExtractedRow(it.itemCode, it.product, cells, typeof got.confidence === 'number' ? got.confidence : 0.9, false);
  });

  const extras = out.extras ?? [];
  for (const e of extras) {
    const cells: CountCols = {};
    for (const k of COUNT_KEYS) cells[k] = n(e[k]);
    rows.push({
      ...toExtractedRow(e.code ?? '', e.name ?? '', cells, typeof e.confidence === 'number' ? e.confidence : 0.5, false),
      off_manifest: true,
      alt: 'handwritten row not on the template; flagged for review',
    });
  }

  const h = out.header ?? {};
  const page: ExtractedPage = {
    store_code: typeof h.store_code === 'string' ? h.store_code : '',
    store_name: h.store_name ?? undefined,
    period_start: h.period_start ?? null,
    period_end: h.period_end ?? null,
    consultant: h.consultant ?? null,
    rows,
  };

  // Each band's paper total (P1 reads them) and any written price (price_notes), saved with the
  // page and flagged when the paper points at another price than the printed one (QA Nov 25).
  const paper: PaperTotal[] = ((out as {family_totals?: Array<{family?: unknown; amount?: unknown}>}).family_totals ?? [])
    .filter((f) => f && typeof f.family === 'string')
    .map((f) => ({family: f.family as string, amount: typeof f.amount === 'number' ? f.amount : null}));
  for (const pn of out.price_notes ?? []) {
    if (!pn || typeof pn.group !== 'string' || typeof pn.written_price !== 'number') continue;
    const same = paper.find((t) => t.family.toUpperCase() === (pn.group as string).toUpperCase());
    if (same) same.written_price = pn.written_price;
    else paper.push({family: pn.group, amount: null, written_price: pn.written_price});
  }
  const bands = checkBands(items.map((it) => ({code: it.itemCode, group: it.group, price: it.unitPrice})), rows, paper);
  if (bands.length) page.bands = bands;

  // Safeguard (B): verify the page's real layout against the template's version. A seen Delivery
  // position that disagrees with the expected one means a confident version mis-tag slipped past
  // the confidence gate (e.g. a V2 page read as V1), so the counts above were read from the wrong
  // columns and the caller must re-anchor on the corrected version. Null seen = unverifiable
  // header, which is NOT treated as a mismatch (we don't discard a read on a failed transcription).
  const deliverySeen = deliveryColumnFromHeaders(out.column_headers);
  const deliveryExpected = expectedDeliveryColumn(template.version);
  const versionMismatch =
    deliverySeen != null && deliveryExpected != null && deliverySeen !== deliveryExpected;

  return {
    page,
    filledBlanks,
    extras: extras.length,
    priceNotes: out.price_notes ?? [],
    deliverySeen,
    deliveryExpected,
    versionMismatch,
  };
}

/* ============================================================================================
 * P1 read-accuracy variant (plan: knowledge/tasks/2026-11-19-handwriting-read-accuracy.md).
 * Flag-gated by GOLDLINE_READ_P1=1 at the call site; flag-off is byte-identical to the read above.
 *
 * Measured on a hand-checked answer key: the index-only read places ~37 numbers per 8 pages on
 * the wrong row. Two causes: (1) it COUNTS rows down the page to find index i, so one slip moves a
 * whole family; (2) writers sit consistently low or high, so a number straddling a ruled line is
 * judged one number at a time and often lands on the row below. P1 changes how a number is placed:
 *  - rows are keyed by the printed ITEM# the model reads on the SAME LINE as the numbers (look
 *    left), never by a counted index;
 *  - the writer's consistent per-family offset decides straddling numbers;
 *  - the paper's own checks (row math, the handwritten per-family peso total) send it back to look
 *    again before answering — it still reports only what is written.
 * The mapper then lowers confidence (existing field) where those checks still fail. Same
 * ExtractedPage output; nothing new is stored or shown.
 * ========================================================================================== */

/** One P1 row: the printed row key the model read beside the numbers, plus the numbers. */
export type UnsureCell = {col: string; alt: number};
export type AnchoredRowP1 = CountCols & {row: string; confidence?: number; unsure?: UnsureCell[]; flags?: string[]};
export type FamilyTotal = {family: string; amount: number};
export type AnchoredOutputP1 = Omit<AnchoredOutput, 'rows'> & {rows: AnchoredRowP1[]; family_totals?: FamilyTotal[]; headers_written_over?: string[]};

/** The row key shown to (and returned by) the model: the printed ITEM#, plus the product name
 *  only when the code repeats on the page (accessories reuse codes like "ACCS 288"). */
export function p1RowKeys(template: FormTemplate): string[] {
  const items = templateItems(template);
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.itemCode, (counts.get(it.itemCode) ?? 0) + 1);
  return items.map((it) => ((counts.get(it.itemCode) ?? 0) > 1 ? `${it.itemCode} | ${it.product}` : it.itemCode));
}

const normKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9|#]+/g, '');

/** How to find the count columns, described the way the paper prints them. V2 prints its own
 *  1-to-5 numbering over the count box (Stockroom 1 ... Ending 4, Total Amount 5) with Delivery in
 *  a separate box to the left; describing V2 as "delivery col 1 ... ending col 5" contradicts those
 *  printed numbers and the read then leaves Stockroom / Drawer / Selling empty (measured: ~50 to 80
 *  missed numbers per V2 page). V1 prints 1 to 5 in the same order as its keys, so it is unchanged. */
function columnsTextP1(template: FormTemplate): string[] {
  if (template.version === 'v2') {
    return [
      'Columns (this is the V2 layout): DELIVERY is its own box on the LEFT, headed "Delivery MM/DD"; read it as',
      '"delivery". To its right, after a gap, is the COUNT BOX, whose columns carry their own printed numbers 1 to 5:',
      '  1 = stockroom ("Bilang sa Stockroom / Steelcab"), 2 = drawer ("Bilang sa Drawer ng Module"),',
      '  3 = selling_area ("Bilang sa Selling Area"), 4 = ending_on_hand ("Ending Inventory / Stock on Hand"),',
      '  5 = "Total Amount of Ending Inventory" (pesos: never a count; its per-family amounts go in family_totals).',
      'Those printed numbers 1 to 5 are the count box\'s own numbering, not positions across the whole page. Read every',
      'count column; ending_on_hand is normally stockroom + drawer + selling_area, so an ending with nothing written',
      'beside it in the count box usually means those cells were missed.',
    ];
  }
  const cols = columnsForVersion(template.version);
  return [`Columns to read, left to right (handwritten integer): ${cols.map((c) => `${c.key} (col ${c.position}, "${c.label}")`).join(' · ')}.`];
}

export function buildAnchoredPromptP1(template: FormTemplate, opts: {unsure?: boolean; marks?: boolean} = {}): string {
  const keys = p1RowKeys(template);
  const lines: string[] = [];
  let idx = 0;
  for (const r of template.rows) {
    if (r.kind === 'group') {
      const price = r.unitPrice == null ? '' : ` (printed ₱${r.unitPrice})`;
      lines.push(`  [FAMILY] ${r.line}${price}`);
    } else {
      lines.push(`  row "${keys[idx]}" · ${r.product}`);
      idx++;
    }
  }
  return [
    `PAGE ${template.page} of ${PAGE_COUNT}. Form version ${template.version.toUpperCase()}.`,
    'FILL IN THE FORM. The rows below are the fixed, printed rows of this page, in printed order. Read ONLY the',
    'handwritten count cells and return them per row, identified by the row key. Do NOT decide the row set.',
    ...columnsTextP1(template),
    '',
    'PLACING EACH NUMBER ON THE RIGHT ROW (most errors are numbers put on the row above or below):',
    '- Find a row by looking LEFT along the same horizontal line from the handwriting to the printed ITEM# and',
    '  product. Never find a row by counting lines down the page.',
    '- Handwriting rarely sits centred in its cell. A writer is usually consistently LOW (on or across the ruled',
    '  line below the row) or HIGH. Before filling a family, look at all of its handwritten numbers together and',
    '  work out this writer\'s offset from the printed rows, then place every number in the family with that',
    '  same offset. A number that straddles a line belongs to the row the offset points to; it does not',
    '  automatically belong to the lower row.',
    '- One row\'s numbers are written side by side at about the same height across the columns, so they move',
    '  together. Two rows never share the same written numbers.',
    '',
    'CHECKS before you answer (they tell you where to LOOK AGAIN; still return only what is written):',
    '- Row math: ending_on_hand = stockroom + drawer + selling_area (delivery is NOT part of it). If a row you',
    '  placed does not add up, a number is probably misread or sitting on the neighbouring row: re-check it.',
    '- Family totals: the far-right "Total Amount of Ending Inventory" column has a handwritten peso amount per',
    '  family (often with a bracket spanning the family). Transcribe each into "family_totals" with the family',
    '  name as listed. It should equal (sum of the family\'s ending_on_hand) x the printed price. If it does not,',
    '  look again in that family for a missed number, a misread digit, or a number on the wrong row.',
    '',
    'Rules:',
    `- Return one entry for every row below (${idx} rows), with "row" set to the row key exactly as listed.`,
    '  A row with no counts (blank, or only an "O/S" mark) is still returned, with no count fields.',
    '- OMIT a blank cell entirely; only a written "0" is 0. Read the WRITTEN ending_on_hand; never compute it.',
    '- Map each cell by the PRINTED column header described above, not by any handwritten sub-label.',
    '- Also transcribe the printed DATA-column header labels into "column_headers", left to right, exactly as',
    '  printed on THIS page (do not reorder them to match the list above).',
    '- Read the header once: store code + name, period (MM/DD to MM/DD), beauty consultant.',
    '- A handwritten row that is NOT one of the rows below goes in "extras" with its printed code/name.',
    '- A handwritten price that differs from a family\'s printed price goes in "price_notes". Never change a count.',
    ...(opts.marks ? MARKS_PROMPT_ANCHORED : []),
    ...(opts.unsure
      ? [
          '- DOUBTFUL CELLS: if a written number could honestly be read two ways (4 or 9, 1 or 7, 3 or 8, 5 or 6, 0 or 6,',
          '  29 or 39, a dropped or extra leading digit), or a faint mark might or might not be a number, list that cell in the',
          '  row\'s "unsure" with the column and your SECOND reading ("alt"; use -1 when the second reading is blank). Also',
          '  list a cell you placed on this row when the writing sits between this row and the next. Leave "unsure" out for',
          '  a row whose numbers are clear. Never change your main reading because of this list.',
        ]
      : []),
    '- Give each row a confidence 0 to 1. Return JSON only.',
    'ROWS (family bands are context only; do NOT return a row for a [FAMILY] line):',
    ...lines,
  ].join('\n');
}

/** P1 schema + an optional per-row `unsure` list (one optional param; enum column + integer second reading). */
export function withUnsureSchema<S extends typeof ANCHORED_EXTRACTION_SCHEMA_P1>(schema: S): S {
  const items = schema.properties.rows.items;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      rows: {
        ...schema.properties.rows,
        items: {
          ...items,
          properties: {
            ...items.properties,
            unsure: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {col: {type: 'string', enum: [...COUNT_KEYS]}, alt: {type: 'integer'}},
                required: ['col', 'alt'],
              },
            },
          },
        },
      },
    },
  } as S;
}

/** P1 schema + the reader's review flags (NICH-36): an optional per-row `flags` list (one optional
 *  param) and a required page-level `headers_written_over` (required, so no optional budget). */
export function withMarksSchema<S extends typeof ANCHORED_EXTRACTION_SCHEMA_P1>(schema: S): S {
  const items = schema.properties.rows.items;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      rows: {...schema.properties.rows, items: {...items, properties: {...items.properties, flags: FLAGS_PROPERTY}}},
      headers_written_over: {type: 'array', items: {type: 'string'}},
    },
    required: [...schema.required, 'headers_written_over'],
  } as S;
}

export function buildAnchoredSystemPromptP1(): string {
  return [
    'You read NICHIDO COSMETICS "Semi-Monthly Inventory" form pages by FILLING A FIXED TEMPLATE.',
    "You are given the page's exact printed rows. Transcribe only the handwritten count cells and return them",
    'per row, keyed by the printed row you see on the same line as the handwriting. Never add, drop or rename a',
    'row, and never infer, estimate, average, or fill a blank. Return JSON only.',
  ].join('\n');
}

/** P1 schema: rows keyed by `row` (required string, no new optional params) + required
 *  `family_totals` (required inner fields). Same header / extras / price_notes / column_headers. */
export const ANCHORED_EXTRACTION_SCHEMA_P1 = {
  ...ANCHORED_EXTRACTION_SCHEMA,
  properties: {
    ...ANCHORED_EXTRACTION_SCHEMA.properties,
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          row: {type: 'string'},
          stockroom: {type: 'integer'},
          drawer: {type: 'integer'},
          selling_area: {type: 'integer'},
          delivery: {type: 'integer'},
          ending_on_hand: {type: 'integer'},
          confidence: {type: 'number'},
        },
        required: ['row', 'confidence'],
      },
    },
    family_totals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {family: {type: 'string'}, amount: {type: 'number'}},
        required: ['family', 'amount'],
      },
    },
  },
  required: ['rows', 'family_totals'],
} as const;

export type P1Signals = {
  unsureRows: number;
  unmatchedRows: number;
  duplicateRows: number;
  rowMathOff: number;
  familyChecked: number;
  familyMismatch: number;
};

/** Reconstruct the page from a P1 output: place each returned row by its key (never by position),
 *  then lower confidence where the paper's own checks still fail. */
export function mapAnchoredP1ToExtractedPage(template: FormTemplate, out: AnchoredOutputP1): AnchoredMapResult & {p1: P1Signals} {
  const items = templateItems(template);
  const keys = p1RowKeys(template).map(normKey);
  const codeOnly = items.map((it) => normKey(it.itemCode));
  const claimed: (AnchoredRowP1 | null)[] = items.map(() => null);
  const strays: AnchoredRowP1[] = [];
  let duplicateRows = 0;

  for (const r of out.rows ?? []) {
    const k = normKey(String(r.row ?? ''));
    let j = keys.indexOf(k);
    // A bare repeated code ("ACCS 288" without the product): first unclaimed occurrence, in order.
    if (j < 0) j = codeOnly.findIndex((c, i) => c === k && !claimed[i]);
    if (j < 0) { strays.push(r); continue; }
    if (claimed[j]) { duplicateRows++; continue; }
    claimed[j] = r;
  }

  // Reuse the index mapper for row reconstruction, extras, header and the version self-check.
  const asIndexed: AnchoredOutput = {
    ...out,
    rows: claimed.flatMap((r, i) => (r ? [{...r, i}] : [])),
    extras: [
      ...(out.extras ?? []),
      ...strays.filter((s) => COUNT_KEYS.some((c) => typeof s[c] === 'number')).map((s) => ({...s, code: s.row, name: null})),
    ],
  };
  const base = mapAnchoredToExtractedPage(template, asIndexed);
  const rows = base.page.rows;

  // Doubtful cells the reader named itself: the strongest evidence a row needs a look, and it carries the
  // second reading so the reviewer can decide at a glance.
  let unsureRows = 0;
  for (let i = 0; i < items.length; i++) {
    const u = (claimed[i]?.unsure ?? []).filter((c) => c && typeof c.col === 'string');
    if (!u.length) continue;
    unsureRows++;
    const r = rows[i];
    r.confidence = Math.min(r.confidence ?? 1, 0.45);
    const say = u.map((c) => `${c.col.replace(/_/g, ' ')} could be ${c.alt < 0 ? 'blank' : c.alt}`).join('; ');
    r.alt = r.alt ? `${r.alt}; ${say}` : say;
  }

  // The reader's review flags (NICH-36): a BA note or revision, or "Damage" in a count. Kept on the
  // row for the review flags, and the row goes to review.
  for (let i = 0; i < items.length; i++) applyReaderFlags(rows[i], cleanReaderFlags(claimed[i]?.flags));
  // "O/S" the reader flagged in a cell (os_drawer, ...) becomes 0 there (QA Nov 25), unless the
  // form prints that O/S itself (audit Nov 25): then the row only says so.
  applyPageOsFlags(rows.slice(0, items.length), items.map((_, i) => claimed[i]?.flags), {version: template.version, page: template.page});
  const headersOver = cleanHeaders(out.headers_written_over);
  if (headersOver.length) base.page.headers_written_over = headersOver;

  // Row math: ending = stockroom + drawer + selling_area. A mismatch keeps the written values but
  // drops confidence so the row is looked at.
  let rowMathOff = 0;
  for (let i = 0; i < items.length; i++) {
    const r = rows[i];
    const parts = [r.stockroom, r.drawer, r.selling_area].filter((x): x is number => typeof x === 'number');
    if (typeof r.ending_on_hand === 'number' && parts.length && parts.reduce((a, b) => a + b, 0) !== r.ending_on_hand) {
      rowMathOff++;
      r.confidence = Math.min(r.confidence ?? 1, 0.5);
      r.alt = r.alt ?? 'row does not add up (stockroom + drawer + selling area vs ending)';
    }
  }

  // Family totals: compare the handwritten peso amount with sum(ending) x printed price, for
  // families with one printed price (accessories carry per-item prices, so they are skipped).
  let familyChecked = 0, familyMismatch = 0;
  const totals = (out.family_totals ?? []).map((f) => ({k: normKey(f.family), amount: f.amount}));
  const groups = new Map<string, number[]>();
  items.forEach((it, i) => { if (it.group && it.unitPrice != null) (groups.get(it.group) ?? groups.set(it.group, []).get(it.group)!).push(i); });
  for (const [group, idxs] of groups) {
    if (idxs.length < 2) continue;
    const gk = normKey(group);
    const paper = totals.find((t) => t.k === gk || t.k.includes(gk) || gk.includes(t.k));
    if (!paper) continue;
    familyChecked++;
    // A band the paper prices differently, whose total reconciles at that price, is the band
    // price flag's job (src/band-prices.ts), not a misread: no "family total" note on its rows.
    const repriced = (base.page.bands ?? []).find((b) => b.group === group && b.kind != null && b.offer_price != null && b.amount != null && Math.abs(b.amount - b.pieces * b.offer_price) <= 1);
    if (repriced) continue;
    const price = items[idxs[0]].unitPrice as number;
    const sum = idxs.reduce((a, i) => a + (rows[i].ending_on_hand ?? 0), 0) * price;
    if (Math.abs(sum - paper.amount) > 1) {
      familyMismatch++;
      for (const i of idxs) {
        rows[i].confidence = Math.min(rows[i].confidence ?? 1, 0.6);
        rows[i].alt = rows[i].alt ?? `family total on paper ₱${paper.amount}, rows add to ₱${sum}`;
      }
    }
  }

  return {...base, p1: {unsureRows, unmatchedRows: strays.length, duplicateRows, rowMathOff, familyChecked, familyMismatch}};
}

/** Map either output shape: P1 rows carry `row`, the original carries `i`. Lets a batch submitted
 *  under one flag setting be ingested after the flag flips. */
export function mapAnchoredOutput(template: FormTemplate, out: AnchoredOutput | AnchoredOutputP1): AnchoredMapResult {
  const first = (out.rows ?? [])[0] as {row?: unknown} | undefined;
  return first && typeof first.row === 'string'
    ? mapAnchoredP1ToExtractedPage(template, out as AnchoredOutputP1)
    : mapAnchoredToExtractedPage(template, out as AnchoredOutput);
}

/**
 * The anchored-read schema with each row's count fields in the version's PRINTED column order.
 *
 * Structured outputs make the model emit an object's properties in schema order, and once a property
 * is written the ones declared before it can no longer be emitted. The base schemas list
 * stockroom, drawer, selling_area, delivery, ending_on_hand (V1's printed order). On V2 the paper
 * prints Delivery first, so the model writes `delivery` first and is then locked out of stockroom /
 * drawer / selling_area: measured on V2 pages, the read returned only delivery + ending (dozens of
 * numbers lost per page), while the same prompt without the schema returned every column. Ordering
 * the fields by the printed layout removes the lock-out; V1 (and Legacy, not anchored) are unchanged.
 */
export function anchoredSchemaFor<S extends typeof ANCHORED_EXTRACTION_SCHEMA | typeof ANCHORED_EXTRACTION_SCHEMA_P1>(schema: S, version: FormVersion): S {
  const order = columnsForVersion(version).map((c) => c.key as string);
  const props = schema.properties.rows.items.properties as Record<string, unknown>;
  const keys = Object.keys(props);
  const counts = keys.filter((k) => order.includes(k)).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  // The reader's own judgements come after the counts it judges (flags: NICH-36, off = unchanged).
  const tail = ['unsure', 'flags', 'confidence'];
  const lead = keys.filter((k) => !order.includes(k) && !tail.includes(k));
  const ordered: Record<string, unknown> = {};
  for (const k of [...lead, ...counts, ...tail.filter((k) => keys.includes(k))]) ordered[k] = props[k];
  return {
    ...schema,
    properties: {...schema.properties, rows: {...schema.properties.rows, items: {...schema.properties.rows.items, properties: ordered}}},
  } as S;
}
