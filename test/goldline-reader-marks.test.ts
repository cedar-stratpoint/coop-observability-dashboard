import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('server-only', () => ({}));
import {applyReaderFlags, cleanHeaders, cleanReaderFlags, readerMarksFor} from '../src/goldline-reader-marks';
import {buildFormTemplate} from '../src/goldline-form-template';
import {anchoredSchemaFor, ANCHORED_EXTRACTION_SCHEMA_P1, mapAnchoredP1ToExtractedPage, withMarksSchema, type AnchoredOutputP1} from '../src/goldline-anchored-extract';
import {legacyRowToCore} from '../src/goldline-legacy-extract';
import {buildAnchoredParams, buildInventoryReadParams} from '../src/goldline-extract-run';

// Plan: knowledge/tasks/2026-11-25-review-marks-and-reco-reports.md (NICH-36)

const eyes = [
  {code: 'TCES17313', product: 'Gold Frost'},
  {code: 'TCES17316', product: 'Iced Violet'},
  {code: 'TCES17317', product: 'Electric Pink'},
];
const catalog = Object.fromEntries(eyes.map((e) => [e.code, {productLine: 'TRUE COLORS EYE SHADOW', unitPrice: 88}]));
const v1 = buildFormTemplate(3, 'v1', eyes, catalog);
const keysOf = (s: unknown) => Object.keys((s as {properties: {rows: {items: {properties: object}}}}).properties.rows.items.properties);

describe('cleaning the read', () => {
  it('keeps known flags once, drops anything else', () => {
    expect(cleanReaderFlags(['damage', 'note', 'damage', 'padding', 3])).toEqual(['note', 'damage']);
    expect(cleanReaderFlags(null)).toEqual([]);
  });
  it('trims headers and drops blanks', () => expect(cleanHeaders([' Beginning Inventory ', '', 'Delivery', 'Delivery', 7])).toEqual(['Beginning Inventory', 'Delivery']));
});

describe('applyReaderFlags', () => {
  it('sends a flagged row to review with a plain note, never the BA’s text', () => {
    const r = applyReaderFlags({confidence: 0.95, alt: null as string | null}, ['damage']);
    expect(r).toMatchObject({reader_flags: ['damage'], confidence: 0.5, alt: '“Damage” written in a count, left blank'});
    expect(applyReaderFlags({confidence: 0.9, alt: 'faint'}, ['note'])).toMatchObject({confidence: 0.6, alt: 'faint; BA note or revision on this row'});
  });
  it('leaves a clean row untouched', () => expect(applyReaderFlags({confidence: 0.9}, [])).toEqual({confidence: 0.9}));
});

describe('readerMarksFor', () => {
  it('note and damage per row, written-in rows, and relabelled columns for the page', () => {
    const marks = readerMarksFor({
      rows: [
        {item_code: 'TCES17313', reader_flags: ['damage']},
        {item_code: 'TCES17317', reader_flags: ['note', 'damage']},
        {item_code: 'TSP01205', off_manifest: true},
        {item_code: '', off_manifest: true},
        {item_code: 'TCES17316'},
      ],
      headers_written_over: ['Beginning Inventory'],
    });
    expect(marks).toEqual([
      {itemCode: 'TCES17313', rowIndex: 0, kind: 'damage'},
      {itemCode: 'TCES17317', rowIndex: 1, kind: 'note'},
      {itemCode: 'TCES17317', rowIndex: 1, kind: 'damage'},
      {itemCode: 'TSP01205', rowIndex: 2, kind: 'added_row'},
      {itemCode: 'written-in 4', rowIndex: 3, kind: 'added_row'},
      {itemCode: null, rowIndex: null, kind: 'column_changed'},
    ]);
  });
  it('a clean page has no flags', () => expect(readerMarksFor({rows: [{item_code: 'A'}], headers_written_over: []})).toEqual([]));
});

describe('anchored P1 read with marks', () => {
  it('the flags field comes after the counts; headers_written_over is required', () => {
    const s = anchoredSchemaFor(withMarksSchema(ANCHORED_EXTRACTION_SCHEMA_P1), 'v1');
    expect(keysOf(s)).toEqual(['row', 'stockroom', 'drawer', 'selling_area', 'delivery', 'ending_on_hand', 'flags', 'confidence']);
    expect(s.required).toContain('headers_written_over');
    expect(keysOf(anchoredSchemaFor(ANCHORED_EXTRACTION_SCHEMA_P1, 'v1'))).not.toContain('flags');
  });
  it('maps flags onto their rows and the written-over headers onto the page', () => {
    const out: AnchoredOutputP1 = {
      rows: [
        {row: 'TCES17313', selling_area: 1, confidence: 0.9, flags: ['damage']},
        {row: 'TCES17316', confidence: 0.9},
        {row: 'TCES17317', selling_area: 1, confidence: 0.95, flags: ['damage', 'nonsense']},
      ],
      family_totals: [],
      headers_written_over: ['Delivery'],
    };
    const {page} = mapAnchoredP1ToExtractedPage(v1, out);
    expect(page.rows.map((r) => r.reader_flags ?? null)).toEqual([['damage'], null, ['damage']]);
    expect(page.rows[0].confidence).toBeLessThanOrEqual(0.5);
    expect(page.headers_written_over).toEqual(['Delivery']);
  });
});

describe('Legacy read with marks', () => {
  it('carries a Damage flag onto the core row', () => {
    const r = legacyRowToCore({item_code: 'X1', beginning: 2, delivery: null, begin_plus_delivery: 1, deducted_pcs: null, ending_on_hand: null, confidence: 0.9, flags: ['damage']}, 'locations');
    expect(r).toMatchObject({stockroom: 2, selling_area: 1, ending_on_hand: null, reader_flags: ['damage'], confidence: 0.5});
  });
  it('a row without flags maps exactly as before', () => {
    const r = legacyRowToCore({item_code: 'X1', beginning: 2, delivery: 1, begin_plus_delivery: 3, deducted_pcs: null, ending_on_hand: 3, confidence: 0.9}, 'printed');
    expect(r).not.toHaveProperty('reader_flags');
    expect(r.confidence).toBe(0.9);
  });
});

describe('GOLDLINE_READ_MARKS switch', () => {
  afterEach(() => vi.unstubAllEnvs());
  const text = (p: {messages: Array<{content: Array<{type: string; text?: string}>}>}) => p.messages[0].content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

  it('off: the P1 and Legacy requests carry no flags field and no prompt lines', () => {
    vi.stubEnv('GOLDLINE_READ_P1', '1');
    vi.stubEnv('GOLDLINE_READ_MARKS', '');
    const a = buildAnchoredParams('', v1);
    expect(keysOf(a.output_config.format.schema)).not.toContain('flags');
    expect(text(a)).not.toContain('NOTES AND DAMAGE');
    const l = buildInventoryReadParams('', 1, undefined, 'legacy');
    expect(keysOf(l.output_config.format.schema)).not.toContain('flags');
    expect(text(l)).not.toContain('NOTES AND DAMAGE');
  });
  it('on: both reads ask for flags; the free V1/V2 read is unchanged', () => {
    vi.stubEnv('GOLDLINE_READ_P1', '1');
    vi.stubEnv('GOLDLINE_READ_MARKS', '1');
    const a = buildAnchoredParams('', v1);
    expect(keysOf(a.output_config.format.schema)).toContain('flags');
    expect(text(a)).toContain('NOTES AND DAMAGE');
    const l = buildInventoryReadParams('', 1, undefined, 'legacy');
    expect(keysOf(l.output_config.format.schema)).toContain('flags');
    expect(text(l)).toContain('NOTES AND DAMAGE');
    expect(keysOf(buildInventoryReadParams('', 1, undefined, 'v1').output_config.format.schema)).not.toContain('flags');
  });
  it('on without P1: the original anchored read is unchanged', () => {
    vi.stubEnv('GOLDLINE_READ_P1', '');
    vi.stubEnv('GOLDLINE_READ_MARKS', '1');
    expect(keysOf(buildAnchoredParams('', v1).output_config.format.schema)).not.toContain('flags');
  });
});

describe('schema budget (API caps: 24 optional, 16 union-typed params)', () => {
  type Node = {type?: unknown; properties?: Record<string, Node>; required?: readonly string[]; items?: Node};
  const count = (n: Node, acc = {optional: 0, union: 0}) => {
    if (Array.isArray(n.type)) acc.union++;
    if (n.properties) {
      const req = new Set(n.required ?? []);
      for (const [k, v] of Object.entries(n.properties)) {
        if (!req.has(k)) acc.optional++;
        count(v, acc);
      }
    }
    if (n.items) count(n.items, acc);
    return acc;
  };
  afterEach(() => vi.unstubAllEnvs());
  it('P1 + unsure + marks (the largest anchored schema) stays within both caps', () => {
    vi.stubEnv('GOLDLINE_READ_P1', '1');
    vi.stubEnv('GOLDLINE_READ_UNSURE', '1');
    vi.stubEnv('GOLDLINE_READ_MARKS', '1');
    const c = count(buildAnchoredParams('', v1).output_config.format.schema as Node);
    expect(c.optional).toBeLessThanOrEqual(24);
    expect(c.union).toBeLessThanOrEqual(16);
  });
  it('Legacy + marks stays within both caps', () => {
    vi.stubEnv('GOLDLINE_READ_MARKS', '1');
    const c = count(buildInventoryReadParams('', 1, undefined, 'legacy').output_config.format.schema as Node);
    expect(c.optional).toBeLessThanOrEqual(24);
    expect(c.union).toBeLessThanOrEqual(16);
  });
});
