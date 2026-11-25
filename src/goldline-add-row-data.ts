import 'server-only';
import {getGlCatalog} from './goldline-ref-data';
import {itemDisplayName} from './goldline-item-name';
import {printedPageItems} from './goldline-printed-page';
import type {AddableItem} from './review-add-row';

// The products a reviewer can add to a form page (NICH-42 Add product row): every visible,
// not-retired catalog product, with the page of this form version that prints it so the
// picker can warn before a second count would replace the first.

const MAX_FORM_PAGES = 8;

export async function addableProducts(companyId: string, version: string | null | undefined): Promise<AddableItem[]> {
  const printedOn = new Map<string, number>();
  for (let page = 1; page <= MAX_FORM_PAGES; page++) {
    for (const it of printedPageItems(version, page)) if (!printedOn.has(it.code)) printedOn.set(it.code, page);
  }
  const catalog = await getGlCatalog(companyId);
  return catalog
    .filter((p) => !p.hidden && !p.retired_at)
    .map((p) => ({
      code: p.item_code,
      name: itemDisplayName(p.product_line, p.variant, p.item_code),
      line: p.product_line,
      price: p.unit_price == null ? null : Number(p.unit_price),
      printedPage: printedOn.get(p.item_code) ?? null,
    }));
}
