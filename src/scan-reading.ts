// Server-driven scan upload — the "still reading" awareness that survives a refresh.
// After the whole-scan upload + split, the pages are read on the server (the pg_cron pump),
// so the only truthful source of "how far along is this scan" is the DB, not the browser's
// in-memory upload queue (a refresh / navigation wipes that). This pure module shapes the DB
// rows into a batch summary and the labor-illusion presentation (percent + honest rotating
// stage labels). No React, no DB — unit-tested, reused by the dock (floating, off Uploads),
// the Uploads-page card, and the scan-detail banner.

/** A reading scan, aggregated from its page rows. */
export type ScanReadingSummary = {
  batchId: string;
  /** The scan's grouping key (uploadSource of its pages). Matches the /uploads/scan/[source]
   *  route param, so a scan-detail page can show the banner only for its own scan. */
  source: string;
  total: number;
  /** Settled pages: read (needs_review / committed), set aside (rejected), or failed. */
  done: number;
  /** Pages the pump is actively reading right now. */
  reading: number;
  /** Pages still waiting for the pump. */
  queued: number;
  needsReview: number;
  rejected: number;
  failed: number;
};

/** Aggregate a batch's page-status rows into a summary. `total` is every page in the batch. */
export function summarizeScanRows(
  rows: Array<{status: string}>,
  batchId: string,
  source: string,
): ScanReadingSummary {
  let reading = 0;
  let queued = 0;
  let needsReview = 0;
  let rejected = 0;
  let failed = 0;
  let committed = 0;
  for (const r of rows) {
    switch (r.status) {
      case 'processing':
        reading++;
        break;
      case 'queued':
        queued++;
        break;
      case 'needs_review':
        needsReview++;
        break;
      case 'rejected':
        rejected++;
        break;
      case 'failed':
        failed++;
        break;
      case 'committed':
        committed++;
        break;
    }
  }
  return {
    batchId,
    source,
    total: rows.length,
    done: needsReview + rejected + failed + committed,
    reading,
    queued,
    needsReview,
    rejected,
    failed,
  };
}

/** Still working while any page is queued (waiting) or processing (being read). */
export function isScanActive(s: ScanReadingSummary): boolean {
  return s.reading + s.queued > 0;
}

/** Real progress: settled pages over total. The sheen + rotating label carry the "alive"
 *  feel; the fill stays honest (it never pretends to be further along than it is). */
export function scanReadingPercent(s: ScanReadingSummary): number {
  if (s.total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((s.done / s.total) * 100)));
}

/**
 * Honest rotating stage labels (labor illusion): each names real work the per-page read
 * pipeline does, so the wait reads as productive, not stuck. Rotated on a timer by the UI.
 */
export const SCAN_READING_STAGES = [
  'Reading handwriting',
  'Checking the store',
  'Matching SKUs',
  'Saving counts',
] as const;

/** The stage label for a rotation tick (wraps; safe for any integer incl. negatives). */
export function scanReadingStage(tick: number): string {
  const n = SCAN_READING_STAGES.length;
  return SCAN_READING_STAGES[((tick % n) + n) % n];
}
