// The ONE product-name matcher for Ask Coop (plan knowledge/tasks/2026-10-19-ask-coop-inventory-plan.md, A1). Pure.
// Owner rule (2026-10-19): never guess a product. Only a SKU, an exact name, or a name whose words ALL appear in exactly one
// product is "exact"; anything matched by spelling tolerance ("yoghurt" -> "Yogurt") or by more than one product is "confirm",
// and the caller asks the owner. Matching is per word, so a typo in one word of a long name still finds the product.

export interface CatalogProduct {
  sku: string;
  name: string;
}

export type Resolution =
  | {kind: 'exact'; product: CatalogProduct}
  | {kind: 'confirm'; candidates: CatalogProduct[]}
  | {kind: 'none'; nearest: CatalogProduct[]};

export const MAX_CANDIDATES = 4;
const MAX_NEAREST = 3;
// Filler the owner types around a product name; never part of a match.
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'our', 'ng', 'yung', 'ang', 'mga', 'sa']);

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const norm = (s: string): string => words(s).join(' ');

/** Edit distance where swapping two neighbouring letters ("stirps" -> "strips") is one edit, the commonest typo. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({length: a.length + 1}, (_, i) => Array.from({length: b.length + 1}, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Edits a word of this length may have and still count as the same word. Short words must match exactly. */
const allowed = (len: number): number => (len >= 7 ? 2 : len >= 4 ? 1 : 0);

/**
 * Cost of matching one query word to a name word: 0 exact or prefix (3+ letters), else the edit distance; null when too far.
 * A SKU-like word (it has a digit) may be one character off even when short ("P7" for "P1"): always confirmed, never answered.
 */
function wordCost(q: string, w: string): number | null {
  if (q === w || (q.length >= 3 && w.startsWith(q))) return 0;
  const d = editDistance(q, w);
  const max = /\d/.test(q) ? Math.max(1, allowed(Math.max(q.length, w.length))) : allowed(Math.max(q.length, w.length));
  return d <= max ? d : null;
}

/**
 * Resolve what the owner typed against the catalog. `catalog` may hold the same SKU twice (POS and sold-line names); the first wins.
 * Exact: SKU (any case), exact name, or every query word is a substring of exactly one product's name or SKU.
 * Confirm: several products match those ways, or every query word matches a name word only with spelling tolerance.
 * None: nothing matches every word; `nearest` holds the products sharing the most words (may be empty).
 */
export function resolveProduct(query: string, catalog: readonly CatalogProduct[]): Resolution {
  const seen = new Set<string>();
  const products = catalog.filter((p) => p.sku && !seen.has(p.sku) && (seen.add(p.sku), true));
  const q = norm(query);
  const qWords = words(query).filter((w) => !STOPWORDS.has(w));
  if (q === '' || qWords.length === 0) return {kind: 'none', nearest: []};

  const bySku = products.find((p) => p.sku.toLowerCase() === query.trim().toLowerCase());
  if (bySku) return {kind: 'exact', product: bySku};

  const byName = products.filter((p) => norm(p.name) === q);
  if (byName.length === 1) return {kind: 'exact', product: byName[0]};
  if (byName.length > 1) return {kind: 'confirm', candidates: byName.slice(0, MAX_CANDIDATES)};

  const hay = (p: CatalogProduct): string => `${norm(p.name)} ${p.sku.toLowerCase()}`;
  const contains = products.filter((p) => qWords.every((w) => hay(p).includes(w)));
  if (contains.length === 1) return {kind: 'exact', product: contains[0]};
  if (contains.length > 1) return {kind: 'confirm', candidates: contains.slice(0, MAX_CANDIDATES)};

  // Spelling tolerance, word by word: every query word must find a name (or SKU) word close enough.
  const scored = products.map((p) => {
    const target = [...words(p.name), p.sku.toLowerCase()];
    let cost = 0;
    let matched = 0;
    for (const qw of qWords) {
      const best = target.reduce<number | null>((b, w) => {
        const c = wordCost(qw, w);
        return c !== null && (b === null || c < b) ? c : b;
      }, null);
      if (best !== null) {
        matched += 1;
        cost += best;
      }
    }
    return {p, matched, cost};
  });
  const byScore = (a: {matched: number; cost: number; p: CatalogProduct}, b: typeof a) => b.matched - a.matched || a.cost - b.cost || a.p.sku.localeCompare(b.p.sku);
  const full = scored.filter((s) => s.matched === qWords.length).sort(byScore);
  if (full.length > 0) return {kind: 'confirm', candidates: full.slice(0, MAX_CANDIDATES).map((s) => s.p)};
  const nearest = scored.filter((s) => s.matched > 0).sort(byScore).slice(0, MAX_NEAREST).map((s) => s.p);
  return {kind: 'none', nearest};
}
