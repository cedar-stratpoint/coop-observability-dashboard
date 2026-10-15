import {describe, expect, it} from 'vitest';
import {batchCoverage, batchReadiness, orderPages, splitName, type BatchPageInfo} from './upload-batch';

const page = (n: number | null, extra: Partial<BatchPageInfo> = {}): BatchPageInfo => ({
  uploadId: `u${n}`,
  page: n,
  flagged: 0,
  resolved: 0,
  status: 'needs_review',
  ...extra,
});

describe('orderPages / batchCoverage', () => {
  it('orders by form page and reports missing + duplicate pages', () => {
    const pages = [page(3), page(1), page(null), page(3), page(5)];
    expect(orderPages(pages).map((p) => p.page)).toEqual([1, 3, 3, 5, null]);
    expect(batchCoverage(pages)).toEqual({have: [1, 3, 5], missing: [2, 4], duplicates: [3]});
  });
});

describe('batchReadiness', () => {
  const ok = {storeCode: '1', periodStart: '2026-10-01', periodEnd: '2026-10-15'};
  it('is ready with store, period, no duplicates and every flag resolved', () => {
    expect(batchReadiness({...ok, pages: [page(1, {flagged: 2, resolved: 2}), page(2)]})).toEqual({ready: true});
  });
  it('explains the single most useful blocker', () => {
    expect(batchReadiness({...ok, pages: []})).toMatchObject({ready: false, reason: /No pages/});
    expect(batchReadiness({...ok, pages: [page(1), page(2, {status: 'processing'})]})).toMatchObject({reason: /finish reading/});
    expect(batchReadiness({...ok, pages: [page(2), page(2)]})).toMatchObject({reason: /Page 2 was uploaded twice/});
    expect(batchReadiness({...ok, storeCode: ' ', pages: [page(1)]})).toMatchObject({reason: /store code/});
    expect(batchReadiness({...ok, periodEnd: '', pages: [page(1)]})).toMatchObject({reason: /period/});
    expect(batchReadiness({...ok, periodEnd: '2026-09-01', pages: [page(1)]})).toMatchObject({reason: /on or after/});
    expect(batchReadiness({...ok, pages: [page(1, {flagged: 3, resolved: 1})]})).toMatchObject({reason: /Resolve 2 flagged rows/});
  });
});

describe('splitName', () => {
  it('names split pages', () => {
    expect(splitName('cubao-oct.pdf', 1, 5)).toBe('cubao-oct (page 2 of 5).pdf');
    expect(splitName('scan', 0, 2)).toBe('scan (page 1 of 2).pdf');
  });
});
