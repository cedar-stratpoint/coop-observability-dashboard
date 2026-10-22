// F11 (Slice 6 #1): the number-in-result check. A pure function: given the text of an answer and the tool results the
// model saw this turn, list every displayed figure that appears in none of them. It is a LOG-ONLY safety net behind the
// rule "the model never computes or invents a number" (the model never types a number into a block; this covers the
// prose). It never changes or blocks an answer; the loop (loop.ts) only logs what it finds (audit.ts logNumberViolation).
// Design: knowledge/architecture/2026-10-01-talk-to-data-design.md § 7 (Slice 6) and § 8.
//
// WHAT COUNTS AS A DISPLAYED FIGURE (extracted from the answer, in this order):
//   - a peso amount: "₱71,050", "₱2,367.26", "PHP 1,200", "₱71.1k", "₱1.2M" (any size, including 1 digit);
//   - a percentage: "66.4%", "5 %" (any size);
//   - a ratio: "3.9×", "3.9x" (any size);
//   - a plain count of 2 or more digits ("1,352", "36"), or any plain decimal ("595.45").
//   Single plain digits (3 orders) and the words one to ten are never checked: they are counting, not reporting a result.
//   Exception, Explore enforce mode only (`countNouns`): a single digit followed by order(s), lead(s), sign-up(s), event(s), customer(s),
//   unit(s), item(s), pack(s) or bundle(s) is checked (live test 4: "6 orders" was two cells added in the model's head, the true figure was 7).
//
// WHAT IS IGNORED (not a claim about the data):
//   dates and ranges ("Sep 11 to 27", "11 Sep", "2026-09-27", "9/27"), times, years (1900 to 2099 written plain),
//   ordinals (21st), list numbering ("1."), ids ("#1042", "SKU 12", "b3" and "r2" never match: they start with a letter),
//   numbers glued to letters ("80g", "5kg"), the figure 0, the text inside <go> and <suggest> tags, and every number that
//   is in `context` (the user's question and earlier turns, the per-turn preamble, the selected-period digest block):
//   figures the person or the app already gave are not new claims.
//
// WHAT COUNTS AS "APPEARS IN A TOOL RESULT" (the tolerances):
//   A displayed figure v with `d` decimals shown (and a scale of 1, 1,000 or 1,000,000 for k / M) matches a source number n
//   when n rounded to the shown precision, or n truncated to it, equals v. So "₱71,050" matches 71050 and 71049.6;
//   "66%" matches 66.4; "₱2,367.26" needs 2367.26 to the centavo (not 2367.3 or 2367). The sign is ignored (a drop of 12.9%
//   matches -12.88). A percentage also matches n * 100 (a share held as a fraction). The kind (peso, percent, ratio, count)
//   is NOT matched against the source column: a figure only has to appear, in any form above, anywhere in the results.
//   The source numbers are every number in the results, numbers inside strings included (check and insight texts quote
//   pesos, shares and ratios), with thousands separators removed.
//
// DERIVED FIGURES (the model may calculate, see the guardrail "calculated, with the working shown"): an unmatched figure is not a violation
//   when it is `derived_verified`: it equals, at the precision it shows, a sum, a difference, an average, a ratio (a / b), a share
//   (a / b as a percent) or a percent change ((b - a) / a) of OPERANDS THAT THE ANSWER ITSELF SHOWS and that are themselves grounded
//   (found in a tool result or in `context`, or already derived_verified). Operands must be figures of the answer, not any numbers
//   of the results: a check over every tool-result number accepts coincidences (1,352 + 1 = 1,353 from an id "r1"), the answer's own
//   working line is the thing being checked. Sums, differences and averages need operands of the same kind (peso with peso, count with
//   count, percent with percent); a ratio, share or percent change needs two operands of one kind. The sign is ignored, like the match
//   above. CAPS (the search is bounded): at most DERIVE_MAX_OPERANDS (12) operands are tried, subsets of 2 to DERIVE_MAX_SUBSET (6)
//   figures, two rounds so a derived total can feed a derived share. It never blocks: a figure that is not derivable stays a violation
//   and is logged exactly as before.
//
// KNOWN LIMITS: a figure the model derived that happens to equal an unrelated source number passes; "2020 orders" written
// plain reads as a year and is skipped; number words are never checked. Good enough for a log-only net; the real guard is
// that figures come from tool calls (the golden set and live eval read the wording).

export interface NumberViolation {
  /** The figure exactly as the answer displayed it, e.g. "₱71,050" or "66.4%". */
  value: string;
  /** A short slice of the surrounding text, for a human reading the log of an eval (the loop never logs it). */
  context: string;
}

/** A displayed figure that is not in any tool result but is the verified result of arithmetic over figures the answer shows. */
export interface DerivedFigure {
  /** The figure exactly as the answer displayed it. */
  value: string;
  op: 'sum' | 'difference' | 'average' | 'ratio' | 'share' | 'percent_change';
  /** The operands as the answer displayed them, in the order used (a, b for difference, ratio, share and percent change). */
  operands: string[];
}

export interface NumberCheckResult {
  /** How many displayed figures were checked (after the ignore rules). */
  checked: number;
  /** Each figure with no equivalent in the tool results and no verified derivation; the same display string is listed once. */
  violations: NumberViolation[];
  /** Figures that are not in a tool result but equal verified arithmetic over grounded figures of the answer (not violations). Absent when none. */
  derived?: DerivedFigure[];
}

export interface NumberCheckOptions {
  /** Text whose figures are not new claims: the user's question, earlier turns, the preamble, the digest block. */
  context?: string;
  /**
   * Explore enforce mode: also check a single plain digit when a count noun follows it ("6 orders", "2 leads"), because a model that adds
   * two cells in its head types a small figure that is in no row. Words ("six") and digits before other nouns ("2 spellings") stay unchecked.
   */
  countNouns?: boolean;
}

interface Figure {
  raw: string;
  value: number;
  /** The size of the last displayed place, e.g. 0.01 for "₱2,367.26", 1 for "36", 1000 for "₱71k". */
  unit: number;
  kind: 'peso' | 'percent' | 'ratio' | 'count';
  index: number;
}

const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DAY = '\\d{1,2}(?:st|nd|rd|th)?(?!\\d)';
const SPAN = `(?:\\s*(?:to|-|–|—|and)\\s*${DAY})?`;

// Patterns blanked out of the answer (same length, so figure positions stay true) before figures are read.
const NOISE: RegExp[] = [
  /<(go|suggest)>[\s\S]*?<\/\1>/gi,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  new RegExp(`\\b${MONTH}\\.?\\s+${DAY}${SPAN}(?:,?\\s*\\d{4})?`, 'gi'),
  new RegExp(`\\b${DAY}${SPAN}\\s+${MONTH}\\b(?:,?\\s*\\d{4})?`, 'gi'),
  /\b\d{1,2}:\d{2}(?:\s?[ap]m)?\b/gi,
  /\b\d{1,2}\s?[ap]m\b/gi,
  /\b\d+(?:st|nd|rd|th)\b/gi,
  /(?<![\d,.₱])(?:19|20)\d{2}(?!\d|,\d|\.\d|\s?%|\s?[×x]\b)/g,
  /^[ \t]*\d+[.)](?=\s)/gm,
  /#\d+/g,
  /\bSKU\s+\d+/gi,
];

// The nouns that make a single digit a reported count (Explore enforce mode only): "6 orders", "2 sign-ups".
const COUNT_NOUN = /^\s+(?:orders?|leads?|sign-?ups?|events?|customers?|units?|items?|packs?|bundles?)\b/i;

const blank = (s: string): string => s.replace(/[^\n]/g, ' ');

function figuresIn(answer: string, countNouns = false): Figure[] {
  let masked = answer;
  for (const re of NOISE) masked = masked.replace(re, blank);
  const out: Figure[] = [];
  // prefix (peso sign) | integer with or without thousands separators | decimals | suffix (% × x k M)
  const re = /(₱\s?|PHP\s?|Php\s?)?(?<![A-Za-z0-9_])(?<!\d[.,])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s?(%|×)|([xX])(?![A-Za-z0-9])|([kKmM])(?![A-Za-z0-9]))?/gu;
  for (const m of masked.matchAll(re)) {
    const [raw, prefix, whole, frac, tail, times, scaleLetter] = m;
    const next = masked[(m.index ?? 0) + raw.length];
    const suffixed = tail !== undefined || times !== undefined || scaleLetter !== undefined;
    if (!suffixed && next !== undefined && /[A-Za-z]/.test(next)) continue; // "80g", "5kg": a unit, not a figure
    const digits = whole.replace(/,/g, '');
    const decimals = frac ? frac.length - 1 : 0;
    const scale = scaleLetter === undefined ? 1 : /[kK]/.test(scaleLetter) ? 1e3 : 1e6;
    const value = Number(`${digits}${frac ?? ''}`) * scale;
    const kind: Figure['kind'] = prefix ? 'peso' : tail === '%' ? 'percent' : tail === '×' || times !== undefined ? 'ratio' : 'count';
    if (value === 0) continue;
    // A plain number is a reported figure only with 2+ integer digits or a decimal part.
    const counted = countNouns && COUNT_NOUN.test(masked.slice((m.index ?? 0) + raw.length, (m.index ?? 0) + raw.length + 14));
    if (kind === 'count' && scaleLetter === undefined && digits.length < 2 && decimals === 0 && !counted) continue;
    out.push({raw: raw.trim(), value, unit: scale * 10 ** -decimals, kind, index: m.index ?? 0});
  }
  return out;
}

const NUMBER_IN_TEXT = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/** Every number in the results, as absolute values: numbers, and numbers inside strings (JSON text is parsed first). */
function sourceNumbers(results: unknown[]): number[] {
  const out: number[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'number') {
      if (Number.isFinite(v)) out.push(Math.abs(v));
    } else if (typeof v === 'string') {
      const t = v.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          walk(JSON.parse(t));
          return;
        } catch {
          // not JSON after all: read it as text
        }
      }
      for (const m of v.matchAll(NUMBER_IN_TEXT)) out.push(Number(m[0].replace(/,/g, '')));
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v !== null && typeof v === 'object') {
      Object.values(v as Record<string, unknown>).forEach(walk);
    }
  };
  results.forEach(walk);
  return out;
}

/** `n` shown at the figure's precision, rounded or truncated, equals the figure. */
function shows(n: number, f: Figure): boolean {
  const want = Math.round(f.value / f.unit);
  const scaled = n / f.unit;
  return Math.round(scaled) === want || Math.trunc(scaled + 1e-9) === want;
}

/** Caps of the derived-figure search (see DERIVED FIGURES above). */
export const DERIVE_MAX_OPERANDS = 12;
export const DERIVE_MAX_SUBSET = 6;

function subsets<T>(items: readonly T[], min: number, max: number, visit: (picked: T[]) => boolean): boolean {
  const pick: T[] = [];
  const go = (from: number): boolean => {
    if (pick.length >= min && visit(pick)) return true;
    if (pick.length === max) return false;
    for (let i = from; i < items.length; i += 1) {
      pick.push(items[i]);
      if (go(i + 1)) return true;
      pick.pop();
    }
    return false;
  };
  return go(0);
}

/** Does `f` equal arithmetic over `pool` (figures of the same answer)? Returns the derivation, or null. */
function derive(f: Figure, pool: readonly Figure[]): DerivedFigure | null {
  const same = pool.filter((o) => o !== f && o.raw !== f.raw && o.kind === f.kind).slice(0, DERIVE_MAX_OPERANDS);
  const done = (op: DerivedFigure['op'], operands: Figure[]): DerivedFigure => ({value: f.raw, op, operands: operands.map((o) => o.raw)});
  // sum and average of 2 to 6 operands of the same kind; a difference of two
  let found: DerivedFigure | null = null;
  subsets(same, 2, DERIVE_MAX_SUBSET, (pick) => {
    const total = pick.reduce((t, o) => t + o.value, 0);
    if (shows(total, f)) {
      found = done('sum', pick);
      return true;
    }
    if (shows(total / pick.length, f)) {
      found = done('average', pick);
      return true;
    }
    return false;
  });
  if (found) return found;
  for (const a of same) {
    for (const b of same) {
      if (a === b) continue;
      if (shows(Math.abs(a.value - b.value), f)) return done('difference', [a, b]);
    }
  }
  // ratio, share and percent change need two operands of one kind (any kind except the figure's own for a ratio or share)
  const kinds = pool.filter((o) => o !== f && o.raw !== f.raw).slice(0, DERIVE_MAX_OPERANDS);
  for (const a of kinds) {
    for (const b of kinds) {
      if (a === b || a.kind !== b.kind || b.value === 0) continue;
      if (f.kind === 'ratio' && shows(a.value / b.value, f)) return done('ratio', [a, b]);
      if (f.kind === 'percent' && shows((a.value / b.value) * 100, f)) return done('share', [a, b]);
      if (f.kind === 'percent' && a.value !== 0 && shows((Math.abs(b.value - a.value) / a.value) * 100, f)) return done('percent_change', [a, b]);
    }
  }
  return null;
}

export function checkNumbers(answerText: string, toolResults: unknown[], opts: NumberCheckOptions = {}): NumberCheckResult {
  const figures = figuresIn(answerText, opts.countNouns);
  if (figures.length === 0) return {checked: 0, violations: []};
  const source = sourceNumbers(toolResults);
  const given = (opts.context ?? '').match(NUMBER_IN_TEXT)?.map((s) => Number(s.replace(/,/g, ''))) ?? [];
  const ok = (f: Figure, pool: number[]): boolean => pool.some((n) => shows(n, f) || (f.kind === 'percent' && shows(n * 100, f)));
  const grounded: Figure[] = [];
  const open: Figure[] = [];
  for (const f of figures) (ok(f, source) || ok(f, given) ? grounded : open).push(f);
  // Derived figures: two rounds, so a verified total can be an operand of a verified share.
  const derived: DerivedFigure[] = [];
  const verified = new Set<Figure>();
  for (let round = 0; round < 2 && open.length > verified.size; round += 1) {
    for (const f of open) {
      if (verified.has(f)) continue;
      const d = derive(f, grounded);
      if (!d) continue;
      verified.add(f);
      grounded.push(f);
      if (!derived.some((x) => x.value === d.value)) derived.push(d);
    }
  }
  const seen = new Set<string>();
  const violations: NumberViolation[] = [];
  for (const f of open) {
    if (verified.has(f) || seen.has(f.raw)) continue;
    seen.add(f.raw);
    const from = Math.max(0, f.index - 30);
    violations.push({value: f.raw, context: answerText.slice(from, f.index + f.raw.length + 30).replace(/\s+/g, ' ').trim()});
  }
  return derived.length > 0 ? {checked: figures.length, violations, derived} : {checked: figures.length, violations};
}
