import {describe, expect, it} from 'vitest';
import {clearableIds, flagsHubEnabled, groupByKind, hubKinds, hubView, kindKey, lineTitle, tierOf, visibleKinds} from '../src/goldline-flag-hub';
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

describe('kinds and groups', () => {
  const lines = [
    line({source: 'check', kind: 'zero_or_below', why: 'Count at 0 or below'}),
    line({source: 'check', kind: 'zero_or_below', why: 'Count at 0 or below'}),
    line({source: 'check', kind: 'row_math', why: 'Row doesn’t add up'}),
    line({kind: 'damage', why: 'Damage written'}),
    line({source: 'reviewer', kind: 'damage', why: 'Damage written'}),
  ];
  it('keys a kind by check or mark, so reader and reviewer marks of a kind share a chip', () => {
    expect(kindKey(lines[3])).toBe(kindKey(lines[4]));
    expect(kindKey(lines[0])).toBe('check:zero_or_below');
  });
  it('counts kinds most first, then by name', () => {
    expect(hubKinds(lines).map((k) => [k.label, k.count])).toEqual([
      ['Count at 0 or below', 2],
      ['Damage written', 2],
      ['Row doesn’t add up', 1],
    ]);
  });
  it('groups biggest first and keeps line order', () => {
    const g = groupByKind(lines);
    expect(g[0].lines).toEqual([lines[0], lines[1]]);
    expect(g.at(-1)?.label).toBe('Row doesn’t add up');
  });
});

describe('hubView', () => {
  const lines = [
    line({kind: 'price', why: 'Price written', uploadStatus: 'needs_review'}),
    line({source: 'check', kind: 'row_math', why: 'Row doesn’t add up'}),
    line({kind: 'note'}),
    line({kind: 'note', open: false}),
  ];
  it('splits into tiers with counts', () => {
    const v = hubView(lines, null);
    expect(v.counts).toEqual({needs: 1, open: 1, fyi: 1, cleared: 1});
    expect(v.fyi[0].lines).toHaveLength(1);
  });
  it('builds chips from open lines only', () => {
    expect(hubView(lines, null).kinds.find((k) => k.key === 'mark:note')?.count).toBe(1);
  });
  it('applies the chosen kind last, keeping every chip', () => {
    const v = hubView(lines, 'mark:note');
    expect(v.counts).toEqual({needs: 0, open: 0, fyi: 1, cleared: 1});
    expect(v.kinds).toHaveLength(3);
  });
});

describe('visibleKinds', () => {
  const kinds = Array.from({length: 9}, (_, i) => ({key: `k${i}`, label: `K${i}`, count: 9 - i}));
  it('shows the top six and counts the rest', () => {
    const v = visibleKinds(kinds, null);
    expect(v.shown).toHaveLength(6);
    expect(v.more).toBe(3);
  });
  it('keeps a chosen kind visible outside the top', () => {
    const v = visibleKinds(kinds, 'k8');
    expect(v.shown.at(-1)?.key).toBe('k8');
    expect(v.more).toBe(2);
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
