// Per-company flag for the template-anchored read (plan:
// knowledge/tasks/2026-11-12-template-anchored-extraction.md). The read stays on the current free
// path until a company is explicitly listed, so flag-off is byte-identical to today.

/**
 * True when template-anchored reading is enabled for a company, via the comma-separated
 * `GOLDLINE_TEMPLATE_READ_COMPANIES` env (exact, case-sensitive match). Fail-closed: off unless the
 * company is listed, and off for an empty company id.
 */
export function templateReadEnabled(companyId: string): boolean {
  return companyInEnv(companyId, process.env.GOLDLINE_TEMPLATE_READ_COMPANIES);
}

/**
 * L7 batch mode (plan: knowledge/tasks/2026-11-18-l7-batch-mode-scope.md). True when a company's
 * anchored read should be deferred to the Anthropic Message Batches API (50% off, async) instead of
 * read inline, via the comma-separated `GOLDLINE_BATCH_READ_COMPANIES` env. Fail-closed: off unless
 * listed. Only the template (anchored) path batches, so this is effective only where
 * `templateReadEnabled` is also on; off is byte-identical to the synchronous read.
 */
export function batchReadEnabled(companyId: string): boolean {
  return companyInEnv(companyId, process.env.GOLDLINE_BATCH_READ_COMPANIES);
}

/**
 * P1 read-accuracy variant (plan: knowledge/tasks/2026-11-19-handwriting-read-accuracy.md): rows
 * keyed by the printed ITEM# read on the same line, writer-offset placement, and the paper's own
 * checks. Process-wide `GOLDLINE_READ_P1=1`; off (unset) is byte-identical to the current read.
 */
/**
 * Per-cell doubt (plan: knowledge/tasks/2026-11-19-handwriting-read-accuracy.md, backlog item 3): with P1, each row also
 * lists the cells the reader is genuinely unsure of and its second reading, so confidence comes from evidence the
 * reviewer can check ("29, or 39?") instead of one per-row guess. Process-wide `GOLDLINE_READ_UNSURE=1`; off = P1 as is.
 */
export function readUnsureEnabled(): boolean {
  return (process.env.GOLDLINE_READ_UNSURE ?? '').trim() === '1';
}

export function readP1Enabled(): boolean {
  return (process.env.GOLDLINE_READ_P1 ?? '').trim() === '1';
}

/**
 * Sharper page images (plan: knowledge/tasks/2026-11-19-handwriting-read-accuracy.md): send the read a
 * 1600 px page image + overlapping 300 dpi bands instead of the PDF (~90 dpi as rendered by the API).
 * Comma-separated `GOLDLINE_READ_BANDS_COMPANIES`; fail-closed, off is byte-identical (PDF).
 */
export function readBandsEnabled(companyId: string): boolean {
  return companyInEnv(companyId, process.env.GOLDLINE_READ_BANDS_COMPANIES);
}

/**
 * Batch the Legacy read too (L7 batched only the template read, so Legacy pages still read inline at
 * full price). Comma-separated `GOLDLINE_BATCH_LEGACY_COMPANIES`; effective only where
 * `batchReadEnabled` is also on. Off is byte-identical (inline Legacy read).
 */
export function batchLegacyEnabled(companyId: string): boolean {
  return companyInEnv(companyId, process.env.GOLDLINE_BATCH_LEGACY_COMPANIES);
}

function companyInEnv(companyId: string, raw: string | undefined): boolean {
  if (!companyId) return false;
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(companyId);
}
