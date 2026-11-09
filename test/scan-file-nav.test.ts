import {describe, expect, it} from 'vitest';
import {fileListParams, fileNeighbours, fileReviewQuery, groupFiles, parseFileFilter, type NavFile} from '../src/scan-file-nav';

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
