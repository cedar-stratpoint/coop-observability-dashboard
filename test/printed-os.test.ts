import {describe, expect, it} from 'vitest';
import {applyPageOsFlags, applyPageOutOfStock, markPrintedOs, printedOsRows} from '../src/printed-os';
import type {OutOfStock} from '../src/out-of-stock';

const row = (item_code: string, p: Record<string, unknown> = {}) => ({
  item_code, stockroom: null, drawer: null, selling_area: null, delivery: null, ending_on_hand: null, confidence: 0.9, alt: null as string | null, ...p,
}) as {item_code: string; printed_name?: string | null; stockroom: number | null; drawer: number | null; selling_area: number | null; delivery: number | null; ending_on_hand: number | null; confidence: number; alt?: string | null; oos?: OutOfStock | null; os_printed?: boolean | null};

// Audit of the Oct scan (Nov 25): every O/S was printed by Nichido on these rows, on every
// store's copy. None was written by a BA.
describe('printedOsRows', () => {
  it('Legacy page 3: the two eyebrow gels and LEL091', () => {
    const rows = ['MSCPR', '24HRMESGDE', '24HRMESGM', 'LCTPFCB', 'LEL091', 'EGLE'].map((c) => row(c));
    expect([...printedOsRows(rows, 'legacy', 3)]).toEqual([1, 2, 4]);
    expect([...printedOsRows(rows, 'legacy', 2)]).toEqual([]);
    expect([...printedOsRows(rows, null, 3)]).toEqual([]);
  });
  it('V1 page 4: accessories that share a printed code are told apart by their printed name', () => {
    const rows = [
      row('PKB'),
      row('ACCS 288', {printed_name: 'Nichido Stippling Brush #185'}),
      row('ACCS 288', {printed_name: 'Nichido Foundation Brush #193'}),
      row('ACCS 150', {printed_name: 'Nichido Eyebrow/Lash Brush with Comb #255'}),
      row('ACCS 600', {printed_name: 'Nichido Belt Bag'}),
      row('EBWC08'),
    ];
    expect([...printedOsRows(rows, 'v1', 4)]).toEqual([0, 1, 3, 4]);
  });
  it('Legacy page 4 reads accessories under their own codes', () => {
    expect([...printedOsRows([row('ACCS185'), row('ACCS193'), row('MUR')], 'legacy', 4)]).toEqual([0, 2]);
  });
});

describe('printed O/S on a read page', () => {
  it('stays as the BA filled it, drops the reader\'s O/S remark, and says it is printed', () => {
    const [a, b, c] = applyPageOutOfStock(
      [
        row('24HRMESGDE', {alt: 'O/S written in Delivery; Ending crossed out with a red X'}),
        row('LEL091', {alt: 'O/S in Drawer'}),
        row('EGLE', {alt: 'O/S in Drawer'}),
      ],
      {version: 'legacy', page: 3, layout: 'legacy-locations'},
    );
    expect(a).toMatchObject({os_printed: true, drawer: null, ending_on_hand: null, alt: 'Ending crossed out with a red X'});
    expect(a.oos).toBeUndefined();
    expect(b).toMatchObject({os_printed: true, alt: null, ending_on_hand: null});
    // Not a printed row: an O/S here is a BA's, read as 0.
    expect(c).toMatchObject({drawer: 0, ending_on_hand: 0, oos: {cells: ['drawer'], check: true}});
  });
  it('a count under a printed O/S stands, with no clash flag (store 2144 ACCS 150 #255)', () => {
    const [r] = applyPageOsFlags([row('ACCS 150', {printed_name: 'Nichido Eyebrow/Lash Brush with Comb #255', drawer: 4, selling_area: 7, ending_on_hand: 11})], [['os_drawer']], {version: 'v1', page: 4});
    expect(r).toMatchObject({drawer: 4, ending_on_hand: 11, os_printed: true});
    expect(r.oos).toBeUndefined();
  });
  it('template-read O/S flags still apply on rows the form doesn\'t print O/S on', () => {
    const [r] = applyPageOsFlags([row('EBWC08')], [['os_drawer']], {version: 'v1', page: 4});
    expect(r).toMatchObject({drawer: 0, oos: {cells: ['drawer'], check: true}});
  });
  it('markPrintedOs keeps other remarks', () => {
    expect(markPrintedOs(row('X', {alt: 'O/S written, no counts; BA note or revision on this row'})).alt).toBe('BA note or revision on this row');
  });
});
