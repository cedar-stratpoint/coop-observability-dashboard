import {describe, expect, it} from 'vitest';
import {DROP_TYPE_LABEL, distinctPages, dropMatchesType, dropTypeOf, groupUploads, pageNeed, pagesByStatus, storesFromForm, uploadGroupKey, uploadSource, type GroupableUpload} from '../src/goldline-upload-groups';

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

describe('what pages still need (Nov 25)', () => {
  const at = '2026-11-24T09:53:00Z';
  const page = (n: number, status: string, needs: 'store' | 'date' | null = null) => ({filename: `Scan (page ${n} of 9).pdf`, created_at: at, status, batch_id: 'drop', needs});
  it('counts pages to review that need a store or a date, once each', () => {
    const [g] = groupUploads([page(1, 'needs_review', 'store'), page(2, 'needs_review', 'store'), page(2, 'needs_review', 'store'), page(3, 'needs_review', 'date'), page(4, 'needs_review'), page(5, 'committed')]);
    expect(g).toMatchObject({needsStore: 2, needsDate: 1});
    expect(g.byStatus).toMatchObject({needs_review: 4, committed: 1});
  });
  it('a page committed on a re-upload needs nothing', () => {
    const [g] = groupUploads([page(1, 'needs_review', 'store'), page(1, 'committed')]);
    expect(g.needsStore).toBe(0);
  });
});

describe('pageNeed', () => {
  const known = ['473', '5300', '75', '2166'];
  const p = (o: Partial<Parameters<typeof pageNeed>[0]>) => pageNeed({status: 'needs_review', batchHasStore: false, readStore: '473', readStart: '2026-09-16', ...o}, known);
  it('in a store form, or not to review: nothing missing', () => {
    expect(p({batchHasStore: true})).toBeNull();
    expect(p({status: 'committed', readStore: null})).toBeNull();
  });
  it('a known store with a date can be filed, even with a misread year', () => {
    expect(p({})).toBeNull();
    expect(p({readStore: '75', readStart: '2016-09-01'})).toBeNull();
    expect(p({readStore: '5360'})).toBeNull(); // one digit off a registered store: corrected, as the board does
  });
  it('no registry store: needs a store; a store but no date: needs a date', () => {
    expect(p({readStore: null})).toBe('store');
    expect(p({readStore: 'Watsons 87'})).toBe('store');
    expect(p({readStore: '5300', readStart: null})).toBe('date');
  });
});

describe('drop type (Nov 26)', () => {
  const at = '2026-11-24T03:00:00Z';
  const up = (filename: string, kind: string, batch_id = 'b1'): GroupableUpload => ({filename, created_at: at, status: 'committed', batch_id, kind});
  it('collects the kinds in a drop, sorted and distinct', () => {
    const [g] = groupUploads([up('Scan (page 1 of 2).pdf', 'inventory_pdf'), up('Scan (page 2 of 2).pdf', 'inventory_pdf'), up('Sales.xlsx', 'pos_xlsx')]);
    expect(g.kinds).toEqual(['inventory_pdf', 'pos_xlsx']);
    expect(groupUploads([{filename: 'x.pdf', created_at: at, status: 'committed'}])[0].kinds).toEqual([]);
  });
  it('names a drop by its one kind, or Mixed for several', () => {
    expect(dropTypeOf(['inventory_pdf'])).toBe('inventory_pdf');
    expect(dropTypeOf(['pos_csv', 'pos_xlsx'])).toBe('mixed');
    expect(dropTypeOf([])).toBeNull();
    expect(dropTypeOf(['something_else'])).toBeNull();
    expect(DROP_TYPE_LABEL.inventory_pdf).toBe('Inventory form');
    expect(DROP_TYPE_LABEL.pos_xlsx).toBe('Watsons sales');
  });
  it('filters by type: a mixed drop shows under Mixed and under each of its kinds', () => {
    const mixed = ['inventory_pdf', 'pos_csv'];
    expect(dropMatchesType(mixed, 'all')).toBe(true);
    expect(dropMatchesType(mixed, 'mixed')).toBe(true);
    expect(dropMatchesType(mixed, 'pos_csv')).toBe(true);
    expect(dropMatchesType(mixed, 'pos_xlsx')).toBe(false);
    expect(dropMatchesType(['pos_xlsx'], 'mixed')).toBe(false);
  });
});

// Nov 26, prod: the Uploads tile said "13 pages need a store" while the scan board had filed 8 of
// them under the store their own form read. The tile now counts the same way.
describe('storesFromForm + pageNeed', () => {
  const STORES = [{code: '1334', name: 'ROBINSONS PLACE MALO'}, {code: '88', name: 'SM CITY SAN FERNANDO'}];
  const row = (batch: string, idx: number, page_no: number, readStore: string | null, status = 'needs_review') => ({
    id: `${batch}-${idx}`, filename: `Scan2026-11-20_115129 (page ${idx} of 30).pdf`, batch_id: batch, status,
    page_no, page_kind: 'inventory', form_version: 'v1', readStore, readName: null,
  });
  it('pages of a form with one sure code take it; the tile no longer says they need a store', () => {
    const rows = [row('b1', 13, 1, '1334'), row('b1', 14, 2, null), row('b1', 15, 3, null), row('b1', 25, 1, null), row('b1', 26, 2, null)];
    const filled = storesFromForm(rows, STORES);
    expect([...filled].filter(([, v]) => v.store).map(([k]) => k).sort()).toEqual(['b1-14', 'b1-15']);
    const need = (r: (typeof rows)[number]) => pageNeed({status: r.status, batchHasStore: false, readStore: r.readStore, readStart: '2026-10-16', storeFromForm: filled.get(r.id)?.store}, STORES);
    expect(rows.map(need)).toEqual([null, null, null, 'store', 'store']);
  });
  it('a re-upload of the same file is its own scan; committed or set-aside pages are left alone', () => {
    const rows = [row('b1', 13, 1, '1334'), row('b2', 14, 2, null), row('b1', 15, 2, null, 'committed')];
    expect(storesFromForm(rows, STORES).size).toBe(0);
  });
});

describe('storesFromForm: the period comes from the form too', () => {
  const STORES = [{code: '1334', name: 'ROBINSONS PLACE MALO'}];
  it('a page that read no period takes the one its form read, so it does not "need a date"', () => {
    const rows = [
      {id: 'a', filename: 'S (page 13 of 30).pdf', batch_id: 'b', status: 'needs_review', page_no: 1, page_kind: 'inventory', form_version: 'v1', readStore: '1334', readName: null, readStart: '2026-10-16'},
      {id: 'c', filename: 'S (page 14 of 30).pdf', batch_id: 'b', status: 'needs_review', page_no: 2, page_kind: 'inventory', form_version: 'v1', readStore: null, readName: null, readStart: null},
    ];
    const m = storesFromForm(rows, STORES);
    expect(m.get('c')).toEqual({store: true, periodStart: '2026-10-16'});
    expect(pageNeed({status: 'needs_review', batchHasStore: false, readStore: null, readStart: m.get('c')?.periodStart ?? null, storeFromForm: m.get('c')?.store}, STORES)).toBeNull();
  });
});
