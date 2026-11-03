import {describe, expect, it} from 'vitest';
import {
  buildLegacyManifestPrompt,
  legacyRowMathOff,
  legacyRowToCore,
  type LegacyExtractedRow,
} from '../src/goldline-legacy-extract';
import {buildManifestPrompt} from '../src/goldline-extract';

const row = (p: Partial<LegacyExtractedRow>): LegacyExtractedRow => ({
  item_code: 'FBPP01',
  beginning: null,
  delivery: null,
  begin_plus_delivery: null,
  deducted_pcs: null,
  ending_on_hand: null,
  confidence: 0.9,
  ...p,
});

describe('legacyRowToCore', () => {
  it('maps delivery + ending to the core and tucks the rest in extra', () => {
    const core = legacyRowToCore(row({beginning: 20, delivery: 5, begin_plus_delivery: 25, deducted_pcs: 8, ending_on_hand: 17}));
    expect(core).toMatchObject({
      item_code: 'FBPP01',
      stockroom: null,
      drawer: null,
      selling_area: null,
      delivery: 5,
      ending_on_hand: 17,
    });
    expect(core.extra).toEqual({beginning: 20, begin_plus_delivery: 25, deducted_pcs: 8});
  });
});

describe('legacyRowMathOff', () => {
  it('passes a consistent deducted row (col3=col1+col2, col6=col3-col4)', () => {
    expect(legacyRowMathOff(row({beginning: 20, delivery: 5, begin_plus_delivery: 25, deducted_pcs: 8, ending_on_hand: 17}))).toBeNull();
  });
  it('flags a broken begin+delivery identity', () => {
    const off = legacyRowMathOff(row({beginning: 20, delivery: 5, begin_plus_delivery: 24}));
    expect(off).toMatchObject({rule: 'begin_plus_delivery = beginning + delivery', written: 24, expected: 25});
  });
  it('flags a broken ending identity', () => {
    const off = legacyRowMathOff(row({begin_plus_delivery: 25, deducted_pcs: 8, ending_on_hand: 16}));
    expect(off).toMatchObject({rule: 'ending = begin_plus_delivery - deducted', written: 16, expected: 17});
  });
  it('falls back to beginning+delivery-deducted when col3 is blank', () => {
    const off = legacyRowMathOff(row({beginning: 20, delivery: 5, deducted_pcs: 8, ending_on_hand: 18}));
    expect(off).toMatchObject({rule: 'ending = beginning + delivery - deducted', written: 18, expected: 17});
  });
  it('does not flag when inputs are missing', () => {
    expect(legacyRowMathOff(row({ending_on_hand: 17}))).toBeNull();
    expect(legacyRowMathOff(row({beginning: 20, ending_on_hand: 17}))).toBeNull();
  });
});

describe('prompts', () => {
  it('legacy manifest names the deducted columns and the identities', () => {
    const p = buildLegacyManifestPrompt(1);
    expect(p).toContain('LEGACY');
    expect(p).toContain('begin_plus_delivery');
    expect(p).toContain('col3 = col1 + col2');
    expect(p).toContain('FBPP01'); // same product manifest as other versions
  });
  it('v1 vs v2 manifest states the delivery-column position', () => {
    expect(buildManifestPrompt(1, 'v1')).toContain('delivery (col4)');
    expect(buildManifestPrompt(1, 'v2')).toContain('delivery (col1, FIRST)');
    // same five fields, same product rows
    expect(buildManifestPrompt(1, 'v2')).toContain('ending_on_hand = stockroom + drawer + selling_area');
  });
  it('legacy manifest throws for a page with no manifest', () => {
    expect(() => buildLegacyManifestPrompt(6)).toThrow(/manifest/);
  });
});
