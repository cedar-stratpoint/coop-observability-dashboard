import {describe, expect, it} from 'vitest';
import {fileListParams, fileNeighbours, fileReviewQuery, groupFiles, parseFileFilter, type NavFile, facetCounts, matchesFilter} from '../src/scan-file-nav';

const f = (id: string, n: number, status: string, extra: Partial<NavFile> = {}): NavFile => ({
  id,
  filename: `Scan2026-10-30_171554 (page ${n} of 98).pdf`,
  status,
  created_at: '2026-11-01T00:00:00Z',
  page_kind: 'inventory',
  form_version: 'v1',
  ...extra,
});

describe('scan file nav', () => {
  const files = [
    f('p3', 3, 'needs_review'),
    f('p1', 1, 'needs_review'),
    f('p2-old', 2, 'failed', {created_at: '2026-11-01T00:00:00Z'}),
    f('p2', 2, 'needs_review', {created_at: '2026-11-02T00:00:00Z'}),
    f('p4', 4, 'rejected', {page_kind: 'blank', form_version: 'unknown'}),
    f('p5', 5, 'committed', {form_version: 'v2'}),
  ];

  it('orders by scan page and keeps the best attempt per page', () => {
    const g = groupFiles(files);
    expect(g.map((x) => x.best.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    expect(g[1].others.map((x) => x.id)).toEqual(['p2-old']);
  });

  it('steps through the unfiltered list, with no arrow past either end', () => {
    const all = parseFileFilter({});
    expect(fileNeighbours(files, all, 'p1')).toMatchObject({prev: null, next: {id: 'p2'}});
    expect(fileNeighbours(files, all, 'p3')).toMatchObject({prev: {id: 'p2'}, next: {id: 'p4'}});
    expect(fileNeighbours(files, all, 'p5')).toMatchObject({prev: {id: 'p4'}, next: null});
  });

  it('follows the same facets as the list (Inventory + V1 skips the blank and the V2 page)', () => {
    const filter = parseFileFilter({type: 'inventory', fv: 'v1'});
    expect(fileNeighbours(files, filter, 'p3')).toMatchObject({prev: {id: 'p2'}, next: null});
  });

  it('Status "Needs review" skips committed and set-aside pages', () => {
    const filter = parseFileFilter({status: 'needs_review'});
    expect(fileNeighbours(files, filter, 'p1')).toMatchObject({prev: null, next: {id: 'p2'}});
    expect(fileNeighbours(files, filter, 'p3')).toMatchObject({prev: {id: 'p2'}, next: null});
  });

  it('a page outside the filter (an older attempt, or one just committed) steps to its nearest listed neighbours', () => {
    const all = parseFileFilter({});
    expect(fileNeighbours(files, all, 'p2-old')).toMatchObject({prev: {id: 'p1'}, next: {id: 'p3'}});
    const toReview = parseFileFilter({status: 'needs_review'});
    expect(fileNeighbours(files, toReview, 'p5')).toMatchObject({prev: {id: 'p3'}, next: null});
  });

  it('ignores unknown filter values and carries the filters into the review link and Back', () => {
    expect(parseFileFilter({type: 'nope', status: 'x', fv: 'v9'})).toEqual({type: 'all', status: 'all', fv: 'all'});
    const filter = parseFileFilter({type: 'inventory', status: 'needs_review', fv: 'v1'});
    expect(fileReviewQuery(filter, 'v1')).toBe('from=file&type=inventory&status=needs_review&fv=v1&version=v1');
    expect(fileReviewQuery(parseFileFilter({}), null)).toBe('from=file');
    expect(fileListParams(filter, null).toString()).toBe('view=file&type=inventory&status=needs_review&fv=v1');
  });
});

describe('facetCounts', () => {
  // The 98-page scan from the report: 70 forms to review (10 Legacy, 30 V1, 30 V2), 14 sales, 14 blank.
  const mk = (n: number, page_kind: string, status: string, form_version: string | null = null) => Array.from({length: n}, () => ({page_kind, status, form_version}));
  const pages = [...mk(10, 'inventory', 'needs_review', 'legacy'), ...mk(30, 'inventory', 'needs_review', 'v1'), ...mk(30, 'inventory', 'needs_review', 'v2'), ...mk(14, 'sales', 'rejected'), ...mk(14, 'blank', 'rejected')];
  const f = (o: object) => ({type: 'all', status: 'all', fv: 'all', ...o}) as Parameters<typeof facetCounts>[1];

  it('counts the whole scan with no filter on', () => {
    const c = facetCounts(pages, f({}));
    expect(c.type).toEqual({all: 98, inventory: 70, sales: 14, blank: 14});
    expect([c.status.all, c.status.needs_review, c.status.rejected]).toEqual([98, 70, 28]);
    expect(c.fv).toEqual({all: 98, legacy: 10, v1: 30, v2: 30});
  });
  it('shows 0 blank pages while Status is Needs review', () => {
    expect(facetCounts(pages, f({status: 'needs_review'})).type).toEqual({all: 70, inventory: 70, sales: 0, blank: 0});
  });
  it('shows Needs review 0 and Set aside 14 while Type is Blank page', () => {
    const c = facetCounts(pages, f({type: 'blank'}));
    expect([c.status.all, c.status.needs_review, c.status.rejected]).toEqual([14, 0, 14]);
    expect(c.fv).toEqual({all: 14, legacy: 0, v1: 0, v2: 0});
  });
  it("makes the chosen chip's number the length of the list", () => {
    for (const filter of [f({status: 'needs_review', fv: 'v1'}), f({type: 'blank', status: 'needs_review'}), f({type: 'inventory', fv: 'legacy'})]) {
      const len = pages.filter((p) => matchesFilter(p, filter)).length;
      const c = facetCounts(pages, filter);
      expect([c.type[filter.type], c.status[filter.status], c.fv[filter.fv]]).toEqual([len, len, len]);
    }
  });
});
