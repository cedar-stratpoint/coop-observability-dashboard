import {describe, expect, it} from 'vitest';
import {dropOf, familyOf} from '../src/upload-drops';
import {groupUploads} from '../src/goldline-upload-groups';

const links = [{id: 'A', parent_batch_id: null}, {id: 'B', parent_batch_id: 'A'}, {id: 'C', parent_batch_id: 'A'}, {id: 'D', parent_batch_id: 'B'}, {id: 'X', parent_batch_id: null}];

describe('upload drops', () => {
  it('finds the original upload of every split-off batch', () => {
    expect(Object.fromEntries(dropOf(links))).toEqual({A: 'A', B: 'A', C: 'A', D: 'A', X: 'X'});
    expect(familyOf(links, 'C').sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(familyOf(links, 'X')).toEqual(['X']);
    expect(familyOf(links, 'unknown')).toEqual(['unknown']);
  });
  it('survives a loop in the links', () => {
    expect(dropOf([{id: 'P', parent_batch_id: 'Q'}, {id: 'Q', parent_batch_id: 'P'}]).size).toBe(2);
  });
  it('shows one tile per upload with the pages of every split-off group', () => {
    const f = (n: number, batch_id: string, status = 'needs_review') => ({filename: `Scan1 (page ${n} of 4).pdf`, created_at: '2026-11-24T01:53:00Z', status, batch_name: 'Nov 24 Test Run', batch_id, drop_id: 'A'});
    const groups = groupUploads([f(1, 'A'), f(2, 'B'), f(3, 'C', 'rejected'), f(4, 'D')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({batchId: 'A', pages: 4, byStatus: {needs_review: 3, rejected: 1}, duplicateOf: null});
  });
});
