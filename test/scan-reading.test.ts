import {describe, expect, it} from 'vitest';
import {
  isScanActive,
  scanReadingPercent,
  scanReadingStage,
  SCAN_READING_STAGES,
  summarizeScanRows,
} from '../src/scan-reading';

const rows = (counts: Record<string, number>) =>
  Object.entries(counts).flatMap(([status, n]) => Array.from({length: n}, () => ({status})));

describe('summarizeScanRows', () => {
  it('counts every status and folds settled ones into done', () => {
    const s = summarizeScanRows(
      rows({queued: 10, processing: 6, needs_review: 3, rejected: 2, failed: 1, committed: 4}),
      'b1',
      'Scan2026-10-30',
    );
    expect(s.total).toBe(26);
    expect(s.reading).toBe(6);
    expect(s.queued).toBe(10);
    expect(s.needsReview).toBe(3);
    expect(s.rejected).toBe(2);
    expect(s.failed).toBe(1);
    // done = needs_review + rejected + failed + committed
    expect(s.done).toBe(10);
    expect(s.batchId).toBe('b1');
    expect(s.source).toBe('Scan2026-10-30');
  });

  it('an empty batch is zeroed, not NaN', () => {
    const s = summarizeScanRows([], 'b0', 'Scan');
    expect(s).toMatchObject({total: 0, done: 0, reading: 0, queued: 0});
    expect(scanReadingPercent(s)).toBe(0);
  });
});

describe('isScanActive', () => {
  it('is active while any page is queued or processing', () => {
    expect(isScanActive(summarizeScanRows(rows({queued: 1}), 'b', 's'))).toBe(true);
    expect(isScanActive(summarizeScanRows(rows({processing: 1}), 'b', 's'))).toBe(true);
  });
  it('stays active while a page is out in a batch (L7 queued_batch), counted in flight not done', () => {
    const s = summarizeScanRows(rows({needs_review: 3, queued_batch: 2}), 'b', 's');
    expect(isScanActive(s)).toBe(true);
    expect(s.reading).toBe(2); // the batched pages are in flight
    expect(s.done).toBe(3); // and not counted as done until the poller ingests them
  });
  it('is settled once nothing is queued or processing', () => {
    expect(isScanActive(summarizeScanRows(rows({needs_review: 3, rejected: 1}), 'b', 's'))).toBe(false);
  });
});

describe('scanReadingPercent', () => {
  it('is done over total, rounded and clamped', () => {
    expect(scanReadingPercent(summarizeScanRows(rows({needs_review: 49, queued: 49}), 'b', 's'))).toBe(50);
    expect(scanReadingPercent(summarizeScanRows(rows({needs_review: 98}), 'b', 's'))).toBe(100);
  });
});

describe('scanReadingStage', () => {
  it('wraps through the stages for any integer, including negatives', () => {
    expect(scanReadingStage(0)).toBe(SCAN_READING_STAGES[0]);
    expect(scanReadingStage(SCAN_READING_STAGES.length)).toBe(SCAN_READING_STAGES[0]);
    expect(scanReadingStage(-1)).toBe(SCAN_READING_STAGES[SCAN_READING_STAGES.length - 1]);
  });
});
