// What a scanned form page PRINTS for each row: its product name, the black heading band it
// sits under, and its printed price, per form version (Legacy, V1 and V2 paginate and label
// differently). The review shows these instead of the shorter shared names and catalog
// product lines, so the screen matches the paper: QA (San Pablo, Nov 23/24) found headings
// missing printed text ("(2 in 1 Eyeliner & Under Eyeliner)", "3ml (black)"), the Make-Up
// Collection price lines (BESP, LSESP, CPC001) missing, name tags ("#9717") dropped and "&"
// shown as "and". Pure.

import {MANIFESTS, type FormVersion} from './goldline-extract';
import {generatedTemplateItems} from './goldline-form-templates.generated';
import type {CatalogLite} from './review-workbench';

export type PrintedItem = {code: string; product: string; group: string | null; price: number | null};

const VERSIONS = new Set(['legacy', 'v1', 'v2']);

/** The page's printed rows for its form version; the shared page list (names only) when the
 *  version is unknown or has no printed list for that page. */
export function printedPageItems(version: string | null | undefined, page: number | null | undefined): PrintedItem[] {
  const p = page ?? 0;
  const gen = version && VERSIONS.has(version) ? generatedTemplateItems(version as FormVersion, p) : null;
  if (gen) return gen;
  return (MANIFESTS[p] ?? []).map((m) => ({code: m.code, product: m.product, group: null, price: null}));
}

/** code → printed product name. */
export function printedNames(items: PrintedItem[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const it of items) names[it.code] = it.product;
  return names;
}

/** The catalog with each printed row's heading and price laid over it: the heading as printed
 *  (the review's group bars) and the printed price (what the paper's totals use). A code the
 *  page doesn't print keeps its catalog entry. */
export function withPrintedHeadings(catalog: Record<string, CatalogLite>, items: PrintedItem[]): Record<string, CatalogLite> {
  const out: Record<string, CatalogLite> = {...catalog};
  for (const it of items) {
    const base = catalog[it.code];
    out[it.code] = {productLine: it.group ?? base?.productLine ?? null, unitPrice: it.price ?? base?.unitPrice ?? null};
  }
  return out;
}
