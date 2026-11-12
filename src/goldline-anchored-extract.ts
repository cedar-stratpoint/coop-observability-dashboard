import {PAGE_COUNT} from './goldline-extract';
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
};

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
    '- A blank cell is null; only a written "0" is 0. Read the WRITTEN ending_on_hand value; do not',
    '  compute or overwrite it with a sum.',
    '- Map each cell by the PRINTED column position above, not by any handwritten sub-label.',
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

/** Structured-output schema for the numbers-only anchored read (three-location V1/V2). */
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
    },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          i: {type: 'integer'},
          stockroom: {type: ['integer', 'null']},
          drawer: {type: ['integer', 'null']},
          selling_area: {type: ['integer', 'null']},
          delivery: {type: ['integer', 'null']},
          ending_on_hand: {type: ['integer', 'null']},
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
          stockroom: {type: ['integer', 'null']},
          drawer: {type: ['integer', 'null']},
          selling_area: {type: ['integer', 'null']},
          delivery: {type: ['integer', 'null']},
          ending_on_hand: {type: ['integer', 'null']},
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

  return {page, filledBlanks, extras: extras.length, priceNotes: out.price_notes ?? []};
}
