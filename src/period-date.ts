// The reader returns a form's period as it saw it written ("10/16/2026", "SEPTEMBER 16, 2026",
// "Oct 16 2024", "06-16"), not the YYYY-MM-DD an <input type="date"> needs. A non-ISO value
// makes the browser blank the box, so the review showed empty period fields. This turns the
// common written shapes into YYYY-MM-DD, and returns null for anything it can't read safely
// (better an honest empty box than a guessed date). Pure.

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** 1..12 for a month name or a real abbreviation of one ("Sept", "Oct."), else null. A word
 *  that only starts like a month ("Octember") is not one. */
function monthOf(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, '');
  if (w.length < 3) return null;
  const i = MONTH_NAMES.findIndex((name) => name.startsWith(w));
  return i >= 0 ? i + 1 : null;
}

function build(y: number, m: number, d: number): string | null {
  if (!(y >= 2000 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  // Reject impossible days (Sep 31) rather than let the date input roll them over.
  if (d > new Date(y, m, 0).getDate()) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

/** A written period date as YYYY-MM-DD, or null. `fallbackYear` fills a date written
 *  without a year ("06-16"); without it such a date stays null. */
export function toIsoDate(raw: string | null | undefined, fallbackYear?: number | null): string | null {
  const s = raw?.trim();
  if (!s) return null;
  let m: RegExpExecArray | null;
  // 2024-10-16 (also 2024/10/16)
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s))) return build(Number(m[1]), Number(m[2]), Number(m[3]));
  // 10/16/2024, 10-16-24 (month first: how the Goldline forms are written)
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s))) return build(fullYear(m[3]), Number(m[1]), Number(m[2]));
  // 10/16, 06-16 (no year)
  if ((m = /^(\d{1,2})[-/.](\d{1,2})$/.exec(s))) return fallbackYear ? build(fallbackYear, Number(m[1]), Number(m[2])) : null;
  // SEPTEMBER 16, 2026 · Oct 16 2024 · Oct. 16
  if ((m = /^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{2}|\d{4}))?$/.exec(s))) {
    const mo = monthOf(m[1]);
    const y = m[3] ? fullYear(m[3]) : fallbackYear;
    return mo && y ? build(y, mo, Number(m[2])) : null;
  }
  // 16 October 2024
  if ((m = /^(\d{1,2})\s+([A-Za-z]+)\.?,?(?:\s+(\d{2}|\d{4}))?$/.exec(s))) {
    const mo = monthOf(m[2]);
    const y = m[3] ? fullYear(m[3]) : fallbackYear;
    return mo && y ? build(y, mo, Number(m[1])) : null;
  }
  return null;
}

/** The first value that is already a valid YYYY-MM-DD, else the first raw one that converts. */
export function firstIsoDate(...candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) {
    const t = c?.trim();
    if (t && /^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  }
  for (const c of candidates) {
    const iso = toIsoDate(c);
    if (iso) return iso;
  }
  return null;
}

/** A period's two ends as YYYY-MM-DD. Each end prefers an already-ISO candidate (the page
 *  sort's year-checked date), else converts the written one; a written end without a year
 *  ("10/16") borrows the year from the other end ("10/31/2024"). An end it can't place stays null. */
export function isoPeriod(
  start: Array<string | null | undefined>,
  end: Array<string | null | undefined>,
): {start: string | null; end: string | null} {
  let s = firstIsoDate(...start);
  let e = firstIsoDate(...end);
  const yearOf = (iso: string | null) => (iso ? Number(iso.slice(0, 4)) : null);
  if (!s && e) s = start.map((c) => toIsoDate(c, yearOf(e))).find(Boolean) ?? null;
  if (!e && s) e = end.map((c) => toIsoDate(c, yearOf(s))).find(Boolean) ?? null;
  return {start: s, end: e};
}

/** A date safe to store, from a read period. A valid YYYY-MM-DD passes; an end day past the
 *  month's last ("Sept 16 to 31" read as 2026-09-31) means the month's end and becomes its last
 *  day; anything else unusable is null, since the database refuses an impossible date and that
 *  failed a whole store assignment. */
export function storableDate(s: string | null | undefined, end = false): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s?.trim() ?? '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return null;
  const last = new Date(y, mo, 0).getDate();
  if (d <= last) return `${m[1]}-${m[2]}-${m[3]}`;
  return end && d <= 31 ? `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}` : null;
}
