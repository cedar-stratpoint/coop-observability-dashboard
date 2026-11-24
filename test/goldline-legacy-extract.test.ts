import {describe, expect, it} from 'vitest';
import {
  buildLegacyManifestPrompt,
  legacyRowMathOff,
  legacyPageLayout,
  legacyPageToCore,
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

import {rowBandFor} from '../src/goldline-extract';

describe('rowBandFor', () => {
  it('returns a band inside the page for an item on it', () => {
    const b = rowBandFor('FBPP01', 1)!; // first item on page 1 → near the top of the grid
    expect(b).not.toBeNull();
    expect(b.top).toBeGreaterThanOrEqual(0);
    expect(b.top + b.height).toBeLessThanOrEqual(1);
    const last = rowBandFor('6in1PSLFBI', 1)!; // last item → lower than the first
    expect(last.top).toBeGreaterThan(b.top);
  });
  it('is null for an item not on the page, or a page with no manifest', () => {
    expect(rowBandFor('NOPE', 1)).toBeNull();
    expect(rowBandFor('FBPP01', 6)).toBeNull(); // page 6 is the sales report, no manifest
  });
});

describe('legacyPageLayout / legacyPageToCore', () => {
  // SM San Pablo p.7 (QA Nov 23/24): "Stockroom / Drawer / Selling" written over the printed
  // headers; IPSLS01 has drawer 4, selling 2, ending 6.
  const sanPablo = [
    row({item_code: 'IPSLS01', delivery: 4, begin_plus_delivery: 2, ending_on_hand: 6}),
    row({item_code: 'IPSLS02', delivery: 2, begin_plus_delivery: 2, ending_on_hand: 4}),
    row({item_code: 'TCPBT02', beginning: 20, begin_plus_delivery: 11, ending_on_hand: 31}),
    row({item_code: 'MUIS09', beginning: 4, begin_plus_delivery: 5, ending_on_hand: 9}),
    row({item_code: 'IPSLS09'}), // blank row: ignored by the vote
  ];

  it('files a page whose columns add up to Ending as stockroom / drawer / selling', () => {
    expect(legacyPageLayout(sanPablo)).toBe('locations');
    const {layout, rows} = legacyPageToCore(sanPablo);
    expect(layout).toBe('locations');
    expect(rows[0]).toMatchObject({stockroom: null, drawer: 4, selling_area: 2, delivery: null, ending_on_hand: 6});
    expect(rows[2]).toMatchObject({stockroom: 20, drawer: null, selling_area: 11, delivery: null, ending_on_hand: 31});
    expect(rows[0].extra).toBeUndefined();
  });

  it('keeps the printed deducted model when the page follows it', () => {
    const printed = [
      row({beginning: 20, delivery: 5, begin_plus_delivery: 25, deducted_pcs: 8, ending_on_hand: 17}),
      row({beginning: 10, delivery: 0, begin_plus_delivery: 10, deducted_pcs: 4, ending_on_hand: 6}),
      row({beginning: 3, delivery: 2, begin_plus_delivery: 5, deducted_pcs: 5, ending_on_hand: 0}),
    ];
    expect(legacyPageLayout(printed)).toBe('printed');
    expect(legacyPageToCore(printed).rows[0]).toMatchObject({stockroom: null, delivery: 5, ending_on_hand: 17});
  });

  it('needs at least 3 counted rows and an 80% fit before re-filing', () => {
    expect(legacyPageLayout(sanPablo.slice(0, 2))).toBe('printed');
    const mixed = [...sanPablo.slice(0, 3), row({beginning: 5, delivery: 5, ending_on_hand: 3}), row({beginning: 1, ending_on_hand: 9})];
    expect(legacyPageLayout(mixed)).toBe('printed'); // 3 of 5 fit = 60%
  });
});

describe('buildLegacyManifestPrompt rows', () => {
  it("lists the Legacy form's own printed rows (Double Espresso is on Legacy page 3)", () => {
    expect(buildLegacyManifestPrompt(3)).toContain('24HRMESGDE Double Espresso');
  });
  it('asks for notes in column names, not column numbers', () => {
    expect(buildLegacyManifestPrompt(1)).toMatch(/never "col3"/);
  });
});
