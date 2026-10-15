// The value scanner (spec 2.2, layer 4): the one layer that does not trust names. Before result rows reach the model or the stored
// result, secret-SHAPED values are replaced with [hidden]: JWTs, common API key formats, PEM blocks, password hashes, credential URLs,
// token query strings, long hex, long mixed letter-digit and base64 runs, and any JSON value under a secret-named key. Pure.
// JSON is judged STRUCTURALLY wherever it can be (Task 7 re-review R2, the default-deny lesson: no regex standing in for a parser):
// every complete JSON object, array or string literal inside a text value is found by a bracket scan that respects string literals and
// escapes, JSON.parse'd, and scrubbed by the key rule on the parsed value (the WHOLE value under a secret key is hidden, objects and
// arrays included; \u-escaped keys are decoded by the parse). A string literal that holds JSON (double-encoded) is decoded and scanned
// again, up to MAX_JSON_DEPTH.
// The scan is bounded (MAX_SCAN_CHARS, MAX_STEPS, MAX_SPANS, MAX_JSON_DEPTH, MAX_NEST per cell) and every bound FAILS CLOSED (Task 7
// re-review round 2 N1): text the structural pass did not judge is hidden, never handed to the text rules. A cell longer than
// MAX_SCAN_CHARS is cut there first (the rest hidden), so no rule ever sees more than that; a cut that would split a run of token
// characters moves back to the start of that run, so no readable prefix of a token is ever left (round 3 K2). The "name": value pair
// rules are only the fallback for JSON cut short inside an otherwise scanned cell (left(x::text, n)), and they hide to the end whenever
// they cannot see where the value ends. Every rule is linear in the cell length (round 2 N4): no rule rescans a run from every position.
// Secret JSON keys use isSecretJsonKey (camelCase aware, Task 7 re-review R1; credential header names, round 2 N3).
// Object KEYS of a parsed value are scanned like values (round 3 K1): a jsonb column arrives from the driver already parsed, so a map
// keyed by a device, push or session token ({devices: {"<jwt>": {...}}}) would otherwise reach the model with the key in clear, while
// the same value read as ::text was hidden. Rewritten objects have no prototype (Object.create(null)), so a __proto__ key survives (N6).
// Runs are bounded by "not a letter or digit" (never \b: `_` is a word character, so `key_<hex>` would slip past, Task 7 review).
// False positives are accepted on purpose (a 32-hex device id), but the shapes are chosen so ordinary data is never hit: a uuid's
// hex groups are short, digit-only strings (order numbers, phones) need a letter, SKUs are upper-case, and dashes break a run.
// The scanner bounds ACCIDENTAL exposure only: SQL string functions can cut a value into pieces below every threshold
// (knowledge/best-practices/chat-direct-read-access.md section 7). The name rule and the column review are the real controls.
import {isSecretJsonKey} from './secret-names';

export const HIDDEN = '[hidden]';

const B = '(?<![A-Za-z0-9])'; // start of a run: not after a letter or digit
const E = '(?![A-Za-z0-9])'; // end of a run

/** Structural-scan bounds, per cell. Past any of them the unjudged rest is hidden (fail closed). */
const MAX_SCAN_CHARS = 100_000; // a longer cell is cut here before any rule runs (the byte cap shows at most 256 KiB anyway)
const MAX_STEPS = 1_000_000; // characters the bracket matching and parsing may visit in total
const MAX_SPANS = 200; // JSON objects, arrays and JSON-holding strings parsed
const MAX_JSON_DEPTH = 5; // JSON inside a JSON string inside ... (deeper and still JSON-looking: hidden)
const MAX_NEST = 256; // object / array nesting of a parsed value (deeper: hidden, instead of a stack overflow)

const decodeKey = (k: string): string => k.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));

type Scrubbed = {value: unknown; hidden: number};
type Step = (s: string) => {value: string; hidden: number};

/** A regex rule: replace returns null to keep the match as it is. */
const rule = (re: RegExp, replace: (m: string, ...g: string[]) => string | null): Step => (s) => {
  let hidden = 0;
  const value = s.replace(re, (m: string, ...g: unknown[]) => {
    const r = replace(m, ...(g.slice(0, -2) as string[])); // drop offset and input
    if (r === null) return m;
    hidden += 1;
    return r;
  });
  return {value, hidden};
};
const whole = (re: RegExp): Step => rule(re, () => HIDDEN);
/** A whole run, hidden only when test passes: the run is matched once (no lookahead rescanning it from every position, N4). */
const run = (re: RegExp, test: (m: string) => boolean): Step => rule(re, (m) => (test(m) ? HIDDEN : null));
const has = (re: RegExp) => (m: string) => re.test(m);

/**
 * The cut-short fallback: a "name": in JSON text, at any escape level (\"name\" inside a JSON string, \\\"name\\\" one deeper), or
 * ""name"": in a row literal. Only the name and the separator are matched; the value is read by hand, so a pair that is kept never
 * swallows the text after it (an object value under a plain key is still searched). Keys: any length (round 3 K3), any character but
 * a bare quote or newline ($token, lazada:token, @token; N2), with backslash escapes (\_, \", \n, \uXXXX, \\) read as two characters.
 * An escape never swallows the CLOSING quote of its own level: each key character is guarded by (?!<close>), so at level 1 the key
 * `token` in \"token\":\"x\",\"shop\": ends at its own \", never at the last one (a merged key would hide the wrong value).
 */
const keyBody = (close: string) => String.raw`((?:(?!${close})(?:\\.|[^"\\\n]))+)`;
const PAIR_KEY = new RegExp(String.raw`(?<![\\"])(\\*)"${keyBody(String.raw`\1"`)}\1"\s*:\s*`, 'g');
const ROW_KEY = new RegExp(String.raw`""${keyBody('""')}""\s*:\s*`, 'g');
const ROW_VALUE_END = /""(?=\s*(?:[,}\])]|$))/g;
const BARE = /-?[^\s,}\])"]+/y;

/** End of the value at p and what to put there, or null to keep it. end = s.length hides to the end of the text. */
function secretValue(s: string, p: number, bs: string, row: boolean): {end: number; put: string} | null {
  const q = row ? '""' : `${bs}"`;
  if (s.startsWith('null', p) || s.startsWith(q + q, p) || s.startsWith(q + HIDDEN + q, p)) return null; // nothing to hide, or done
  if (p >= s.length) return null;
  const toEnd = {end: s.length, put: HIDDEN};
  if (bs !== '') return toEnd; // inside an escaped string the parse could not take: where the value ends is not knowable, hide to the end
  if (s[p] === '{' || s[p] === '[') return toEnd; // an object or array the parse could not take (cut short)
  if (s.startsWith(q, p)) {
    if (row) {
      ROW_VALUE_END.lastIndex = p + 2;
      const m = ROW_VALUE_END.exec(s);
      return m ? {end: m.index + 2, put: `""${HIDDEN}""`} : toEnd;
    }
    for (let j = p + 1; j < s.length; j++) {
      if (s[j] === '\\') j += 1;
      else if (s[j] === '"') return {end: j + 1, put: `"${HIDDEN}"`};
    }
    return toEnd; // unterminated: hidden to the end (N2)
  }
  BARE.lastIndex = p;
  const m = BARE.exec(s);
  return m ? {end: p + m[0].length, put: HIDDEN} : null;
}

const pairs = (row: boolean): Step => (s) => {
  const re = row ? ROW_KEY : PAIR_KEY;
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let hidden = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const [bs, name] = row ? ['', m[1]] : [m[1], m[2]];
    if (!isSecretJsonKey(decodeKey(name))) continue;
    const p = re.lastIndex;
    const v = secretValue(s, p, bs, row);
    if (v === null) continue;
    out += s.slice(last, p) + v.put;
    last = v.end;
    hidden += 1;
    if (v.end >= s.length) break;
    re.lastIndex = v.end;
  }
  return hidden === 0 ? {value: s, hidden} : {value: out + s.slice(last), hidden};
};

/** JWTs, found by splitting each dotted run once (a regex from every "eyJ" would rescan the run each time, N4). */
const jwts: Step = (s) => {
  let hidden = 0;
  const value = s.replace(/(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]{3,}/g, (m) => {
    if (!m.includes('eyJ')) return m;
    const seg = m.split('.');
    const out: string[] = [];
    for (let i = 0; i < seg.length; i++) {
      const k = seg[i].indexOf('eyJ');
      if (k >= 0 && seg[i].length - k - 3 >= 8 && (seg[i + 1]?.length ?? 0) >= 8 && (seg[i + 2]?.length ?? 0) >= 8) {
        out.push(seg[i].slice(0, k) + HIDDEN);
        hidden += 1;
        i += 2;
      } else out.push(seg[i]);
    }
    return out.join('.');
  });
  return {value, hidden};
};

const STEPS: readonly Step[] = [
  // structure-keeping rules first: they hide the value and keep the name, so the row still reads
  rule(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s@/]+@/gi, (_m, scheme) => `${scheme}${HIDDEN}@`), // scheme://user:pass@
  pairs(false), // "name": value in JSON text cut short
  pairs(true), // the same in a row literal, where every quote is doubled: ("{""token"": ""x""}")
  rule(/(^|[?&;\s])([A-Za-z][A-Za-z0-9_.-]*)=([^&\s#"']+)/g, (_m, pre, name) => (isSecretJsonKey(name) ? `${pre}${name}=${HIDDEN}` : null)), // ?access_token=, &sign=
  whole(/\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{40,}/g), // bcrypt
  whole(/\$argon2(?:id|i|d)\$[^\s"']{10,}/g), // argon2
  whole(/\$[156]\$(?:rounds=\d+\$)?[^\s$]{1,16}\$[./A-Za-z0-9]{20,}/g), // crypt md5 / sha256 / sha512
  jwts, // JWT
  whole(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g), // any PEM block (a truncated one is hidden to the end)
  whole(new RegExp(`${B}(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}`, 'g')), // Stripe-style
  whole(new RegExp(`${B}sk-[A-Za-z0-9_-]{16,}`, 'g')), // OpenAI / Anthropic style
  whole(new RegExp(`${B}sb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}`, 'g')), // Supabase
  whole(new RegExp(`${B}(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}`, 'g')), // GitHub
  whole(new RegExp(`${B}shp(?:at|ss|ca|pa)_[A-Za-z0-9]{16,}`, 'g')), // Shopify Admin / app tokens
  run(new RegExp(`${B}re_[A-Za-z0-9_]{16,}`, 'g'), has(/\d/)), // Resend (a digit required: re_order_settings stays)
  whole(new RegExp(`${B}AIza[0-9A-Za-z_-]{30,}`, 'g')), // Google API key
  whole(new RegExp(`${B}GOCSPX-[A-Za-z0-9_-]{20,}`, 'g')), // Google OAuth client secret
  whole(new RegExp(`${B}glpat-[A-Za-z0-9_-]{20,}`, 'g')), // GitLab
  whole(new RegExp(`${B}xox[abeprs]-[A-Za-z0-9-]{10,}`, 'g')), // Slack
  whole(new RegExp(`${B}AKIA[0-9A-Z]{16}${E}`, 'g')), // AWS access key id
  run(/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}/g, (m) => /\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m) && (m.includes('+') || m.endsWith('='))), // base64 with + or =
  run(new RegExp(`${B}[0-9a-fA-F]{32,}${E}`, 'g'), has(/[a-fA-F]/)), // raw hex tokens and hashes (a-f letter needed: digit strings stay)
  run(new RegExp(`${B}[A-Za-z0-9]{32,}${E}`, 'g'), (m) => /\d/.test(m) && /[a-z]/.test(m)), // 32+ with a digit and a lower-case letter (app secrets)
  run(new RegExp(`${B}[A-Za-z0-9]{40,}${E}`, 'g'), (m) => /\d/.test(m) && /[A-Za-z]/.test(m)), // long opaque tokens (Lazada style)
];

function scrubPlain(s: string): {value: string; hidden: number} {
  let hidden = 0;
  let out = s;
  for (const step of STEPS) {
    const r = step(out);
    out = r.value;
    hidden += r.hidden;
  }
  return {value: out, hidden};
}

type Budget = {steps: number};

/** End index of the complete JSON object, array or string literal that starts at i, or -1 (unbalanced, or out of budget). */
function spanEnd(s: string, i: number, b: Budget): number {
  const stack: string[] = [];
  let inStr = s[i] === '"';
  if (!inStr) stack.push(s[i]);
  for (let j = i + 1; j < s.length; j++) {
    if (--b.steps < 0) return -1;
    const c = s[j];
    if (inStr) {
      if (c === '\\') j += 1;
      else if (c === '"') {
        inStr = false;
        if (stack.length === 0) return j; // the span was the string literal itself
      }
    } else if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') {
      if (stack.pop() !== (c === '}' ? '{' : '[')) return -1;
      if (stack.length === 0) return j;
    }
  }
  return -1;
}


/** A character that can be part of a token run in any rule (letters, digits, base64 and JWT symbols, hash `$`, URL `:/@%`). */
const RUN_CHAR = /[A-Za-z0-9+/=_.:$@%-]/;

function scrubText(s: string, depth: number, b: Budget): {value: string; hidden: number} {
  if (depth > MAX_JSON_DEPTH && /[{[]/.test(s)) return {value: HIDDEN, hidden: 1}; // JSON past the decode bound: not judged, hidden
  let hidden = 0;
  let tail = ''; // the hidden marker for text the structural pass did not judge
  let text = s;
  if (text.length > MAX_SCAN_CHARS) {
    // cut BEFORE any rule runs: nothing past this is judged, so it is hidden. A cut inside a run of token characters would leave the
    // run's prefix readable, under every length threshold (K2): move the cut back to the start of that run (a plain loop, linear).
    let cut = MAX_SCAN_CHARS;
    if (RUN_CHAR.test(text[cut])) while (cut > 0 && RUN_CHAR.test(text[cut - 1])) cut -= 1;
    text = text.slice(0, cut);
    tail = HIDDEN;
    hidden += 1;
  }
  const parts: string[] = [];
  let last = 0;
  let spans = 0;
  let stop = -1; // where a bound stopped the pass: nothing from the next span start on was judged
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== '{' && c !== '[' && c !== '"') continue;
    if (b.steps <= 0 || spans >= MAX_SPANS) {
      stop = i;
      break;
    }
    const end = spanEnd(text, i, b);
    if (end < 0 && b.steps < 0) {
      stop = i; // out of budget inside this span: it was not judged
      break;
    }
    if (end < 0) continue; // cut short: an inner span may still be complete, and the pair fallback sees the rest
    const raw = text.slice(i, end + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // not JSON (a row literal, prose in brackets): inner spans and the text rules still see it
    }
    b.steps -= raw.length;
    let r: Scrubbed;
    if (typeof parsed === 'string') {
      if (!/[{[]/.test(parsed)) {
        i = end; // a plain string literal: nothing structural inside
        continue;
      }
      spans += 1;
      r = scrubText(parsed, depth + 1, b); // a string holding JSON (double-encoded): decode and scan again
      if (r.hidden === 0) continue; // the quote may have been misread (row text): keep scanning inside it
    } else {
      spans += 1;
      r = scrub(parsed, depth + 1, b, 0);
      if (r.hidden === 0) {
        i = end;
        continue;
      }
    }
    parts.push(text.slice(last, i), JSON.stringify(r.value));
    hidden += r.hidden;
    last = end + 1;
    i = end;
  }
  if (stop >= 0) {
    // a bound stopped the pass at a span start: from there on the text was not judged, so it is hidden (N1), never left to the
    // text rules
    text = text.slice(0, stop);
    if (tail === '') hidden += 1;
    tail = HIDDEN;
  }
  const out = (parts.length > 0 ? parts.join('') : '') + text.slice(last);
  const p = scrubPlain(out); // shape rules everywhere, and the pair fallback for JSON cut short
  return {value: p.value + tail, hidden: hidden + p.hidden};
}

function scrub(v: unknown, depth: number, b: Budget, nest: number): Scrubbed {
  if (typeof v === 'string') return scrubText(v, depth, b);
  if (v === null || typeof v !== 'object') return {value: v, hidden: 0};
  if (nest >= MAX_NEST) return {value: HIDDEN, hidden: 1}; // nested past the bound: not judged, hidden (N5)
  if (Array.isArray(v)) {
    let hidden = 0;
    const value = v.map((x) => {
      const r = scrub(x, depth, b, nest + 1);
      hidden += r.hidden;
      return r.value;
    });
    return {value, hidden};
  }
  let hidden = 0;
  const value: Record<string, unknown> = Object.create(null); // no prototype: a __proto__ key is stored, not interpreted (N6)
  const lastSuffix = new Map<string, number>(); // per base key, the last suffix used: N keys hidden to one marker cost O(N), not O(N^2)
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const kr = scrubText(k, depth, b); // the key is text too (K1): a token-shaped key, or JSON holding a secret, is hidden like a value
    hidden += kr.hidden;
    let key = kr.value;
    if (key in value) {
      // two keys hidden to the same marker: keep both entries. Resume from the last suffix; skip one a literal key already holds.
      let n = lastSuffix.get(kr.value) ?? 1;
      do key = `${kr.value} ${(n += 1)}`; while (key in value);
      lastSuffix.set(kr.value, n);
    }
    if (isSecretJsonKey(k) && x !== null && x !== undefined && x !== '') {
      value[key] = HIDDEN;
      hidden += 1;
    } else {
      const r = scrub(x, depth, b, nest + 1);
      value[key] = r.value;
      hidden += r.hidden;
    }
  }
  return {value, hidden};
}

/** Scrub one value (a cell): a fresh scan budget per call. */
export const scrubValue = (v: unknown): Scrubbed => scrub(v, 0, {steps: MAX_STEPS}, 0);

export function scrubRows(rows: unknown[][]): {rows: unknown[][]; hidden: number} {
  let hidden = 0;
  const out = rows.map((r) =>
    r.map((cell) => {
      const s = scrubValue(cell);
      hidden += s.hidden;
      return s.value;
    }),
  );
  return {rows: out, hidden};
}
