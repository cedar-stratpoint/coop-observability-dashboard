// Which BA a form belongs to (A1, Oct 26). Pure + unit-tested; the data side is
// src/goldline-ba-data.ts.
//
// The form has a "Beauty Consultant" line, often blank or shortened. The directory
// (store_bas) says which BA covers a store from when. A form's BA is:
//   1. the name written on it, matched to a BA who has covered that store, so
//      "Liza M." or "liza mendoza" becomes the directory's full "Liza Mendoza";
//   2. a written name nobody in the directory matches, kept as written;
//   3. no name on the form: the store's BA on the form's last day;
//   4. otherwise none (the tile reads "BA not named on the form").

export type StoreBa = {name: string; started_on: string; ended_on: string | null};

/** Lowercase, no dots, single spaces: "Liza  M." → "liza m". */
export const normName = (s: string) => s.toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim();

/** Tidy a typed name for storage: trimmed, single spaces. Case is kept as typed. */
export const cleanName = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The directory name a written name means, or null. Exact (ignoring case and dots)
 * first; then same first name with a matching initial or full last name ("Liza M."
 * → "Liza Mendoza"), only when exactly one candidate fits.
 */
export function matchBa(written: string, candidates: string[]): string | null {
  const w = normName(written);
  if (!w) return null;
  const exact = candidates.find((c) => normName(c) === w);
  if (exact) return exact;
  const [wf, ...wr] = w.split(' ');
  const wl = wr.join(' ');
  const fits = [...new Set(candidates)].filter((c) => {
    const [cf, ...cr] = normName(c).split(' ');
    const cl = cr.join(' ');
    if (cf !== wf) return false;
    if (!wl) return true; // first name only
    return wl.length === 1 ? cl.startsWith(wl) : cl === wl;
  });
  return fits.length === 1 ? fits[0] : null;
}

/** The store's BA on a date (the assignment covering it), or null. */
export function baOnDate(assignments: StoreBa[], date: string): string | null {
  const hit = assignments
    .filter((a) => a.started_on <= date && (a.ended_on == null || a.ended_on >= date))
    .sort((a, b) => b.started_on.localeCompare(a.started_on))[0];
  return hit?.name ?? null;
}

/** A form's BA from what's written and the store's directory rows (see the header). */
export function resolveBa(input: {written: string | null | undefined; storeBas: StoreBa[]; periodEnd: string}): {name: string | null; source: 'form' | 'directory' | 'none'} {
  const written = cleanName(input.written ?? '');
  if (written) return {name: matchBa(written, input.storeBas.map((a) => a.name)) ?? written, source: 'form'};
  const fromDir = baOnDate(input.storeBas, input.periodEnd);
  return fromDir ? {name: fromDir, source: 'directory'} : {name: null, source: 'none'};
}

/**
 * Pasted "store code, BA name" lines (comma, tab or two+ spaces between). Blank lines
 * and a header row are skipped; anything else unreadable is returned as an error line.
 */
export function parseBaLines(text: string): {rows: Array<{store: string; name: string}>; errors: string[]} {
  const rows: Array<{store: string; name: string}> = [];
  const errors: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\t|,|\s{2,}/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) {
      errors.push(line);
      continue;
    }
    const [store, ...rest] = parts;
    const name = cleanName(rest.join(' '));
    if (/^store/i.test(store) && /ba|name|consultant/i.test(name)) continue; // header row
    if (!/^[A-Za-z0-9-]{1,20}$/.test(store) || name.length < 2) {
      errors.push(line);
      continue;
    }
    rows.push({store, name});
  }
  return {rows, errors};
}
