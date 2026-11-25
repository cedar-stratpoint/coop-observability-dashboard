import {describe, it, expect} from 'vitest';
import {COLS, colsForVersion} from './review-grid-cols';

// The review grid's count columns must render in each form version's printed left-to-right
// order so the grid mirrors the scanned paper. Display only: the column SET never changes,
// only its order (cells stay keyed by field).

describe('colsForVersion (review grid column order)', () => {
  const keys = (v: string | null | undefined) => colsForVersion(v).map((c) => c.key);

  it('leads with Delivery for V2 (Delivery is the first count column on the V2 paper)', () => {
    expect(keys('v2')).toEqual(['delivery', 'stockroom', 'drawer', 'selling_area', 'ending_on_hand']);
  });

  it('keeps the default order for V1 (already matches the paper)', () => {
    expect(keys('v1')).toEqual(COLS.map((c) => c.key));
  });

  it('keeps the default order for Legacy and unknown/missing versions', () => {
    for (const v of ['legacy', 'unknown', null, undefined, '']) {
      expect(keys(v)).toEqual(COLS.map((c) => c.key));
    }
  });

  it('never adds or drops a column, only reorders', () => {
    for (const v of ['v1', 'v2', 'legacy', null]) {
      expect([...colsForVersion(v)].map((c) => c.key).sort()).toEqual(COLS.map((c) => c.key).sort());
    }
  });
});
