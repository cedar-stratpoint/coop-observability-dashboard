// Goldline · the PO form (NICH-17 reconciliation, PO leg). PURE, unit-tested.
//
// Nichido's paper PURCHASE ORDER FORM is the product list a BA orders from. Decided Nov 23:
// the latest uploaded PO form is the source of truth for which products are ACTIVE (still
// delivered). A product printed on it is "on the PO"; a product not on it is inactive
// (being phased out). There is no lookback window: a new upload, once activated, replaces
// the old list in full.
//
// The form is free text, not a table of codes: a family heading ("Flawless Beauty Pressed
// Powder (black case)") with its shades under it ("- Salmon", "- Golden Tan"), and selling
// notes for the BA mixed into the same cells ("Bestseller", "(1) Full Coverage", Tagalog
// keywords). So reading it is two steps:
//   1. phrases: each printed line becomes {heading, shade}; notes are dropped.
//   2. match: each phrase is matched to one catalog product (family + shade, with the
//      form's abbreviations: "I. Glow" = Ivory Glow, "TWC" = Two Way Cake).
// Phrases that match nothing are kept for the admin to review; the admin can also add or
// remove products by hand before activating, so the matcher only has to pre-fill well.

export type PoFormCell = {page: string; column: number; row: number; text: string};

export type PoPhrase = {
  /** The family heading in force for this line (null for a line before any heading). */
  heading: string | null;
  /** The shade / variant part, or null when the line is a heading or a single product. */
  shade: string | null;
  /** The printed line, cleaned of notes, for showing the admin. */
  text: string;
  page: string;
};

export type CatalogProduct = {item_code: string; product_line: string | null; variant: string | null; retired?: boolean};

export type PoMatch = {item_code: string; phrase: PoPhrase; score: number};

export type PoFormResult = {
  matches: PoMatch[];
  /** Printed lines that look like a product but matched nothing in the catalog. */
  unmatched: PoPhrase[];
};

// ── Step 1: cells → phrases ──────────────────────────────────────────────────────────

/** Selling notes and form furniture that are never a product. Checked per segment. */
const NOTE = new RegExp(
  [
    '^bestseller\\b',
    '^\\(?\\s*best\\s*seller',
    '^keywords?\\b',
    '^\\(?\\d+\\)', // "(1) Full coverage", "1) With plumping"
    '^\\d+\\.\\s*[a-z]', // "1. Full Coverage", "2. 21g ang laman"
    '^no\\s+flashback',
    '^no\\s+make-?up',
    '^non[\\s-]',
    '^paraben\\s*free',
    '^use\\s+for',
    '^(full|better)\\s+coverage',
    '^(long|smudge|quick|water|transfer|oil)\\b',
    '^mineral\\s+(po|-)',
    '^(less|small|wax|wet|gel|creamy|covers|vegan|with)\\b',
    '^(hindi|mas|ang|nito|kung|kapag|gamit|pwede|alok|mahihirapan|sa|ng)\\b',
    '^-?hindi\\b',
    '^\\d+\\s*g\\b',
    '^\\(',
    '^\\*',
    '^•',
    '^it will',
    '^mas\\b',
    '^bago\\b',
    '^translucent meaning',
    '^goodluck',
    '^qty\\.?$',
    '^description$',
  ].join('|'),
  'i',
);

/** Lines on the form that are instructions, not products (whole line). */
const SKIP_LINE = /purchase order form|\bsayo\b|gamit ang|beauty consultant|^to\s*:|^from\s*:|ang trabaho mo|gamitin ang keywords|kailangan mo|balik mo|pakita|low sales item|check display|check tester|please display|fifo|first in|translucent-? meaning|^\s*_+\s*$|^n0\.|^\s*$/i;

const DASH_SHADE = /^\s*[-–]\s*/;
const CODE_SHADE = /^\s*['’]?\s*(#?[A-Z]{0,3}\d{2,6})\b/; // '86619, #2, L4525, LP02

/** Split a cell into its segments: runs of 3+ spaces separate the product from the notes. */
function segments(text: string): string[] {
  return text
    .replace(/\t/g, '   ')
    .split(/\s{3,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Strip trailing markers the form prints after a name: "(new)", "Bestseller", "(Bestseller )". */
function tidy(s: string): string {
  return s
    .replace(/\(\s*best\s*seller\s*\)/gi, '')
    .replace(/\bbest\s*seller\b/gi, '')
    .replace(/\(new\)/gi, '')
    .replace(/\(\s*no tester\s*\/\s*no trial\s*\)/gi, '')
    .replace(/\s*[;:]\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** True when a segment is a heading-like product name (letters, not a note). */
function isNameSegment(s: string): boolean {
  if (!/[a-z]/i.test(s)) return false;
  if (NOTE.test(s)) return false;
  return true;
}

/**
 * Turn the form's description cells (read top to bottom, left column then right column,
 * page by page) into phrases. A line starting with "-" (or a bare code like '86619) is a
 * shade under the current heading; any other product-looking line is a new heading, which
 * may carry its own first shade after a " - " ("Bronzing Powder - Go Bronze").
 */
export function poFormPhrases(cells: PoFormCell[]): PoPhrase[] {
  const ordered = [...cells].sort((a, b) => a.page.localeCompare(b.page, undefined, {numeric: true}) || a.column - b.column || a.row - b.row);
  const out: PoPhrase[] = [];
  let heading: string | null = null;
  let streamKey = '';
  let carried: string | null = null;
  // "Nichido Trulashes - De Luxe" followed by codes: the dash was part of the family name,
  // not a first shade. When codes follow a split heading, undo the split.
  let lastSplit: {index: number; full: string} | null = null;
  const mergeSplitHeading = () => {
    if (lastSplit && lastSplit.index === out.length - 1 && out[lastSplit.index].shade) {
      heading = lastSplit.full;
      out.pop();
    }
    lastSplit = null;
  };
  for (const c of ordered) {
    const key = `${c.page}|${c.column}`;
    if (key !== streamKey) {
      // A new column starts fresh; a column that opens with shades ("- Salmon") continues
      // the family of the column before it, so a family split across columns stays whole.
      streamKey = key;
      carried = heading;
      heading = null;
    }
    const raw = (c.text ?? '').replace(/\r/g, '');
    if (SKIP_LINE.test(raw.trim())) continue;
    for (const line of raw.split('\n')) {
      if (SKIP_LINE.test(line.trim())) continue;
      const segs = segments(line);
      // Find the first segment that is product text: a shade ("- Salmon"), a code, or a name.
      const idx = segs.findIndex((s) => DASH_SHADE.test(s) || CODE_SHADE.test(s) || isNameSegment(s));
      if (idx < 0) continue;
      let seg = segs[idx];
      // "Bestseller - S. Beige": a note glued before a shade in the same segment.
      seg = seg.replace(/^best\s*seller\s+(?=[-–])/i, '');
      if (DASH_SHADE.test(seg)) {
        if (!heading) heading = carried;
        const shade = tidy(seg.replace(DASH_SHADE, ''));
        if (/^[A-Z]{0,3}\d{3,6}\b/i.test(shade)) mergeSplitHeading();
        if (shade && heading) out.push({heading, shade, text: `${heading} · ${shade}`, page: c.page});
        continue;
      }
      if (CODE_SHADE.test(seg) && !/[a-z]{3,}/i.test(seg.replace(CODE_SHADE, ''))) {
        if (!heading) heading = carried;
        mergeSplitHeading();
        const code = tidy(seg.replace(/^['’]\s*/, ''));
        if (heading) out.push({heading, shade: code, text: `${heading} · ${code}`, page: c.page});
        continue;
      }
      if (/^#\s*[A-Z]{0,3}\d/i.test(seg) && heading) {
        // "#802 - M. Brown", "#2 - Natural": a numbered shade under the current family.
        const shade = tidy(seg.replace(/\s+[-–]\s*/, ' '));
        out.push({heading, shade, text: `${heading} · ${shade}`, page: c.page});
        continue;
      }
      if (/^accessories\s*:?$/i.test(seg.trim())) {
        heading = 'Accessories';
        continue;
      }
      // A heading, maybe with its first shade: split on the first spaced dash.
      const name = tidy(seg);
      if (!name) continue;
      const m = name.match(/^(.*?\S)\s+[-–]\s*(\S.*)$/);
      if (m && !/^(make|leg|e|s)$/i.test(m[1])) {
        const h = m[1].trim();
        const shade = m[2].trim();
        // Inside Accessories every line is its own product; keep the heading.
        if (heading === 'Accessories' && !/^[A-Z]{2,4}\b/.test(h)) {
          out.push({heading, shade: name, text: name, page: c.page});
          continue;
        }
        heading = h;
        out.push({heading, shade, text: `${h} · ${shade}`, page: c.page});
        lastSplit = {index: out.length - 1, full: `${h} ${shade}`};
        continue;
      }
      if (heading === 'Accessories') {
        out.push({heading, shade: name, text: name, page: c.page});
        continue;
      }
      heading = name;
      out.push({heading, shade: null, text: name, page: c.page});
      // "Elise Lashes        - N4455": the first shade printed on the heading's own line.
      for (const rest of segs.slice(idx + 1)) {
        const shade = tidy(rest.replace(DASH_SHADE, ''));
        if (DASH_SHADE.test(rest) && shade && !NOTE.test(shade)) out.push({heading, shade, text: `${heading} · ${shade}`, page: c.page});
      }
    }
  }
  return out;
}

// ── Step 2: phrases → catalog products ──────────────────────────────────────────────

/** Abbreviations the form uses for family names. */
const ALIASES: Array<[RegExp, string]> = [
  [/\btwc\b/g, 'two way cake'],
  [/\btcc\b/g, 'true colors'],
  [/\btsp\b/g, 'translucent setting powder'],
  [/\be\/s\b/g, 'eye shadow'],
  [/\bl\/s\b/g, 'lipstick'],
  [/\bw\/\s*/g, 'with '],
  [/\bret\b/g, 'retractable'],
  [/\bkohl\b/g, 'kohl'],
];

const STOP = new Set(['nichido', 'the', 'and', 'of', 'with', 'w', 'in', 'a', 'po', 'ito', 'for', 'type', 'case', 'black', 'size', 'asian', 'korea', 'original', 'pcs', 'pack']);
// Words that matter for a shade even though they're common: keep "black" etc. for shades.
const STOP_SHADE = new Set(['nichido', 'the', 'and', 'of', 'with', 'w', 'in', 'a']);

function tokens(s: string, stop: Set<string>): string[] {
  let t = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  for (const [re, rep] of ALIASES) t = t.replace(re, rep);
  t = t
    .replace(/(\d)([a-z])/g, '$1 $2') // 21grams → 21 grams
    .replace(/([a-z])(\d)/g, '$1 $2') // bb01 → bb 01
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9.]+/g, ' ');
  return t
    .split(' ')
    .map((w) => w.replace(/^\.+|\.+$/g, (m) => (m.length && /^[a-z]\.$/.test(w) ? m : '')))
    .map((w) => (/^[a-z]\.$/.test(w) ? w : w.replace(/\./g, '')))
    .map((w) => (/^\d+$/.test(w) ? String(Number(w)) : w)) // 01 → 1, 801 → 801
    .filter((w) => w && !stop.has(w));
}

/** "s." (an abbreviation) matches any word starting with s; anything else must be equal. */
function wordMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (/^[a-z]\.$/.test(a)) return b.startsWith(a[0]) && b.length > 1;
  if (/^[a-z]\.$/.test(b)) return a.startsWith(b[0]) && a.length > 1;
  // Small spelling drift on the form ("Verry"/"Very", "Carribean"/"Caribbean").
  if (a.length >= 4 && b.length >= 4 && Math.abs(a.length - b.length) <= 1 && !/\d/.test(a + b)) return editDistance(a, b) <= 1;
  return false;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({length: a.length + 1}, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** How many of `need` are found in `have` (each `have` word used once). */
function covered(need: string[], have: string[]): number {
  const used = new Set<number>();
  let n = 0;
  for (const w of need) {
    const i = have.findIndex((h, k) => !used.has(k) && wordMatch(w, h));
    if (i >= 0) {
      used.add(i);
      n++;
    }
  }
  return n;
}

type Prepared = {p: CatalogProduct; family: string[]; distinct: string[]; name: string[]};

function prepare(catalog: CatalogProduct[]): Prepared[] {
  return catalog.map((p) => {
    const family = tokens(p.product_line ?? '', STOP);
    const variant = tokens(p.variant ?? '', STOP_SHADE);
    // The shade: the variant without the family's own words ("Matte Lip Color Bespoke" → bespoke).
    const familyish = new Set([...family, ...tokens(p.product_line ?? '', STOP_SHADE)]);
    let k = 0;
    while (k < variant.length - 1 && familyish.has(variant[k])) k++;
    let distinct = variant.slice(k);
    // A variant that only repeats the family ("7X Volume Curl Mascara") has no shade.
    if (distinct.every((w) => familyish.has(w))) distinct = [];
    // Accessories / Make-Up Collection: the variant IS the product name.
    if (/^(accessories|make-?up collection)$/i.test((p.product_line ?? '').trim())) distinct = tokens(p.variant ?? '', STOP);
    const name = [...new Set([...family, ...variant])];
    return {p, family, distinct, name};
  });
}

/** Score a phrase against a product. 0 = no match. */
function score(ph: PoPhrase, pr: Prepared, rare: Map<string, number>): number {
  const headingT = tokens(ph.heading ?? '', STOP);
  const shadeT = tokens(ph.shade ?? '', STOP_SHADE);
  const lineT = [...tokens(ph.heading ?? '', STOP_SHADE), ...shadeT];
  const famCov = pr.family.length ? covered(pr.family, headingT) / pr.family.length : 0;

  if (pr.distinct.length === 0) {
    // A one-product family ("Hydro Blurring Primer"): the heading names it, no shade.
    const cov = covered(pr.name, lineT) / Math.max(1, pr.name.length);
    return cov >= 0.75 && famCov >= 0.6 ? 1 + cov + famCov : 0;
  }

  // Every distinctive word of the product should be on the printed line. A short printed
  // name inside a longer catalog name ("Beauty Sponge" for "Beauty Sponge Big Yellow")
  // counts too, at a lower score.
  const hitsAny = covered(pr.distinct, lineT);
  let partial = 0;
  if (hitsAny < pr.distinct.length) {
    const words = shadeT.filter((w) => !/^\d+$/.test(w)); // "#9717 Naturally Beautiful"
    const inside = words.length >= 2 && covered(words, pr.distinct) === words.length;
    // An accessory named by one word no other product has: "Extractor ( Stainless Steel )"
    // is the catalog's only extractor, whatever the rest of the line says.
    const accessory = /^accessories$/i.test(ph.heading ?? '') && /^accessories$/i.test((pr.p.product_line ?? '').trim());
    const onlyOne = accessory && shadeT[0]?.length >= 6 && pr.distinct[0] === shadeT[0] && rare.get(shadeT[0]) === 1;
    if (!(inside && hitsAny / pr.distinct.length >= 0.5) && !onlyOne) return 0;
    partial = onlyOne ? 1.2 : 0.6;
  }
  // And the printed shade shouldn't carry words the product lacks (e.g. "#802 M. Brown"
  // must not match plain "803 Brown").
  const extra = ph.shade ? shadeT.length - covered(shadeT, pr.distinct) - Math.min(covered(shadeT, pr.family), Math.max(0, shadeT.length - pr.distinct.length)) : 0;
  const shadeFit = ph.shade ? 1 - extra / Math.max(1, shadeT.length) : 0.5;

  // A shade with no family evidence only counts when its words are rare in the catalog
  // ("Amber", "Classic Mint"), so "Natural" can't drift to another family.
  const rarity = Math.min(...pr.distinct.map((w) => rare.get(w) ?? 1));
  if (famCov < 0.34 && !(rarity === 1 || pr.distinct.length >= 2)) return 0;
  return 1 + famCov * 2 + shadeFit + (rarity === 1 ? 0.25 : 0) + Math.min(pr.distinct.length, 3) * 0.05 - partial;
}

/**
 * Match phrases to catalog products, one product per phrase and one phrase per product,
 * best scores first. Retired products are still matchable: the form can bring one back.
 */
export function matchPoForm(phrases: PoPhrase[], catalog: CatalogProduct[]): PoFormResult {
  const prepared = prepare(catalog);
  const rare = new Map<string, number>();
  for (const pr of prepared) for (const w of new Set(pr.distinct)) rare.set(w, (rare.get(w) ?? 0) + 1);

  const pairs: Array<{i: number; j: number; s: number}> = [];
  phrases.forEach((ph, i) => {
    prepared.forEach((pr, j) => {
      const s = score(ph, pr, rare);
      if (s > 0) pairs.push({i, j, s});
    });
  });
  pairs.sort((a, b) => b.s - a.s || a.i - b.i);
  const usedP = new Set<number>();
  const usedC = new Set<number>();
  const matches: PoMatch[] = [];
  for (const {i, j, s} of pairs) {
    if (usedP.has(i) || usedC.has(j)) continue;
    usedP.add(i);
    usedC.add(j);
    matches.push({item_code: prepared[j].p.item_code, phrase: phrases[i], score: Math.round(s * 100) / 100});
  }
  // A heading line that only introduces shades below it isn't "unmatched".
  const headingsWithShades = new Set(phrases.filter((p) => p.shade).map((p) => p.heading));
  const matchedFamilies = [...usedC].map((j) => prepared[j].family).filter((f) => f.length);
  const namesAFamily = (p: PoPhrase) => {
    const t = tokens(p.heading ?? '', STOP);
    return matchedFamilies.some((f) => covered(f, t) / f.length >= 0.75);
  };
  const unmatched = phrases.filter((p, i) => !usedP.has(i) && !(p.shade == null && (headingsWithShades.has(p.heading) || namesAFamily(p))));
  return {matches: matches.sort((a, b) => a.item_code.localeCompare(b.item_code)), unmatched};
}
