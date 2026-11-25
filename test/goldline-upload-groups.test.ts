import {describe, expect, it} from 'vitest';
import {distinctPages, groupUploads, pagesByStatus, uploadGroupKey, uploadSource, type GroupableUpload} from '../src/goldline-upload-groups';

const u = (filename: string, created_at: string, status = 'needs_review'): GroupableUpload => ({filename, created_at, status});

describe('uploadSource / uploadGroupKey', () => {
  it('strips the (page N of M) suffix for a split scan', () => {
    expect(uploadSource('Scan2026-10-30_171554 (page 10 of 98).pdf')).toBe('Scan2026-10-30_171554');
    expect(uploadSource('watsons.csv')).toBe('watsons.csv');
  });
  it('keys by source + upload day', () => {
    expect(uploadGroupKey(u('Scan_X (page 1 of 5).pdf', '2026-11-04T10:41:00Z'))).toBe('Scan_X|2026-11-04');
  });
});

describe('groupUploads', () => {
  it('collapses all pages of one drop into one group', () => {
    const groups = groupUploads(
      Array.from({length: 98}, (_, i) => u(`Scan2026-10-30_171554 (page ${i + 1} of 98).pdf`, '2026-11-04T10:40:00Z', i === 5 ? 'rejected' : 'needs_review')),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({source: 'Scan2026-10-30_171554', day: '2026-11-04', files: 98, pages: 98, isSplit: true});
    expect(groups[0].byStatus).toEqual({needs_review: 97, rejected: 1});
  });

  it('counts pages, not upload rows, and resolves each page to its best status', () => {
    // 98 distinct pages. Page 23 failed on every one of its 6 copies (a real issue). Page 57
    // failed twice but read on a retry (NOT an issue). The rest read fine on the first try.
    const rows: GroupableUpload[] = Array.from({length: 98}, (_, i) =>
      u(`Scan2026-10-30_171554 (page ${i + 1} of 98).pdf`, '2026-11-06T20:40:00Z', i === 22 ? 'failed' : 'needs_review'),
    );
    for (let k = 0; k < 5; k++) rows.push(u('Scan2026-10-30_171554 (page 23 of 98).pdf', '2026-11-06T20:49:00Z', 'failed'));
    for (let k = 0; k < 2; k++) rows.push(u('Scan2026-10-30_171554 (page 57 of 98).pdf', '2026-11-06T20:50:00Z', 'failed'));
    const [g] = groupUploads(rows);
    expect(g.files).toBe(105); // raw rows
    expect(g.pages).toBe(98); // distinct pages
    // Only page 23 is a true issue; page 57's good copy wins. byStatus sums to pages.
    expect(g.byStatus).toEqual({needs_review: 97, failed: 1});
    expect((g.byStatus.failed ?? 0) + (g.byStatus.rejected ?? 0)).toBe(1);
  });

  it('pagesByStatus collapses a page to its furthest-along outcome', () => {
    expect(
      pagesByStatus([
        u('S (page 1 of 2).pdf', '', 'failed'),
        u('S (page 1 of 2).pdf', '', 'committed'), // retry read + committed → page 1 is committed
        u('S (page 2 of 2).pdf', '', 'failed'),
        u('S (page 2 of 2).pdf', '', 'failed'), // every copy failed → page 2 is an issue
      ]),
    ).toEqual({committed: 1, failed: 1});
  });

  it('distinctPages dedupes re-uploaded pages and counts lone files as one each', () => {
    expect(
      distinctPages([
        'Scan_X (page 1 of 3).pdf',
        'Scan_X (page 1 of 3).pdf', // re-upload of page 1
        'Scan_X (page 2 of 3).pdf',
      ]),
    ).toBe(2);
    expect(distinctPages(['watsons.csv'])).toBe(1);
    expect(distinctPages([])).toBe(0);
  });

  it('same scan uploaded on two different days is two groups', () => {
    const groups = groupUploads([
      u('Scan_A (page 1 of 2).pdf', '2026-11-03T09:00:00Z'),
      u('Scan_A (page 2 of 2).pdf', '2026-11-03T09:00:05Z'),
      u('Scan_A (page 1 of 2).pdf', '2026-11-04T09:00:00Z'),
    ]);
    expect(groups.map((g) => g.day)).toEqual(['2026-11-04', '2026-11-03']); // newest first
  });

  it('a lone file (CSV) is its own group of one, not split', () => {
    const [g] = groupUploads([u('watsons-sept.csv', '2026-11-04T08:00:00Z', 'committed')]);
    expect(g).toMatchObject({source: 'watsons-sept.csv', files: 1, pages: 1, isSplit: false});
  });

  it('orders groups newest-upload first', () => {
    const groups = groupUploads([
      u('A (page 1 of 1).pdf', '2026-11-01T00:00:00Z'),
      u('B (page 1 of 1).pdf', '2026-11-05T00:00:00Z'),
    ]);
    expect(groups.map((g) => g.source)).toEqual(['B', 'A']);
  });
});

describe('groupUploads — per-batch tiles + duplicates', () => {
  const ub = (filename: string, created_at: string, batch_id: string, batch_name: string | null = null, status = 'needs_review'): GroupableUpload => ({
    filename,
    created_at,
    status,
    batch_id,
    batch_name,
  });

  it('uploadGroupKey uses the batch id when batched, else source + day', () => {
    expect(uploadGroupKey({filename: 'Scan_X (page 1 of 2).pdf', created_at: '2026-11-17T10:00:00Z', batch_id: 'b1'})).toBe('b|b1');
    expect(uploadGroupKey({filename: 'Scan_X (page 1 of 2).pdf', created_at: '2026-11-17T10:00:00Z'})).toBe('Scan_X|2026-11-17');
  });

  it('splits re-uploads of one scan on the same day into one tile per batch, newest first', () => {
    const groups = groupUploads([
      ub('Scan_X (page 1 of 2).pdf', '2026-11-17T10:00:00Z', 'b1', 'cost test 1'),
      ub('Scan_X (page 2 of 2).pdf', '2026-11-17T10:00:05Z', 'b1', 'cost test 1'),
      ub('Scan_X (page 1 of 2).pdf', '2026-11-17T12:00:00Z', 'b2', 'cost test 2'),
      ub('Scan_X (page 2 of 2).pdf', '2026-11-17T12:00:05Z', 'b2', 'cost test 2'),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({batchId: 'b2', name: 'cost test 2', pages: 2}); // newest first
    expect(groups[1]).toMatchObject({batchId: 'b1', name: 'cost test 1', pages: 2});
    // the earliest drop (b1) is canonical; the re-upload (b2) points at it
    expect(groups[1].duplicateOf).toBeNull();
    expect(groups[0].duplicateOf).toMatchObject({name: 'cost test 1', day: '2026-11-17'});
  });

  it('a single batched drop is one tile, not a duplicate', () => {
    const groups = groupUploads([
      ub('Scan_Y (page 1 of 2).pdf', '2026-11-18T10:00:00Z', 'b9', 'the only one'),
      ub('Scan_Y (page 2 of 2).pdf', '2026-11-18T10:00:05Z', 'b9', 'the only one'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({batchId: 'b9', duplicateOf: null, pages: 2});
  });

  it('legacy un-batched rows still group by source + day', () => {
    const groups = groupUploads([
      u('Scan_Z (page 1 of 2).pdf', '2026-11-10T09:00:00Z'),
      u('Scan_Z (page 2 of 2).pdf', '2026-11-10T09:00:05Z'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({batchId: null, duplicateOf: null, pages: 2});
  });
});

describe('pages that need a store (Nov 25)', () => {
  const at = '2026-11-24T09:53:00Z';
  const page = (n: number, status: string, needs_store = false) => ({filename: `Scan (page ${n} of 9).pdf`, created_at: at, status, batch_id: 'drop', needs_store});
  it('counts pages still to review with no store, once each', () => {
    const [g] = groupUploads([page(1, 'needs_review', true), page(2, 'needs_review', true), page(2, 'needs_review', true), page(3, 'needs_review'), page(4, 'committed')]);
    expect(g.needsStore).toBe(2);
    expect(g.byStatus).toMatchObject({needs_review: 3, committed: 1});
  });
  it('a page committed on a re-upload no longer needs a store', () => {
    const [g] = groupUploads([page(1, 'needs_review', true), {...page(1, 'committed'), batch_id: 'drop'}]);
    expect(g.needsStore).toBe(0);
  });
});
