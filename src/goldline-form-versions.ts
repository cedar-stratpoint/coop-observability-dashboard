// Reference previews for each inventory-form version (Legacy / V1 / V2): one clean example of
// each layout, pages 1 to 5, so a reviewer can see what a version's form looks like. Extracted
// from the form-audit reference (docs/form-audit-hq.html in the workspace) into
// public/form-versions/. Used by the version-preview modal on the scan-detail page.

export type FormVersionKey = 'legacy' | 'v1' | 'v2';

export type FormVersionPage = {page: number; img: string; sections: string};
export type FormVersionPreview = {label: string; subtitle: string; pages: FormVersionPage[]};

// Every version's five pages cover the same product sections (only the layout differs), so the
// section hints are shared.
const SECTIONS: Record<number, string> = {
  1: 'Pressed Powder, Fancy Colors, Foundations, BB Cream',
  2: 'eye shadow, powder blush, make-up collection, lip color',
  3: 'brow, eye & lip pencils',
  4: 'mascara, primer, accessories',
  5: 'lashes, lipstick',
};

const pagesFor = (v: FormVersionKey): FormVersionPage[] =>
  [1, 2, 3, 4, 5].map((n) => ({page: n, img: `/form-versions/${v}-${n}.jpg`, sections: SECTIONS[n] ?? ''}));

export const FORM_VERSION_PREVIEWS: Record<FormVersionKey, FormVersionPreview> = {
  legacy: {label: 'Legacy', subtitle: 'deducted layout', pages: pagesFor('legacy')},
  v1: {label: 'V1', subtitle: 'three-location layout', pages: pagesFor('v1')},
  v2: {label: 'V2', subtitle: 'delivery-first layout', pages: pagesFor('v2')},
};

/** The preview for a version string, or null for versions with no reference (e.g. 'unknown'). */
export function formVersionPreview(version: string | null | undefined): FormVersionPreview | null {
  return version === 'legacy' || version === 'v1' || version === 'v2' ? FORM_VERSION_PREVIEWS[version] : null;
}
