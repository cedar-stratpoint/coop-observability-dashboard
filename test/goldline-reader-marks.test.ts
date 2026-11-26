import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('server-only', () => ({}));
import {applyReaderFlags, cleanHeaders, cleanReaderFlags, columnsChanged, pageCheckMarkFor, readerMarksFor, storeMarkFor} from '../src/goldline-reader-marks';
import {buildFormTemplate} from '../src/goldline-form-template';
import {anchoredSchemaFor, ANCHORED_EXTRACTION_SCHEMA_P1, mapAnchoredP1ToExtractedPage, withMarksSchema, type AnchoredOutputP1} from '../src/goldline-anchored-extract';
import {legacyRowToCore} from '../src/goldline-legacy-extract';
import {buildAnchoredParams, buildInventoryReadParams, mapInventoryRead} from '../src/goldline-extract-run';

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

// QA Nov 26: a BA writing Stockroom / Drawer / Selling over the printed Legacy headers was never
// flagged, because only the anchored V1/V2 read asked for headers_written_over.
describe('relabelled columns (QA Nov 26)', () => {
  afterEach(() => vi.unstubAllEnvs());
  const text = (p: {messages: Array<{content: Array<{type: string; text?: string}>}>}) => p.messages[0].content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

  it('Legacy and free V1/V2 reads ask for the headers written over when marks are on', () => {
    vi.stubEnv('GOLDLINE_READ_MARKS', '1');
    for (const v of ['legacy', 'v1', 'v2'] as const) {
      const p = buildInventoryReadParams('', 1, undefined, v);
      expect(Object.keys((p.output_config.format.schema as {properties: object}).properties)).toContain('headers_written_over');
      expect((p.output_config.format.schema as unknown as {required: string[]}).required).toContain('headers_written_over');
      expect(text(p)).toContain('headers_written_over');
    }
  });
  it('off: no reader asks for them', () => {
    vi.stubEnv('GOLDLINE_READ_MARKS', '');
    for (const v of ['legacy', 'v1'] as const) {
      const p = buildInventoryReadParams('', 1, undefined, v);
      expect(Object.keys((p.output_config.format.schema as {properties: object}).properties)).not.toContain('headers_written_over');
      expect(text(p)).not.toContain('headers_written_over');
    }
  });
  it('Columns changed comes from the written-over headers or, as a backstop, a Legacy page filled as locations', () => {
    expect(columnsChanged({headers_written_over: ['Beginning Inventory']})).toBe(true);
    expect(columnsChanged({legacy_layout: 'locations'})).toBe(true);
    expect(columnsChanged({legacy_layout: 'printed', headers_written_over: []})).toBe(false);
    expect(columnsChanged({})).toBe(false);
    expect(readerMarksFor({rows: [{item_code: 'A'}], legacy_layout: 'locations'})).toEqual([{itemCode: null, rowIndex: null, kind: 'column_changed'}]);
    expect(readerMarksFor({rows: [{item_code: 'A'}], legacy_layout: 'printed'})).toEqual([]);
  });
});

describe('store and version doubts as one page mark (QA Nov 26)', () => {
  it('names a store Coop corrected, could not match, or whose written name disagrees', () => {
    expect(storeMarkFor({code: '2414', status: 'corrected', from: '2944', by: 'name'})?.reason).toBe('Store read as 2944; Coop used 2414 from the store name');
    expect(storeMarkFor({code: '473', status: 'corrected', from: '472'})?.reason).toBe('Store read as 472; Coop used the nearest store, 473');
    expect(storeMarkFor({code: '2410', status: 'ambiguous', candidates: ['2413', '2414']})?.reason).toBe('Store 2410 isn’t a known store; did you mean 2413?');
    expect(storeMarkFor({code: '2944', status: 'name_mismatch', candidates: ['2414']})?.reason).toBe('Store 2944 read, but the store name points to 2414');
  });
  it('a clean or confirmed store carries no mark', () => {
    expect(storeMarkFor({code: '2414', status: 'exact'})).toBeNull();
    expect(storeMarkFor({code: '2414', status: 'confirmed'})).toBeNull();
    expect(storeMarkFor(null)).toBeNull();
  });
  it('joins a store doubt and an unsure version into one Other mark, no dashes', () => {
    const m = pageCheckMarkFor({store_snap: {code: '2414', status: 'corrected', from: '2944', by: 'name'}, version_unsure: true, version: 'v1'});
    expect(m).toMatchObject({itemCode: null, rowIndex: null, kind: 'other'});
    expect(m?.reason).toBe('Store read as 2944; Coop used 2414 from the store name. Form version unsure: read as V1, but the printed layout didn’t confirm it');
    expect(m?.reason).not.toMatch(/[–—]/);
    expect(pageCheckMarkFor({version_unsure: true, version: 'unknown'})?.reason).toBe('Form version unsure: the printed layout didn’t say V1 or V2');
    expect(pageCheckMarkFor({store_snap: {code: '473', status: 'exact'}})).toBeNull();
  });
});

describe('schema budget with headers (QA Nov 26)', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('free V1 read + headers stays within both caps', () => {
    vi.stubEnv('GOLDLINE_READ_MARKS', '1');
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
    const c = count(buildInventoryReadParams('', 1, undefined, 'v1').output_config.format.schema as Node);
    expect(c.optional).toBeLessThanOrEqual(24);
    expect(c.union).toBeLessThanOrEqual(16);
  });
});

describe('Legacy read result carries the relabel signals (QA Nov 26)', () => {
  it('keeps the headers written over and the page layout, so Columns changed can fire', () => {
    const row = (code: string, a: number, b: number, c: number) => ({item_code: code, beginning: a, delivery: b, begin_plus_delivery: c, deducted_pcs: null, ending_on_hand: a + b + c, confidence: 0.9});
    const out = mapInventoryRead(
      {store_code: '473', store_name: null, period_start: null, period_end: null, consultant: null, rows: [row('A', 1, 2, 3), row('B', 0, 4, 2), row('C', 2, 2, 2)], family_totals: [], headers_written_over: ['Beginning Inventory', 'Delivery']},
      1,
      undefined,
      'legacy',
    );
    expect(out.legacy_layout).toBe('locations');
    expect(out.headers_written_over).toEqual(['Beginning Inventory', 'Delivery']);
    expect(readerMarksFor(out).some((m) => m.kind === 'column_changed')).toBe(true);
  });
});
