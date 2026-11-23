// Exact row boxes for review (scan-review plan, step 3; modelled on the answer-key checking page,
// where it boxed the right row on every page checked by eye). Alongside each batched read, one small
// request shows the model the upright page and the printed rows in order, and asks where each row
// sits (top and bottom, in pixels of that image). The poller turns those into page fractions on the
// extracted rows' existing `box` field, which review already draws. Cosmetic only: no number is ever
// changed, and anything doubtful leaves the box off so review falls back to the template band.
import {EXTRACT_MODEL, MANIFESTS} from './goldline-extract';
import type {ExtractedRow} from './goldline-extract-run';
import type {FormTemplate} from './goldline-form-template';

export type LocateRow = {code: string; product: string};
export type LocateImage = {data: string; w: number; h: number};
export type LocateOutput = {rows?: {i?: number; top?: number; bottom?: number}[]};

const BOX_SUFFIX = '_box_';

/** The printed product rows of a page, top to bottom: the template's item rows, or for Legacy (no
 *  template) the same manifest the Legacy reader is given. Pure. */
export function locateRowsFor(template: FormTemplate | null, page: number): LocateRow[] {
  if (template) return template.rows.flatMap((r) => (r.kind === 'item' ? [{code: r.itemCode, product: r.product}] : []));
  return (MANIFESTS[page] ?? []).map((m) => ({code: m.code, product: m.product}));
}

/** custom_id of a page's box request in its batch (the image height rides along: the batch API only
 *  allows [A-Za-z0-9_-], and the poller needs it to turn pixels into page fractions). */
export function boxCustomId(uploadId: string, imageHeight: number): string {
  return `${uploadId}${BOX_SUFFIX}${Math.round(imageHeight)}`;
}

/** The image height from a box custom_id, or null when the id is not this page's box request. */
export function parseBoxCustomId(customId: string, uploadId: string): number | null {
  const prefix = `${uploadId}${BOX_SUFFIX}`;
  if (!customId.startsWith(prefix)) return null;
  const h = Number(customId.slice(prefix.length));
  return Number.isFinite(h) && h > 0 ? h : null;
}

export function isBoxCustomId(customId: string): boolean {
  return customId.includes(BOX_SUFFIX);
}

const LOCATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rows'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['i', 'top', 'bottom'],
        properties: {i: {type: 'integer'}, top: {type: 'integer'}, bottom: {type: 'integer'}},
      },
    },
  },
} as const;

/** Messages API params for the box request. */
export function buildLocateParams(image: LocateImage, rows: LocateRow[]) {
  const list = rows.map((r, i) => `${i}\t${r.code}\t${r.product}`).join('\n');
  return {
    model: EXTRACT_MODEL,
    max_tokens: 8000,
    output_config: {format: {type: 'json_schema', schema: LOCATE_SCHEMA}},
    messages: [
      {
        role: 'user',
        content: [
          {type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data: image.data}},
          {
            type: 'text',
            text:
              `This scan of a printed inventory form is ${image.w} px wide and ${image.h} px tall. Each product is one printed ` +
              `table row with its ITEM# code in the left column. For every product below (index, ITEM#, name, in printed ` +
              `order), give the top and bottom y pixel of the table row where that ITEM# is printed, measured in this image. ` +
              `Locate rows by the printed ITEM# text, not by counting. Several rows may share a code; they appear in the same ` +
              `order on the paper.\n\n${list}`,
          },
        ],
      },
    ],
  };
}

/**
 * Put each located row's box on the extracted rows (as page fractions). Rows are matched by code and
 * occurrence (the Nth row with a code on the paper is the Nth extracted row with it), never by
 * position, so off-manifest extras are skipped. Sanity: a box must sit inside the page and be at
 * most 6% of its height; if more than a tenth of the boxes run out of top-to-bottom order the whole
 * answer is dropped. Returns how many rows got a box. Mutates `rows`; pure otherwise.
 */
export function applyRowBoxes(rows: ExtractedRow[], list: LocateRow[], output: LocateOutput | null, imageHeight: number): number {
  const located = (output?.rows ?? [])
    .filter((r): r is {i: number; top: number; bottom: number} => Number.isInteger(r.i) && typeof r.top === 'number' && typeof r.bottom === 'number')
    .filter((r) => r.i >= 0 && r.i < list.length && r.top >= 0 && r.bottom <= imageHeight * 1.01 && r.bottom > r.top && r.bottom - r.top <= imageHeight * 0.06)
    .sort((a, b) => a.i - b.i);
  if (located.length === 0) return 0;
  let inversions = 0;
  for (let k = 1; k < located.length; k++) if (located[k].top < located[k - 1].top - imageHeight * 0.004) inversions++;
  if (inversions > located.length * 0.1) return 0;

  // code -> extracted rows with that code, in order (off-manifest extras excluded)
  const byCode = new Map<string, ExtractedRow[]>();
  for (const r of rows) {
    if (r.off_manifest) continue;
    const list2 = byCode.get(r.item_code) ?? [];
    list2.push(r);
    byCode.set(r.item_code, list2);
  }
  const seen = new Map<string, number>();
  const occ = list.map((r) => {
    const n = seen.get(r.code) ?? 0;
    seen.set(r.code, n + 1);
    return n;
  });
  let set = 0;
  for (const l of located) {
    const target = byCode.get(list[l.i].code)?.[occ[l.i]];
    if (!target) continue;
    target.box = {y_top: Math.max(0, l.top / imageHeight), y_bottom: Math.min(1, l.bottom / imageHeight)};
    set++;
  }
  return set;
}
