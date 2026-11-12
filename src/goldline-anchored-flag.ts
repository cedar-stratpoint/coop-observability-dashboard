// Per-company flag for the template-anchored read (plan:
// knowledge/tasks/2026-11-12-template-anchored-extraction.md). The read stays on the current free
// path until a company is explicitly listed, so flag-off is byte-identical to today.

/**
 * True when template-anchored reading is enabled for a company, via the comma-separated
 * `GOLDLINE_TEMPLATE_READ_COMPANIES` env (exact, case-sensitive match). Fail-closed: off unless the
 * company is listed, and off for an empty company id.
 */
export function templateReadEnabled(companyId: string): boolean {
  if (!companyId) return false;
  const raw = process.env.GOLDLINE_TEMPLATE_READ_COMPANIES ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(companyId);
}
