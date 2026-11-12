import 'server-only';
import {catalogForCodes} from './goldline-data';
import {buildFormTemplate, isTemplatePage, templateManifest, type FormTemplate} from './goldline-form-template';
import type {FormVersion} from './goldline-extract';

// Server-side loader for the Phase 0 form template (plan:
// knowledge/tasks/2026-11-12-template-anchored-extraction.md). Reads the cached catalog for the
// page's item codes (family + price) and composes the structural template with the pure
// buildFormTemplate. Kept out of goldline-form-template.ts so that module stays import-safe for
// unit tests (this one pulls in the server-only data layer).

/**
 * The authoritative template for a page + version, derived from the printed manifest (`MANIFESTS`,
 * printed order) joined with the catalog (`product_line` + `unit_price`). Returns null for a
 * non-inventory page (page 6 is the sales report, which has no manifest). In mock mode (no Nichido
 * env) the catalog is empty, so the template still returns item rows in printed order, just without
 * family bands or prices.
 */
export async function getFormTemplate(
  companyId: string,
  version: FormVersion,
  page: number,
): Promise<FormTemplate | null> {
  if (!isTemplatePage(page)) return null;
  const items = templateManifest(page);
  const catalog = await catalogForCodes(
    companyId,
    items.map((i) => i.code),
  );
  return buildFormTemplate(page, version, items, catalog);
}
