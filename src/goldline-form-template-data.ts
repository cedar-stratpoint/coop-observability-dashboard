import 'server-only';
import {catalogForCodes} from './goldline-data';
import {buildFormTemplate, isTemplatePage, templateManifest, type FormTemplate} from './goldline-form-template';
import {templateReadEnabled} from './goldline-anchored-flag';
import {generatedTemplateItems} from './goldline-form-templates.generated';
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

  // Version-faithful template from the authored xlsx (docs/form-templates, generated into
  // goldline-form-templates.generated.ts), flag-gated by templateReadEnabled. Each form version
  // gets its OWN printed row list, bands, and prices — the versions share one catalog but paginate
  // differently (e.g. Trulashes De Luxe is on V1 page 4 but V2 page 5), which the page-only
  // MANIFESTS cannot represent and which made the reader flag real printed rows as handwritten.
  // The grouping + printed price come straight from the form (no catalog join, so a code the
  // catalog is missing still carries its printed band + price). Flag-off, or a version/page with no
  // generated data, falls through to the original manifest + catalog path below (byte-identical).
  if (templateReadEnabled(companyId)) {
    const gen = generatedTemplateItems(version, page);
    if (gen) {
      const items = gen.map((g) => ({code: g.code, product: g.product}));
      const catalog: Record<string, {productLine: string | null; unitPrice: number | null}> =
        Object.fromEntries(gen.map((g) => [g.code, {productLine: g.group, unitPrice: g.price}]));
      return buildFormTemplate(page, version, items, catalog);
    }
  }

  const items = templateManifest(page);
  const catalog = await catalogForCodes(
    companyId,
    items.map((i) => i.code),
  );
  return buildFormTemplate(page, version, items, catalog);
}
