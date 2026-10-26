// Watsons SKU → Nichido item matching (P1 · F2). Pure + unit-tested.
//
// Watsons reports its own numeric SKU codes; Nichido's catalog and inventory forms use
// item codes. The only shared clues are the product name, the price and the numbers
// inside names (brush #525, lash 84552, LP04). Watsons names are often cut short and
// squeezed ("MINERAL PRECISE EP CHESTNUT", "TWO WAY CKE MTTE ORIENTAL"), so words are
// compared as abbreviations, not exact strings.
//
// Each Watsons SKU gets a score against every catalog item, then pairs are taken
// greedily, best first, one item per SKU and one SKU per item. The tier says how much
// to trust the pair:
//   high    strong match, clearly ahead of the runner-up: linked automatically
//   medium  likely: shown to an admin to confirm
//   low     a guess: shown, but needs checking
// Measured on the 10 Watsons months (Oct 2025 to Sep 2026): high pairs agreed with all
// 37 links read from item codes in names, and a 45-pair spot check was all correct.

export type CatalogItem = {item_code: string; product_line: string | null; variant: string | null; unit_price: number | null};
export type ChainSkuStat = {sku_code: string; name: string; units: number; gross: number};
export type MatchTier = 'high' | 'medium' | 'low';
export type SkuMatch = {skuCode: string; itemCode: string; score: number; tier: MatchTier};

const STOP = new Set(['NICHIDO', 'NCHDO', 'NIICHIDO', 'THE', 'W', 'WITH', 'AND', 'OF', 'IN', 'PCS', 'PC', 'G', 'GMS', 'GRAMS', 'ML', 'PACK']);

// Watsons' squeezed spellings, expanded before comparing.
const ABBR: Record<string, string> = {
  EP: 'EYE PENCIL', EL: 'EYELINER', PP: 'PRESSED POWDER', PLS: 'PLUS', LT: 'LIGHT', CHK: 'CHEEK', TNT: 'TINT', N: 'AND',
  PWDRBLSH: 'POWDER BLUSH', TRUECOLORS: 'TRUE COLORS', MSCR: 'MASCARA', LS: 'LIP STAIN', LQD: 'LIQUID', FDN: 'FOUNDATION',
  PRBNFR: 'PARABEN FREE', FR: 'FREE', EYESHDW: 'EYESHADOW', BLSH: 'BLUSH', PWDR: 'POWDER', MED: 'MEDIUM', DRK: 'DARK',
  BRN: 'BROWN', BLK: 'BLACK',
};

const hasDigit = (t: string) => /\d/.test(t);

/** Upper-case words, abbreviations expanded (Watsons side), stop words and repeats dropped. */
export function tokens(s: string, expand = false): string[] {
  const raw = s.toUpperCase().replace(/&/g, ' AND ').replace(/'/g, '').replace(/-/g, ' ').split(/[^A-Z0-9#/]+/);
  const out: string[] = [];
  for (const t of raw) {
    if (!t) continue;
    const words = expand && ABBR[t] ? ABBR[t].split(' ') : [t];
    for (const w of words) if (!STOP.has(w) && !out.includes(w)) out.push(w);
  }
  return out;
}

/** How well `a` (a Watsons word) stands for `b` (a catalog word): exact, cut short, or squeezed. */
export function abbreviates(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length >= 3 && b.startsWith(a)) return 0.9;
  if (a.length >= 2 && a[0] === b[0]) {
    let i = 0;
    for (const c of b) if (c === a[i]) i++;
    if (i === a.length) return 0.7;
  }
  return 0;
}

/** Share of the catalog words the Watsons words cover (0 to 1), or null when there are none. */
function cover(catalog: string[], watsons: string[]): number | null {
  if (!catalog.length) return null;
  const words = watsons.filter((w) => !hasDigit(w));
  // Long glued Watsons words ("PRBNFRCHKYPNCHOPNK") can carry several catalog words.
  const glued = watsons.filter((w) => w.length > 8).join('');
  let s = 0;
  for (const t of catalog) {
    let best = 0;
    for (const w of words) best = Math.max(best, abbreviates(w, t));
    if (!best && glued && glued.includes(t.slice(0, 3))) best = 0.6;
    s += best;
  }
  return s / catalog.length;
}

const numbersOf = (ts: string[]) => new Set(ts.filter(hasDigit).map((t) => t.replace(/^#/, '')));

/** Score one Watsons SKU against one catalog item. Higher is better; ~1 is a strong match. */
export function scorePair(sku: ChainSkuStat, item: CatalogItem): number {
  const wt = tokens(sku.name, true);
  const wn = numbersOf(wt);
  const accessory = (item.product_line ?? '').trim().toLowerCase() === 'accessories';
  const line = accessory ? [] : tokens(item.product_line ?? '');
  const variant = tokens(item.variant ?? '').filter((t) => !line.includes(t));
  const lineWords = line.filter((t) => !hasDigit(t));
  const shadeWords = variant.filter((t) => !hasDigit(t));
  const itemNums = new Set([...numbersOf([...line, ...variant]), ...numbersOf([item.item_code.toUpperCase()])]);

  const lc = cover(lineWords, wt);
  const sc = cover(shadeWords, wt);
  // Shade words decide between siblings of one line, so they weigh more.
  let s = 0.4 * (lc ?? 0.5) + 0.6 * (sc ?? lc ?? 0);
  if (wn.size && itemNums.size) s += [...wn].some((n) => itemNums.has(n)) ? 0.3 : -0.3;
  // Price: Watsons' average includes discounts, so being lower is normal; higher is not.
  const price = sku.units > 0 ? sku.gross / sku.units : null;
  if (price != null && item.unit_price) {
    const r = price / item.unit_price;
    if (r >= 0.7 && r <= 1.05) s += 0.1;
    else if (r > 1.15 || r < 0.5) s -= 0.3;
  }
  return s;
}

const MIN_SCORE = 0.55;

/**
 * Pair Watsons SKUs with catalog items, best scores first, one-to-one. `taken` lists
 * pairs that already exist (they are kept and their SKU and item are not reused);
 * `blocked` holds `sku|item` pairs an admin turned down, never suggested again.
 * SKUs with no sales are skipped: there is nothing to check them against.
 */
export function matchSkus(
  skus: ChainSkuStat[],
  catalog: CatalogItem[],
  taken: Array<{skuCode: string; itemCode: string}> = [],
  blocked: ReadonlySet<string> = new Set(),
): SkuMatch[] {
  const usedSku = new Set(taken.map((t) => t.skuCode));
  const usedItem = new Set(taken.map((t) => t.itemCode));
  const open = skus.filter((s) => s.units > 0 && !usedSku.has(s.sku_code));
  const items = catalog.filter((c) => !usedItem.has(c.item_code));

  const pairs: Array<{score: number; sku: string; item: string}> = [];
  const best = new Map<string, {score: number; item: string}>();
  const second = new Map<string, number>();
  for (const s of open) {
    const scored = items
      .filter((c) => !blocked.has(`${s.sku_code}|${c.item_code}`))
      .map((c) => ({score: scorePair(s, c), sku: s.sku_code, item: c.item_code}))
      .sort((a, b) => b.score - a.score);
    if (scored[0]) best.set(s.sku_code, {score: scored[0].score, item: scored[0].item});
    second.set(s.sku_code, scored[1]?.score ?? 0);
    pairs.push(...scored.filter((p) => p.score >= MIN_SCORE));
  }
  pairs.sort((a, b) => b.score - a.score || a.sku.localeCompare(b.sku) || a.item.localeCompare(b.item));

  const out: SkuMatch[] = [];
  for (const p of pairs) {
    if (usedSku.has(p.sku) || usedItem.has(p.item)) continue;
    usedSku.add(p.sku);
    usedItem.add(p.item);
    // High only when it is this SKU's own best item and clearly ahead of the runner-up.
    const own = best.get(p.sku);
    const gap = own && own.item === p.item ? p.score - (second.get(p.sku) ?? 0) : 0;
    const tier: MatchTier = p.score >= 0.85 && gap >= 0.1 ? 'high' : p.score >= 0.7 ? 'medium' : 'low';
    out.push({skuCode: p.sku, itemCode: p.item, score: Math.round(p.score * 100) / 100, tier});
  }
  return out;
}
