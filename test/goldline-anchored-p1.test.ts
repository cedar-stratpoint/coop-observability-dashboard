import {describe, expect, it} from 'vitest';
import {buildFormTemplate} from '../src/goldline-form-template';
import {
  ANCHORED_EXTRACTION_SCHEMA,
  ANCHORED_EXTRACTION_SCHEMA_P1,
  anchoredSchemaFor,
  buildAnchoredPromptP1,
  mapAnchoredOutput,
  mapAnchoredP1ToExtractedPage,
  p1RowKeys,
  withUnsureSchema,
  type AnchoredOutputP1,
} from '../src/goldline-anchored-extract';

// Plan: knowledge/tasks/2026-11-19-handwriting-read-accuracy.md

const lashes = [
  {code: 'TLGL4453', product: '84453'},
  {code: 'TLGL4469', product: '84469'},
  {code: 'TLGL4711', product: '84711'},
  {code: 'TLGL5268', product: '85268'},
];
const catalog = Object.fromEntries(lashes.map((l) => [l.code, {productLine: 'NICHIDO TRULASHES - GLAMOUR LASHES', unitPrice: 150}]));
const v1 = buildFormTemplate(5, 'v1', lashes, catalog);
const v2 = buildFormTemplate(5, 'v2', lashes, catalog);
const keysOf = (s: unknown) => Object.keys((s as {properties: {rows: {items: {properties: object}}}}).properties.rows.items.properties);

describe('anchoredSchemaFor (structured-output field order)', () => {
  it('keeps V1 in its printed order (unchanged)', () => {
    expect(keysOf(anchoredSchemaFor(ANCHORED_EXTRACTION_SCHEMA, 'v1'))).toEqual(['i', 'stockroom', 'drawer', 'selling_area', 'delivery', 'ending_on_hand', 'confidence']);
  });
  it('puts Delivery first on V2 so the model is not locked out of stockroom / drawer / selling', () => {
    expect(keysOf(anchoredSchemaFor(ANCHORED_EXTRACTION_SCHEMA, 'v2'))).toEqual(['i', 'delivery', 'stockroom', 'drawer', 'selling_area', 'ending_on_hand', 'confidence']);
    expect(keysOf(anchoredSchemaFor(ANCHORED_EXTRACTION_SCHEMA_P1, 'v2'))).toEqual(['row', 'delivery', 'stockroom', 'drawer', 'selling_area', 'ending_on_hand', 'confidence']);
  });
  it('does not mutate the shared base schema', () => {
    anchoredSchemaFor(ANCHORED_EXTRACTION_SCHEMA, 'v2');
    expect(keysOf(ANCHORED_EXTRACTION_SCHEMA)[1]).toBe('stockroom');
  });
});

describe('buildAnchoredPromptP1', () => {
  it('keys rows by printed ITEM# and tells the reader to look left, not count', () => {
    const p = buildAnchoredPromptP1(v1);
    expect(p).toContain('row "TLGL4469" · 84469');
    expect(p).toMatch(/Never find a row by counting lines/);
    expect(p).toMatch(/family_totals/);
  });
  it('describes V2 by its printed boxes and 1 to 5 numbering', () => {
    const p = buildAnchoredPromptP1(v2);
    expect(p).toMatch(/DELIVERY is its own box on the LEFT/);
    expect(p).toMatch(/1 = stockroom/);
  });
  it('disambiguates repeated codes with the product name', () => {
    const acc = buildFormTemplate(4, 'v1', [{code: 'ACCS 288', product: 'Brush #185'}, {code: 'ACCS 288', product: 'Brush #193'}], {});
    expect(p1RowKeys(acc)).toEqual(['ACCS 288 | Brush #185', 'ACCS 288 | Brush #193']);
  });
});

describe('mapAnchoredP1ToExtractedPage', () => {
  const out: AnchoredOutputP1 = {
    rows: [
      {row: 'TLGL4453', selling_area: 1, ending_on_hand: 1, confidence: 0.9},
      {row: 'TLGL4469', stockroom: 5, selling_area: 1, ending_on_hand: 6, confidence: 0.9},
      {row: 'TLGL5268', stockroom: 3, selling_area: 1, ending_on_hand: 4, confidence: 0.9},
    ],
    family_totals: [{family: 'NICHIDO TRULASHES - GLAMOUR LASHES', amount: 1650}],
  };
  it('places numbers by the row key, so a skipped row cannot shift the rest', () => {
    const m = mapAnchoredP1ToExtractedPage(v1, out);
    const by = Object.fromEntries(m.page.rows.map((r) => [r.item_code, r.ending_on_hand]));
    expect(by).toEqual({TLGL4453: 1, TLGL4469: 6, TLGL4711: null, TLGL5268: 4});
    expect(m.p1.familyMismatch).toBe(0); // 11 units x 150 = 1,650
  });
  it('lowers confidence where row math or the paper family total disagrees, without changing values', () => {
    const bad = {...out, rows: [...out.rows.slice(0, 2), {row: 'TLGL5268', stockroom: 3, selling_area: 1, ending_on_hand: 9, confidence: 0.9}]};
    const m = mapAnchoredP1ToExtractedPage(v1, bad);
    const r = m.page.rows.find((x) => x.item_code === 'TLGL5268')!;
    expect(r.ending_on_hand).toBe(9);
    expect(r.confidence).toBeLessThanOrEqual(0.5);
    expect(m.p1.rowMathOff).toBe(1);
    expect(m.p1.familyMismatch).toBe(1);
  });
  it('sends an unknown row key to flagged extras', () => {
    const m = mapAnchoredP1ToExtractedPage(v1, {...out, rows: [...out.rows, {row: 'ZZZ1', ending_on_hand: 3, confidence: 0.5}]});
    expect(m.extras).toBe(1);
    expect(m.page.rows.at(-1)).toMatchObject({item_code: 'ZZZ1', off_manifest: true});
  });
});

describe('mapAnchoredOutput', () => {
  it('maps the original index-keyed output unchanged', () => {
    const m = mapAnchoredOutput(v1, {rows: [{i: 1, stockroom: 5, ending_on_hand: 6, confidence: 0.9}]});
    expect(m.page.rows[1]).toMatchObject({item_code: 'TLGL4469', ending_on_hand: 6});
  });
});

describe('per-cell doubt (unsure)', () => {
  it('adds an optional unsure list after the counts, before confidence', () => {
    const keys = keysOf(anchoredSchemaFor(withUnsureSchema(ANCHORED_EXTRACTION_SCHEMA_P1), 'v2'));
    expect(keys).toEqual(['row', 'delivery', 'stockroom', 'drawer', 'selling_area', 'ending_on_hand', 'unsure', 'confidence']);
  });
  it('asks for doubtful cells only when enabled', () => {
    expect(buildAnchoredPromptP1(v1, {unsure: true})).toMatch(/DOUBTFUL CELLS/);
    expect(buildAnchoredPromptP1(v1)).not.toMatch(/DOUBTFUL CELLS/);
  });
  it('lowers confidence and names the second reading, without changing the value', () => {
    const m = mapAnchoredP1ToExtractedPage(v1, {
      rows: [{row: 'TLGL4469', stockroom: 5, selling_area: 1, ending_on_hand: 6, confidence: 0.9, unsure: [{col: 'ending_on_hand', alt: 8}, {col: 'stockroom', alt: -1}]}],
      family_totals: [],
    });
    const r = m.page.rows.find((x) => x.item_code === 'TLGL4469')!;
    expect(r.ending_on_hand).toBe(6);
    expect(r.confidence).toBeLessThanOrEqual(0.45);
    expect(r.alt).toMatch(/ending on hand could be 8/);
    expect(r.alt).toMatch(/stockroom could be blank/);
    expect(m.p1.unsureRows).toBe(1);
  });
});
