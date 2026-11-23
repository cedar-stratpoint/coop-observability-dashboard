// "Back goes back": the pure half of the list ↔ detail return trip (Nichido first).
//
// Three rules (from the Glide "Back" reel, 2026-11-23):
//   1. Back keeps your place: the list comes back with its filters, scroll and the row you
//      opened marked, not reset to page 1 / All.
//   2. The page leaves the way it came (P3, not built here).
//   3. One press, one step: a filter click is not a step, so it never adds a history entry
//      (URL updated with replaceState). Opening a row is a step; Back undoes exactly that.
//
// The client half (hooks + ReturnLink) lives in components/analyst/back-nav.tsx. This file
// holds what can be unit-tested without a DOM: param merging and return-target validation.

/** Default values for a list's URL params. Every value is a string; a value equal to its
 *  default is left out of the URL so a fresh list keeps a clean address. */
export type ListDefaults = Record<string, string>;

/**
 * Merge a patch of list params into the current query string. Params the list doesn't own
 * (e.g. `store`, which the server reads) pass through untouched; owned params at their
 * default are dropped. Returns the query string without the leading `?`.
 */
export function mergeListParams(current: string, defaults: ListDefaults, values: Record<string, string>): string {
  const q = new URLSearchParams(current);
  for (const [k, def] of Object.entries(defaults)) {
    const v = values[k] ?? def;
    if (v === def || v === '') q.delete(k);
    else q.set(k, v);
  }
  return q.toString();
}

/** Read a list's owned params out of a query string, falling back to the defaults. */
export function readListParams<D extends ListDefaults>(current: string, defaults: D): D {
  const q = new URLSearchParams(current);
  const out = {...defaults};
  for (const k of Object.keys(defaults) as Array<keyof D & string>) {
    const v = q.get(k);
    if (v != null && v !== '') out[k] = v as D[typeof k];
  }
  return out;
}

/** What a list remembers when you open one of its rows (kept per browser tab). */
export type ReturnEntry = {
  /** The list's own URL at the moment you left: path + query, same origin. */
  url: string;
  /** Window scroll position when you left. */
  scrollY: number;
  /** The row you opened (matched against `data-kept-id`). */
  rowId: string | null;
  /** When you left (ms). Old entries are ignored. */
  at: number;
  /** The detail path the row opened (decoded), so Back only uses this entry from that page. */
  to: string | null;
};

/** How long a remembered list stays good for. Past this, Back uses the plain fallback. */
export const RETURN_TTL_MS = 6 * 60 * 60 * 1000;

export const returnKey = (listKey: string) => `coop:return:${listKey}`;

/** Parse + validate a stored entry. Anything malformed, stale or off-site is rejected. */
export function parseReturnEntry(raw: string | null, now: number): ReturnEntry | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const e = v as Partial<ReturnEntry>;
  if (typeof e.url !== 'string' || !isLocalPath(e.url)) return null;
  if (typeof e.at !== 'number' || now - e.at > RETURN_TTL_MS || e.at > now + 60_000) return null;
  return {
    url: e.url,
    scrollY: typeof e.scrollY === 'number' && Number.isFinite(e.scrollY) && e.scrollY >= 0 ? e.scrollY : 0,
    rowId: typeof e.rowId === 'string' ? e.rowId : null,
    at: e.at,
    to: typeof e.to === 'string' ? e.to : null,
  };
}

/** A same-origin absolute path ("/stock?x=1"), never "//evil.com" or "https://…". */
export function isLocalPath(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\');
}

const pathOf = (url: string) => url.split(/[?#]/)[0];

/**
 * Where the detail page's Back link should go. The remembered list URL wins (that's "keeps
 * your place"), but only when it is the same list the fallback names. Otherwise (deep link,
 * an email, a different list) Back is the fixed parent, as before.
 */
export function returnHref(entry: ReturnEntry | null, fallback: string): string {
  if (entry && pathOf(entry.url) === pathOf(fallback)) return entry.url;
  return fallback;
}
