// Which BA a form belongs to (A1). Pure + unit-tested; the data side is
// src/goldline-ba-data.ts.
//
// Decided Oct 27: nobody types a BA list in. Coop learns BAs from the forms
// themselves: the "Beauty Consultant" line is read on upload, recognised when that BA
// is already known, stored as a new BA when not, and recorded as the store's BA from
// that form's cycle. A form's BA is:
//   1. the name written on it, matched to a BA who has covered that store, so
//      "Liza M." or "liza mendoza" becomes the known "Liza Mendoza";
//   2. else matched to any known BA (a BA who moved stores), full name or first name
//      plus last initial only, never a first name alone;
//   3. else a new BA, kept as written;
//   4. no name on the form: the store's BA on the form's last day (learned from its
//      earlier forms);
//   5. otherwise none (the tile reads "BA not named on the form").

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
export function matchBa(written: string, candidates: string[], opts: {firstOnly?: boolean} = {}): string | null {
  const w = normName(written);
  if (!w) return null;
  const exact = candidates.find((c) => normName(c) === w);
  if (exact) return exact;
  const [wf, ...wr] = w.split(' ');
  const fits = [...new Set(candidates)].filter((c) => {
    const [cf, ...cr] = normName(c).split(' ');
    if (cf !== wf) return false;
    if (!wr.length) return opts.firstOnly !== false; // first name only
    // Word by word, any word may be shortened to its initial ("Maria Luisa R.").
    if (wr.length === cr.length) return wr.every((t, i) => t === cr[i] || (t.length === 1 && cr[i].startsWith(t)));
    // One initial for a longer last name ("Liza M." for "Liza Mendoza Cruz").
    return wr.length === 1 && wr[0].length === 1 && cr.join(' ').startsWith(wr[0]);
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

export type BaSource = 'store' | 'known' | 'new' | 'directory' | 'none';

/** A form's BA from what's written, the store's BAs and every known BA (see the header). */
export function resolveBa(input: {written: string | null | undefined; storeBas: StoreBa[]; known?: string[]; periodEnd: string}): {name: string | null; source: BaSource} {
  const written = cleanName(input.written ?? '');
  if (written) {
    const atStore = matchBa(written, input.storeBas.map((a) => a.name));
    if (atStore) return {name: atStore, source: 'store'};
    const known = matchBa(written, input.known ?? [], {firstOnly: false});
    if (known) return {name: known, source: 'known'};
    return {name: written, source: 'new'};
  }
  const fromDir = baOnDate(input.storeBas, input.periodEnd);
  return fromDir ? {name: fromDir, source: 'directory'} : {name: null, source: 'none'};
}

/**
 * Whether a form's named BA should become the store's BA from the form's first day:
 * not when it already is, and not when the form is older than the current assignment
 * (an old form uploaded late never rewrites who covers the store now).
 */
export function shouldRecordBa(name: string, storeBas: StoreBa[], periodStart: string): boolean {
  const open = storeBas.find((a) => a.ended_on == null);
  if (!open) return !storeBas.some((a) => a.started_on <= periodStart && (a.ended_on ?? '') >= periodStart);
  if (normName(open.name) === normName(name)) return false;
  return open.started_on <= periodStart;
}
