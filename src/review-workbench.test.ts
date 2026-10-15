import {describe, expect, it} from 'vitest';
import {groupByFamily, pageTotal, reconcile, stepFlag, unresolvedFlags, type CatalogLite} from './review-workbench';

const cat: Record<string, CatalogLite> = {
  FBPP01: {productLine: 'Flawless Beauty Pressed Powder', unitPrice: 150},
  FBPP02: {productLine: 'Flawless Beauty Pressed Powder', unitPrice: 150},
  PKB: {productLine: 'Accessories', unitPrice: 238},
  PPF163: {productLine: 'Accessories', unitPrice: 32},
};
const row = (item_code: string, c: Partial<Record<'stockroom' | 'drawer' | 'selling_area' | 'delivery' | 'ending_on_hand', number | null>> = {}) => ({
  item_code,
  stockroom: null,
  drawer: null,
  selling_area: null,
  delivery: null,
  ending_on_hand: null,
  ...c,
});

describe('groupByFamily', () => {
  it('groups consecutive rows by family, with a shared price only when uniform', () => {
    const g = groupByFamily([row('FBPP01'), row('FBPP02'), row('PKB'), row('PPF163'), row('ZZZ')], cat);
    expect(g.map((x) => [x.family, x.price, x.items.length])).toEqual([
      ['Flawless Beauty Pressed Powder', 150, 2],
      ['Accessories', null, 2],
      ['Other items', null, 1],
    ]);
  });
});

describe('pageTotal', () => {
  it('sums on hand × price for counted, priced rows', () => {
    const t = pageTotal([row('FBPP01', {stockroom: 10, selling_area: 6}), row('PKB', {ending_on_hand: 2}), row('FBPP02'), row('ZZZ', {drawer: 3})], cat);
    expect(t).toEqual({total: 16 * 150 + 2 * 238, priced: 2, unpriced: 1});
  });
});

describe('reconcile', () => {
  it('is none until a total is written, match within ₱1, else off', () => {
    expect(reconcile(2876, '')).toEqual({state: 'none', diff: 0});
    expect(reconcile(2876, '₱2,876')).toEqual({state: 'match', diff: 0});
    expect(reconcile(2876.4, '2876')).toMatchObject({state: 'match'});
    expect(reconcile(2876, '2,700')).toEqual({state: 'off', diff: 176});
    expect(reconcile(2876, 'abc').state).toBe('none');
  });
});

describe('flags', () => {
  it('tracks unresolved flags and steps with wrap-around', () => {
    expect(unresolvedFlags([1, 4, 9], new Set([4]))).toEqual([1, 9]);
    expect(stepFlag([1, 9], null, 1)).toBe(1);
    expect(stepFlag([1, 9], 1, 1)).toBe(9);
    expect(stepFlag([1, 9], 9, 1)).toBe(1);
    expect(stepFlag([1, 9], 1, -1)).toBe(9);
    expect(stepFlag([], null, 1)).toBeNull();
  });
});
