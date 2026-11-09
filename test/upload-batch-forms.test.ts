import {describe, expect, it} from 'vitest';
import {batchReadiness, groupForms, nominateKeeper, scanOrder, scanPosition, scanPageLabel, storeConflict, type BatchPageInfo, type SheetCopy} from '../src/upload-batch';

describe('scanPageLabel', () => {
  it('labels a split sheet by its scan position, not a form page', () => {
    expect(scanPageLabel('Scan2026-10-30_171554 (page 50 of 98).pdf').title).toBe('Sheet 50 of 98');
    expect(scanPageLabel('whole-form.pdf')).toEqual({title: 'whole-form.pdf', sub: null, index: 0});
  });
});

describe('nominateKeeper', () => {
  const c = (id: string, docConfidence: number | null, flagged: number, rows: number): SheetCopy => ({id, docConfidence, flagged, rows});
  it('returns null with no copies', () => {
    expect(nominateKeeper([])).toBeNull();
  });
  it('keeps the highest document confidence', () => {
    expect(nominateKeeper([c('a', 0.7, 0, 20), c('b', 0.95, 2, 20), c('c', 0.8, 0, 20)])).toBe('b');
  });
  it('breaks a confidence tie by fewest flagged rows', () => {
    expect(nominateKeeper([c('a', 0.9, 5, 20), c('b', 0.9, 1, 20)])).toBe('b');
  });
  it('then prefers the copy with more rows read', () => {
    expect(nominateKeeper([c('a', 0.9, 1, 12), c('b', 0.9, 1, 20)])).toBe('b');
  });
  it('treats a missing confidence as worst, and stays stable by id on a full tie', () => {
    expect(nominateKeeper([c('b', null, 1, 20), c('a', null, 1, 20)])).toBe('a');
    expect(nominateKeeper([c('x', null, 0, 20), c('y', 0.5, 0, 20)])).toBe('y');
  });
});

describe('scanPosition', () => {
  it('reads where a split page sat in its scan', () => {
    expect(scanPosition('stack (page 7 of 25).pdf')).toEqual({source: 'stack', index: 7});
    expect(scanPosition('1.pdf')).toBeNull();
  });
});

describe('scanOrder', () => {
  it('orders split pages by position, separate files by upload time', () => {
    const pages = [
      {filename: 'stack (page 2 of 3).pdf', created_at: '2026-10-30T01:00:05Z'},
      {filename: 'stack (page 1 of 3).pdf', created_at: '2026-10-30T01:00:06Z'},
      {filename: 'later.pdf', created_at: '2026-10-30T02:00:00Z'},
      {filename: 'stack (page 3 of 3).pdf', created_at: '2026-10-30T01:00:01Z'},
    ];
    expect(scanOrder(pages).map((p) => p.filename)).toEqual(['stack (page 1 of 3).pdf', 'stack (page 2 of 3).pdf', 'stack (page 3 of 3).pdf', 'later.pdf']);
  });
});

describe('groupForms', () => {
  const pages = (...n: Array<number | null>) => n.map((page, i) => ({id: i, page}));
  it('starts a new form whenever the page number drops', () => {
    expect(groupForms(pages(1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2)).map((f) => f.map((p) => p.page))).toEqual([
      [1, 2, 3, 4, 5],
      [1, 2, 3, 4, 5],
      [1, 2],
    ]);
  });
  it('keeps unnumbered pages with their form, and one form stays one', () => {
    expect(groupForms(pages(1, null, 3, 4, 5)).length).toBe(1);
    expect(groupForms(pages(1, 2, null, 1)).map((f) => f.length)).toEqual([3, 1]);
  });
  it('keeps a page scanned twice in its form (the review asks to remove the copy)', () => {
    expect(groupForms(pages(1, 2, 2, 3)).length).toBe(1);
  });
});

describe('storeConflict', () => {
  it('is no conflict when stores agree or are unread', () => {
    expect(storeConflict([{detectedStore: '473'}, {detectedStore: '473'}, {detectedStore: null}]).conflict).toBe(false);
    expect(storeConflict([{detectedStore: null}, {detectedStore: undefined}]).conflict).toBe(false);
  });
  it('flags a genuine second store and lists both', () => {
    const r = storeConflict([{detectedStore: '473'}, {detectedStore: '5300'}, {detectedStore: '473'}]);
    expect(r.conflict).toBe(true);
    expect(r.stores).toEqual(['473', '5300']);
  });
});

describe('batchReadiness store-change guard', () => {
  const info = (p: Partial<BatchPageInfo>): BatchPageInfo => ({uploadId: 'u', page: 1, flagged: 0, resolved: 0, status: 'needs_review', ...p});
  it('blocks commit when pages read different stores', () => {
    const r = batchReadiness({
      storeCode: '473', periodStart: '2026-09-01', periodEnd: '2026-09-15',
      pages: [info({uploadId: 'a', page: 1, detectedStore: '473'}), info({uploadId: 'b', page: 2, detectedStore: '5300'})],
    });
    expect(r.ready).toBe(false);
    if (!r.ready) expect(r.reason).toMatch(/different stores/);
  });
  it('is ready when stores agree and everything else passes', () => {
    const r = batchReadiness({
      storeCode: '473', periodStart: '2026-09-01', periodEnd: '2026-09-15',
      pages: [info({uploadId: 'a', page: 1, detectedStore: '473'}), info({uploadId: 'b', page: 2, detectedStore: '473'})],
    });
    expect(r.ready).toBe(true);
  });
});
