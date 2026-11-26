import {describe, expect, it} from 'vitest';
import {CLEARED_TILE, clearableIds, flagsHubEnabled, hubTiles, isTileKey, kindKey, lineTitle, pageOf, tierOf, tileKeyOf, tileLines} from '../src/goldline-flag-hub';
import type {FlagLine} from '../src/goldline-flag-lines';

let n = 0;
const line = (p: Partial<FlagLine>): FlagLine => ({
  key: `k${++n}`,
  source: 'reader',
  why: 'Note or revision',
  note: null,
  open: true,
  storeCode: '473',
  storeName: 'SM CITY-SAN PABLO 1',
  ba: null,
  month: '2026-10',
  itemCode: null,
  product: null,
  uploadId: 'u1',
  file: 'Oct scan',
  page: 23,
  pageOf: 98,
  createdAt: '2026-11-25T00:00:00Z',
  id: `id${n}`,
  kind: 'note',
  uploadStatus: 'committed',
  ...p,
});

describe('flagsHubEnabled', () => {
  it('is on only for exactly 1', () => {
    expect(flagsHubEnabled({GOLDLINE_FLAGS_HUB: '1'})).toBe(true);
    expect(flagsHubEnabled({GOLDLINE_FLAGS_HUB: 'true'})).toBe(false);
    expect(flagsHubEnabled({})).toBe(false);
  });
});

describe('tierOf', () => {
  it('puts closed lines in cleared, checks included', () => {
    expect(tierOf(line({open: false}))).toBe('cleared');
    expect(tierOf(line({source: 'check', kind: 'row_math', open: false}))).toBe('cleared');
  });
  it('never puts a check anywhere but open while open, even on a page in review', () => {
    expect(tierOf(line({source: 'check', kind: 'unreadable', uploadStatus: 'needs_review'}))).toBe('open');
  });
  it('puts notes, columns changed and written-in products in fyi', () => {
    for (const kind of ['note', 'column_changed', 'added_row']) expect(tierOf(line({kind, uploadStatus: 'needs_review'}))).toBe('fyi');
  });
  it('blocks on an unanswered price or an unreadable cell only while the page is in review', () => {
    expect(tierOf(line({kind: 'price', uploadStatus: 'needs_review'}))).toBe('needs');
    expect(tierOf(line({source: 'reviewer', kind: 'illegible', uploadStatus: 'needs_review'}))).toBe('needs');
    expect(tierOf(line({kind: 'price', uploadStatus: 'committed'}))).toBe('open');
    expect(tierOf(line({source: 'reviewer', kind: 'damage', uploadStatus: 'needs_review'}))).toBe('open');
  });
});

describe('tiles', () => {
  const lines = [
    line({source: 'check', kind: 'zero_or_below', why: 'Count at 0 or below', storeCode: '473', uploadId: 'a'}),
    line({source: 'check', kind: 'zero_or_below', why: 'Count at 0 or below', storeCode: '5300', uploadId: 'b'}),
    line({source: 'check', kind: 'row_math', why: 'Row doesn’t add up', uploadId: 'a'}),
    line({kind: 'damage', why: 'Damage written'}),
    line({source: 'reviewer', kind: 'damage', why: 'Damage written'}),
    line({kind: 'price', why: 'Price written', uploadStatus: 'needs_review'}),
    line({kind: 'price', why: 'Price written', uploadStatus: 'committed'}),
    line({kind: 'note', open: false}),
    line({source: 'check', kind: 'row_math', open: false}),
  ];
  const tiles = hubTiles(lines);
  it('keys a kind by check or mark, so reader and reviewer marks of a kind share a tile', () => {
    expect(kindKey(lines[3])).toBe(kindKey(lines[4]));
    expect(tileKeyOf(lines[0])).toBe('open.check:zero_or_below');
  });
  it('makes one tile per kind within its tier, biggest first, with stores and pages', () => {
    expect(tiles.open.map((t) => [t.label, t.count])).toEqual([
      ['Count at 0 or below', 2],
      ['Damage written', 2],
      ['Price written', 1],
      ['Row doesn’t add up', 1],
    ]);
    expect(tiles.open[0]).toMatchObject({stores: 2, pages: 2});
  });
  it('splits one kind across tiers: an unanswered price on a page in review needs you', () => {
    expect(tiles.needs).toEqual([expect.objectContaining({key: 'needs.mark:price', count: 1})]);
  });
  it('puts every closed line in one Cleared tile', () => {
    expect(tiles.cleared).toEqual([expect.objectContaining({key: CLEARED_TILE, count: 2, kind: null})]);
    expect(tileLines(lines, CLEARED_TILE)).toHaveLength(2);
  });
  it('accepts only tile keys it can make', () => {
    expect(isTileKey('needs.mark:price')).toBe(true);
    expect(isTileKey(CLEARED_TILE)).toBe(true);
    expect(isTileKey('cleared.mark:note')).toBe(false);
    expect(isTileKey('open.mark:<x>')).toBe(false);
    expect(isTileKey(null)).toBe(false);
  });
});

describe('pageOf', () => {
  const rows = Array.from({length: 53}, (_, i) => i);
  it('pages 25 at a time with a 1-based range', () => {
    expect(pageOf(rows, 3)).toMatchObject({rows: [50, 51, 52], page: 3, pageCount: 3, from: 51, to: 53});
  });
  it('clamps a page out of range and copes with none', () => {
    expect(pageOf(rows, 9).page).toBe(3);
    expect(pageOf(rows, 0).page).toBe(1);
    expect(pageOf([], 1)).toMatchObject({rows: [], page: 1, pageCount: 1, from: 0, to: 0});
  });
});

describe('clearableIds and lineTitle', () => {
  it('never offers to clear a check or a closed mark', () => {
    const a = line({id: 'a'});
    expect(clearableIds([a, line({source: 'check', id: 'b'}), line({open: false, id: 'c'})])).toEqual(['a']);
  });
  it('titles by store and page, with a plain fallback', () => {
    expect(lineTitle(line({}))).toBe('SM CITY-SAN PABLO 1 · Page 23 of 98');
    expect(lineTitle(line({storeName: null, storeCode: null, page: null}))).toBe('Store not known yet');
  });
});
