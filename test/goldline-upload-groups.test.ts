import {describe, expect, it} from 'vitest';
import {groupUploads, uploadGroupKey, uploadSource, type GroupableUpload} from '../src/goldline-upload-groups';

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
    expect(groups[0]).toMatchObject({source: 'Scan2026-10-30_171554', day: '2026-11-04', files: 98, isSplit: true});
    expect(groups[0].byStatus).toEqual({needs_review: 97, rejected: 1});
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
    expect(g).toMatchObject({source: 'watsons-sept.csv', files: 1, isSplit: false});
  });

  it('orders groups newest-upload first', () => {
    const groups = groupUploads([
      u('A (page 1 of 1).pdf', '2026-11-01T00:00:00Z'),
      u('B (page 1 of 1).pdf', '2026-11-05T00:00:00Z'),
    ]);
    expect(groups.map((g) => g.source)).toEqual(['B', 'A']);
  });
});
