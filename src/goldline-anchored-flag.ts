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

/**
 * Reader review flags (NICH-36, plan knowledge/tasks/2026-11-25-review-marks-and-reco-reports.md): the
 * P1 anchored read and the Legacy read also return a per-row `flags` list (a BA note or revision,
 * "Damage" in a count) and the printed headers the BA wrote over; the pipeline writes them as
 * review flags. Process-wide `GOLDLINE_READ_MARKS=1`; off (unset) is byte-identical to the current read.
 */
export function readMarksEnabled(): boolean {
  return (process.env.GOLDLINE_READ_MARKS ?? '').trim() === '1';
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

/**
 * Sharp header crops for the classify call (Nov 26): the handwritten header (store code, store name,
 * period, BA) is read off a ~90 dpi page, so codes come back misread or blank (2414 as 2494, 481 as
 * 81). With 300 dpi crops of the page's top and bottom edges the store code came back right on 24 of
 * 55 pages against 15, at about 6.4k more input tokens per page. Per company via
 * `GOLDLINE_HEADER_CROP_COMPANIES`; fail-closed, off = today's classify call unchanged.
 */
export function headerCropsEnabled(companyId: string): boolean {
  return companyInEnv(companyId, process.env.GOLDLINE_HEADER_CROP_COMPANIES);
}

/**
 * Known BA names for the classify call (Nov 26): the roster Coop learns from committed forms is
 * passed to the reader as a reference, so a handwritten Beauty Consultant name is matched against
 * real names instead of guessed letter by letter. Per company via `GOLDLINE_BA_HINT_COMPANIES`;
 * fail-closed, off = today's classify call unchanged.
 */
export function baHintEnabled(companyId: string): boolean {
  return companyInEnv(companyId, process.env.GOLDLINE_BA_HINT_COMPANIES);
}

function companyInEnv(companyId: string, raw: string | undefined): boolean {
  if (!companyId) return false;
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(companyId);
}

/**
 * Exact row boxes for review (scan-review plan, step 3): alongside each batched read, one small
 * request asks where every printed product row sits on the page, so hovering a row in review boxes
 * it on the scan. Comma-separated `GOLDLINE_READ_BOXES_COMPANIES`; needs batch mode and the sharper
 * page images (the box request uses the rendered page). Off is byte-identical to today.
 */
export function readBoxesEnabled(companyId: string): boolean {
  return companyInEnv(companyId, process.env.GOLDLINE_READ_BOXES_COMPANIES);
}
