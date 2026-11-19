// Server-driven scan upload, P2 — the shape the browser polls while the server reads a
// scan, plus the pure status→state mapping (unit-tested). The client turns each page row
// into a queue item so the existing uploader list shows live progress in place, exactly
// like the client-driven path, but backed by DB state instead of an in-memory queue — so
// a refresh / navigation / slow page can't interrupt it. Pure module: no React, no DB.

/** One page of a server-driven scan, as the progress poll returns it. */
export type ServerPageProgress = {
  uploadId: string;
  filename: string;
  status: string; // queued | queued_batch | processing | needs_review | committed | rejected | failed
  page: number | null;
  formVersion: string | null;
  pageKind: string | null;
  flagged: number | null;
  rows: number | null;
};

/** A batch's live progress: every page + whether the whole batch has settled. */
export type ServerBatchProgress = {
  batchId: string;
  pages: ServerPageProgress[];
  /** True when no page is still queued or processing (everything reached a terminal state). */
  settled: boolean;
};

/** A page is still in flight while it's queued (waiting for the pump), queued_batch (its read is
 *  out in a Message Batch, L7), or processing (reading). Until it reaches a terminal state the
 *  uploader must keep polling — a queued_batch page finishes later via the batch poller. */
export function isSettledStatus(status: string): boolean {
  return status !== 'queued' && status !== 'queued_batch' && status !== 'processing';
}

/**
 * Map a server page's upload status to the uploader's item state, so a polled page renders
 * with the same rows/pills as a client-driven one. `rejected` is a page set aside (sales /
 * blank / not-an-inventory page) — a calm "done", not a failure.
 */
export function serverPageState(status: string): 'queued' | 'running' | 'done' | 'failed' {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'processing':
      return 'running';
    // L7: the page's read is out in a Message Batch — still in flight, shown as "Processing".
    case 'queued_batch':
      return 'running';
    case 'needs_review':
    case 'committed':
    case 'rejected':
      return 'done';
    case 'failed':
      return 'failed';
    default:
      return 'queued';
  }
}
