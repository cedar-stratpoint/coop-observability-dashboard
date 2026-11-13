import {PAGE_COUNT, type FormVersion} from './goldline-extract';
import {columnsForVersion, templateItems, type FormTemplate} from './goldline-form-template';
import type {ExtractedPage, ExtractedRow} from './goldline-extract-run';

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
