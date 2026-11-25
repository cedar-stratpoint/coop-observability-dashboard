import {describe, expect, it} from 'vitest';
import {applyOutOfStock, applyOutOfStockNote, cleanOsFlags, osFromNote, osNeedsLook, stampOutOfStock, type OutOfStock} from '../src/out-of-stock';

const row = (p: Partial<Record<'stockroom' | 'drawer' | 'selling_area' | 'delivery' | 'ending_on_hand', number | null>> & {alt?: string | null} = {}) => ({
  stockroom: null, drawer: null, selling_area: null, delivery: null, ending_on_hand: null, confidence: 0.9, alt: null as string | null, oos: undefined as OutOfStock | null | undefined, ...p,
});

// Notes as the reader wrote them on the Oct scan (staging and prod, Nov 23 to 25).
describe('osFromNote', () => {
  it.each([
    ['O/S written in Delivery', 'legacy-locations', ['drawer'], false],
    ['O/S written in the Delivery column, Ending is 0; BA note or revision on this row', 'legacy-locations', ['drawer'], false],
    ['O/S written under Delivery; BA note or revision on this row', 'legacy-locations', ['drawer'], false],
    ['off_manifest: printed code not in reference list; name Double Espresso; delivery cell O/S; ending cell crossed out with red X', 'legacy-locations', ['drawer'], false],
    ['O/S written in Delivery', 'legacy-printed', ['delivery'], false],
    ['O/S in Drawer', 'v1', ['drawer'], false],
    ['O/S written in Beginning + Delivery', 'legacy-locations', ['selling_area'], false],
    ['O/S written, no counts', 'legacy-locations', [], true],
    ['O/S written, no counts; red X in Ending; BA note or revision on this row', 'legacy-locations', [], true],
    ['O/S; off_manifest: printed row not in reference list, printed name Double Espresso', 'legacy-locations', [], true],
  ] as const)('%s (%s)', (alt, layout, cells, isRow) => {
    expect(osFromNote(alt, layout)).toEqual({cells, row: isRow});
  });
  it('no O/S, no answer; "OS" inside a word is not O/S', () => {
    expect(osFromNote('Ending could be 5', 'v1')).toBeNull();
    expect(osFromNote(null, 'v1')).toBeNull();
    expect(osFromNote('POS sales', 'v1')).toBeNull();
  });
});

describe('applyOutOfStock', () => {
  it('a row with only O/S ends at 0 and goes to review', () => {
    const r = applyOutOfStockNote(row({alt: 'O/S written, no counts'}), 'legacy-locations');
    expect(r).toMatchObject({ending_on_hand: 0, oos: {cells: ['ending_on_hand'], check: true}});
    expect(osNeedsLook(r)).toBe(true);
  });
  it('O/S in one cell makes that cell 0; the other counts stand', () => {
    const r = applyOutOfStockNote(row({stockroom: 5, ending_on_hand: 5, alt: 'O/S written in Delivery'}), 'legacy-locations');
    expect(r).toMatchObject({stockroom: 5, drawer: 0, ending_on_hand: 5, oos: {cells: ['drawer'], check: false}});
  });
  it('O/S in one cell of an otherwise empty row: that cell 0, the row ends at 0', () => {
    const r = applyOutOfStockNote(row({alt: 'O/S written in Delivery'}), 'legacy-locations');
    expect(r).toMatchObject({drawer: 0, ending_on_hand: 0, oos: {cells: ['drawer'], check: true}});
  });
  it('O/S and a number in the same cell: the number wins and the row is flagged', () => {
    const r = applyOutOfStockNote(row({drawer: 3, ending_on_hand: 3, alt: 'O/S written in Delivery'}), 'legacy-locations');
    expect(r).toMatchObject({drawer: 3, oos: {cells: [], check: true}});
    expect(r.alt).toBe('O/S written in Delivery; O/S and a number both written in drawer; the number is kept');
  });
  it('a bare O/S note on a counted row changes nothing', () => {
    const r = applyOutOfStockNote(row({stockroom: 2, ending_on_hand: 2, alt: 'O/S'}), 'v1');
    expect(r.oos).toBeUndefined();
    expect(r.ending_on_hand).toBe(2);
  });
  it('template-read flags name the cell', () => {
    expect(cleanOsFlags(['note', 'os_drawer', 'os_drawer', 'bogus'])).toEqual(['drawer']);
    expect(cleanOsFlags(null)).toEqual([]);
    expect(applyOutOfStock(row(), {cells: cleanOsFlags(['os_ending']), row: false})).toMatchObject({ending_on_hand: 0, oos: {cells: ['ending_on_hand'], check: true}});
  });
});

describe('stampOutOfStock', () => {
  const read = [{item_code: 'A', oos: {cells: ['drawer' as const], check: false}}, {item_code: 'B'}];
  it('keeps "written as O/S" while the cell is still 0', () => {
    const out = stampOutOfStock([{item_code: 'A', drawer: 0, extra: {deducted_pcs: 1}}, {item_code: 'B', drawer: 0}], read);
    expect(out[0].extra).toEqual({deducted_pcs: 1, out_of_stock: 1});
    expect(out[1].extra).toBeUndefined();
  });
  it('drops it when the reviewer typed a count over the O/S', () => {
    expect(stampOutOfStock([{item_code: 'A', drawer: 4} as {item_code: string; drawer: number; extra?: Record<string, number | null>}], read)[0].extra).toBeUndefined();
  });
});
