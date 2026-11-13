import {describe, expect, it} from 'vitest';
import {buildFormTemplate} from '../src/goldline-form-template';
import {
  ANCHORED_EXTRACTION_SCHEMA,
  buildAnchoredPrompt,
  buildAnchoredSystemPrompt,
  mapAnchoredToExtractedPage,
  type AnchoredOutput,
} from '../src/goldline-anchored-extract';

// Phase 1: fill the template. The model returns numbers by row index; the mapper rebuilds the
// full page from the template, so a drop is impossible and an invented row can only be an extra.

const items = [
  {code: 'USMLLC01', product: "O' So Spice"},
  {code: 'USMLLC02', product: 'Fast Play'},
];
const catalog = {
  USMLLC01: {productLine: 'Ultra Stay Matte Liquid Lip Color', unitPrice: 225},
  USMLLC02: {productLine: 'Ultra Stay Matte Liquid Lip Color', unitPrice: 225},
};
const template = buildFormTemplate(1, 'v1', items, catalog); // rows: [group, item0, item1], itemCount 2

describe('buildAnchoredPrompt', () => {
  it('lists the item rows by index with code + name, shows family bands, and states the column positions', () => {
    const p = buildAnchoredPrompt(template);
    expect(p).toContain('0 · USMLLC01 · O');
    expect(p).toContain('1 · USMLLC02 · Fast Play');
    expect(p).toContain('[FAMILY] Ultra Stay Matte Liquid Lip Color');
    expect(p).toContain('delivery (col 4'); // V1: Delivery is column 4
    expect(p).toContain('Return exactly one entry for each of the 2 item rows');
    expect(p).toContain('do not\n  compute or overwrite it with a sum');
  });
});

describe('buildAnchoredSystemPrompt', () => {
  it('tells the model to fill a fixed template, not re-type codes/names or change the row set', () => {
    const s = buildAnchoredSystemPrompt();
    expect(s).toMatch(/FILLING A FIXED TEMPLATE/);
    expect(s).toMatch(/Never re-type the codes or product names/);
    expect(s).toMatch(/never add, drop, reorder, or rename a row/);
  });
});

describe('mapAnchoredToExtractedPage', () => {
  it('rebuilds every row in order with code + name from the template and numbers from the output', () => {
    const out: AnchoredOutput = {
      header: {store_code: '473', consultant: 'Leonisa'},
      rows: [
        {i: 0, ending_on_hand: 17, confidence: 0.9},
        {i: 1, ending_on_hand: 1, confidence: 0.92},
      ],
    };
    const {page, filledBlanks, extras} = mapAnchoredToExtractedPage(template, out);
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0].item_code).toBe('USMLLC01');
    expect(page.rows[0].printed_name).toBe("O' So Spice");
    expect(page.rows[0].ending_on_hand).toBe(17);
    expect(page.rows[0].off_manifest).toBe(false);
    expect(page.rows[1].ending_on_hand).toBe(1);
    expect(page.store_code).toBe('473');
    expect(filledBlanks).toBe(0);
    expect(extras).toBe(0);
  });

  it('never drops a template row the model skipped: keeps it blank, flagged, and counts it', () => {
    const out: AnchoredOutput = {rows: [{i: 0, ending_on_hand: 17, confidence: 0.9}]}; // row 1 missing
    const {page, filledBlanks} = mapAnchoredToExtractedPage(template, out);
    expect(page.rows).toHaveLength(2); // both rows still present
    expect(page.rows[1].item_code).toBe('USMLLC02');
    expect(page.rows[1].ending_on_hand).toBeNull();
    expect(page.rows[1].confidence).toBe(0);
    expect(page.rows[1].alt).toMatch(/kept blank/);
    expect(filledBlanks).toBe(1);
  });

  it('cannot invent a body row: an out-of-range index is ignored', () => {
    const out: AnchoredOutput = {
      rows: [
        {i: 0, ending_on_hand: 17, confidence: 0.9},
        {i: 1, ending_on_hand: 1, confidence: 0.9},
        {i: 5, ending_on_hand: 99, confidence: 0.8}, // no such template row
      ],
    };
    const {page} = mapAnchoredToExtractedPage(template, out);
    expect(page.rows).toHaveLength(2);
    expect(page.rows.every((r) => r.item_code.startsWith('USMLLC'))).toBe(true);
  });

  it('captures a handwritten write-in as a flagged off_manifest extra, after the body', () => {
    const out: AnchoredOutput = {
      rows: [
        {i: 0, ending_on_hand: 17, confidence: 0.9},
        {i: 1, ending_on_hand: 1, confidence: 0.9},
      ],
      extras: [{code: 'XX01', name: 'Hand Written', ending_on_hand: 3, confidence: 0.5}],
    };
    const {page, extras} = mapAnchoredToExtractedPage(template, out);
    expect(page.rows).toHaveLength(3);
    const last = page.rows[2];
    expect(last.off_manifest).toBe(true);
    expect(last.item_code).toBe('XX01');
    expect(last.alt).toMatch(/not on the template/);
    expect(extras).toBe(1);
  });

  it('surfaces handwritten price overrides without touching counts', () => {
    const out: AnchoredOutput = {
      rows: [{i: 0, ending_on_hand: 17, confidence: 0.9}],
      price_notes: [{group: 'Ultra Stay Matte Liquid Lip Color', printed_price: 225, written_price: 180, confidence: 0.8}],
    };
    const {priceNotes, page} = mapAnchoredToExtractedPage(template, out);
    expect(priceNotes).toHaveLength(1);
    expect(priceNotes[0].written_price).toBe(180);
    expect(page.rows[0].ending_on_hand).toBe(17); // counts unchanged
  });
});

describe('ANCHORED_EXTRACTION_SCHEMA', () => {
  it('is a numbers-only object schema requiring the rows array', () => {
    expect(ANCHORED_EXTRACTION_SCHEMA.type).toBe('object');
    expect(ANCHORED_EXTRACTION_SCHEMA.required).toContain('rows');
    // No product name/code in a row entry — rows carry only index + numbers + confidence.
    const rowProps = Object.keys(ANCHORED_EXTRACTION_SCHEMA.properties.rows.items.properties);
    expect(rowProps).not.toContain('name');
    expect(rowProps).not.toContain('code');
    expect(rowProps).toContain('i');
    expect(rowProps).toContain('ending_on_hand');
  });
});
