import {describe, expect, it} from 'vitest';
import {buildReferenceText, buildWriterNotes, diffUpload, digitConfusions, pickReference, type Correction} from './goldline-writer';

describe('diffUpload', () => {
  it('counts confirmed handwritten cells and the ones the reviewer changed', () => {
    const reader = [
      {item_code: 'A', stockroom: 47, drawer: 52, selling_area: 33, ending_on_hand: 162},
      {item_code: 'B', stockroom: 3, drawer: null},
    ];
    const confirmed = [
      {item_code: 'A', stockroom: 47, drawer: 82, selling_area: 33, delivery: null, ending_on_hand: 162},
      {item_code: 'B', stockroom: 3, drawer: null, selling_area: null, delivery: null, ending_on_hand: null},
      {item_code: 'C', stockroom: 9}, // not in the reader output (overwritten later): skipped
    ];
    const d = diffUpload('u1', reader, confirmed);
    expect(d.cells).toBe(5);
    expect(d.corrections).toEqual([{uploadId: 'u1', itemCode: 'A', column: 'drawer', read: 52, confirmed: 82}]);
  });
  it('treats a missed value and a phantom value as corrections', () => {
    const d = diffUpload('u', [{item_code: 'A', stockroom: null, drawer: 4}], [{item_code: 'A', stockroom: 6, drawer: null}]);
    expect(d.cells).toBe(2); // the phantom value is in the denominator too
    expect(d.corrections.map((c) => c.column)).toEqual(['stockroom', 'drawer']);
  });
});

const c = (read: number | null, confirmed: number | null): Correction => ({uploadId: 'u', itemCode: 'X', column: 'drawer', read, confirmed});

describe('digitConfusions', () => {
  it('aligns same-length numbers digit by digit', () => {
    const r = digitConfusions([c(52, 82), c(5, 8), c(17, 11), c(null, 3), c(4, null), c(1, 11), c(15, 51)]);
    expect(r.pairs.get('5>8')).toBe(2);
    expect(r.pairs.get('7>1')).toBe(1);
    expect(r.missed).toBe(1);
    expect(r.blanksRead).toBe(1);
    expect(r.lengthChanges).toBe(2); // 1 vs 11, and the 15/51 swap (not a digit confusion)
    expect(r.pairs.get('1>5')).toBeUndefined();
  });
});

describe('buildWriterNotes', () => {
  it('is null until something was corrected', () => {
    expect(buildWriterNotes([], {pages: 5, cells: 210, corrected: 0})).toBeNull();
  });
  it('names the confusion, most frequent first, with recent examples', () => {
    const n = buildWriterNotes([c(52, 82), c(5, 8), c(17, 11)], {pages: 5, cells: 210, corrected: 3}) as string;
    expect(n).toContain('5 page(s)');
    expect(n.indexOf("writer's 8 was misread as 5 (twice)")).toBeLessThan(n.indexOf("writer's 1 was misread as 7"));
    expect(n).toContain('X drawer: read 52, written 82');
  });
});

describe('pickReference', () => {
  const cands = [
    {uploadId: 'old-s1', storeCode: 'S1', createdAt: '2026-10-01', cells: 40},
    {uploadId: 'new-s2', storeCode: 'S2', createdAt: '2026-10-09', cells: 30},
    {uploadId: 'blank', storeCode: 'S1', createdAt: '2026-10-10', cells: 2},
  ];
  it('prefers the same store, newest well-filled page', () => expect(pickReference(cands, 'S1')?.uploadId).toBe('old-s1'));
  it('falls back to any store (one writer in Phase 1)', () => {
    expect(pickReference(cands, 'S9')?.uploadId).toBe('new-s2');
    expect(pickReference(cands, null)?.uploadId).toBe('new-s2');
  });
  it('skips near-blank pages', () => expect(pickReference([cands[2]], 'S1')).toBeNull());
});

describe('buildReferenceText', () => {
  it('lists only filled rows with the column order spelled out', () => {
    const t = buildReferenceText(2, [
      {item_code: 'MPMLSCB03', stockroom: 47, drawer: 82, selling_area: 33, delivery: null, ending_on_hand: 162},
      {item_code: 'EMPTY', stockroom: null},
    ]);
    expect(t).toContain('PAGE 2');
    expect(t).toContain('MPMLSCB03 47/82/33/_/162');
    expect(t).not.toContain('EMPTY');
    expect(t).toContain('Do NOT copy');
  });
});
