// Per-company brand marks for the shell (plan §07i "One shell, two brands"): the only
// per-company difference a user sees is the logo and the data behind it.
//
// These are typographic recreations of the wordmarks (no official asset files exist in
// the repo yet). To use official artwork later, add it as an inline SVG component and
// render it from BrandMark (the CSP / security-headers test forbids remote <img>).

export type Brand = {
  wordmark: string;
  tagline?: string; // small line under the wordmark (e.g. Zoomy's "TREATS")
  style: 'bold' | 'thin';
  // Brand color per theme (each clears AA at small sizes on that theme's surfaces);
  // theme text color when omitted.
  color?: {light: string; dark: string};
  about: string; // one line describing the business (menu caption)
};

export const BRANDS: Record<string, Brand> = {
  zoomy: {wordmark: 'Zoomy!', tagline: 'TREATS', style: 'bold', color: {light: '#B8382C', dark: '#F0705F'}, about: 'pet treats · events · POS app sync'},
  goldline: {wordmark: 'NICHIDO', style: 'thin', about: 'cosmetics · stores · CSV + handwritten forms'},
};

export const brandFor = (companyId: string | null | undefined): Brand | null => (companyId ? (BRANDS[companyId] ?? null) : null);
