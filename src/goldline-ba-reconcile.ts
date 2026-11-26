// Reconcile the handwritten BA (beauty advisor) names a scan reads. The same person is
// written many ways — "Rhea Mae Bernil", "Rhea Mae P. Bermil", "RHEA MAE BERMIL" — which
// scatters one person's forms across several tiles. This groups the near-identical names
// into one, preferring a name already in the registry as the source of truth so the
// canonical spelling is the one the brand uses. Pure + unit-tested.

import {editDistance, formRuns, type ClassifiedPage} from './goldline-segment';
import {wordMatches} from './store-suggest';

const HONORIFICS = new Set(['ma', 'mr', 'mrs', 'ms', 'dr']);

/** A name normalized for matching: lowercase, punctuation gone, single-letter tokens
 *  (middle initials) and a leading honorific ("Ma."/"Mrs.") dropped, whitespace collapsed.
 *  "Rhea Mae P. Bermil" → "rhea mae bermil"; "Ma. Sofia C. Lucero" → "sofia lucero". */
export function baSlug(name: string): string {
  const tokens = (name || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (tokens.length > 1 && HONORIFICS.has(tokens[0])) tokens.shift();
  return tokens.join(' ').trim();
}

/** Whether two slugs are the same person: equal, or within a small edit distance scaled
 *  to the name length (so "bernil" vs "bermil" matches, but short unrelated names don't). */
function sameBa(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const d = editDistance(a, b);
  return d <= Math.min(3, Math.max(1, Math.floor(Math.min(a.length, b.length) * 0.2)));
}

/** Small look-alike clusters (this many forms or fewer) are the ones folded into a bigger
 *  same-first-name card; a cluster with more than this is treated as its own real BA. */
const FOLD_SMALL_FORMS = 2;

/**
 * Map every raw BA name to its canonical display name. Near-identical names cluster
 * together; a cluster whose slug matches a registry BA takes that registry spelling
 * (source of truth), otherwise the fullest-looking written name (most words, then
 * longest) stands in. Blank names map to null (the caller shows "No BA on the form").
 *
 * With `foldFirstName`, a second pass folds the small look-alikes that share a first name
 * into the dominant card for that first name: handwriting reads one person's surname many
 * ways ("Vanessa Dimaampao / Dran / Olompo"), so a 1 to 2 form card joins the person who
 * already holds most of the forms. Two substantial same-first-name cards (more than
 * `FOLD_SMALL_FORMS` forms each) are left apart, so two real BAs aren't merged by accident.
 * The `names` list is one entry per form (not de-duplicated), so form counts are honoured.
 */
export function reconcileBaNames(
  names: Array<string | null | undefined>,
  known: string[] = [],
  opts: {foldFirstName?: boolean} = {},
): Map<string, string> {
  const trimmed = names.map((n) => (n ?? '').trim()).filter(Boolean);
  const freq = new Map<string, number>();
  for (const n of trimmed) freq.set(n, (freq.get(n) ?? 0) + 1);
  const uniq = [...new Set(trimmed)];
  const knownBySlug = known
    .map((k) => ({name: k.trim(), slug: baSlug(k)}))
    .filter((k) => k.slug);

  // Cluster the written names by slug similarity.
  const clusters: Array<{slug: string; names: string[]}> = [];
  for (const name of uniq) {
    const slug = baSlug(name);
    if (!slug) continue;
    let c = clusters.find((cl) => sameBa(cl.slug, slug));
    if (!c) {
      c = {slug, names: []};
      clusters.push(c);
    }
    c.names.push(name);
  }

  const canonOf = (c: {slug: string; names: string[]}) => {
    const registry = knownBySlug.find((k) => sameBa(k.slug, c.slug));
    return (
      registry?.name ??
      c.names
        .slice()
        .sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length || b.length - a.length)[0]
    );
  };
  const nodes = clusters.map((c) => ({
    slug: c.slug,
    names: c.names,
    first: c.slug.split(' ')[0],
    forms: c.names.reduce((n, name) => n + (freq.get(name) ?? 0), 0),
    canonical: canonOf(c),
  }));

  // Fold the small look-alikes into the dominant card that shares their first name.
  if (opts.foldFirstName) {
    const byFirst = new Map<string, typeof nodes>();
    for (const node of nodes) byFirst.set(node.first, [...(byFirst.get(node.first) ?? []), node]);
    for (const group of byFirst.values()) {
      if (group.length < 2) continue;
      // Most forms leads; a fuller / longer canonical breaks a tie.
      const lead = group
        .slice()
        .sort((a, b) => b.forms - a.forms || b.canonical.split(/\s+/).length - a.canonical.split(/\s+/).length || b.canonical.length - a.canonical.length)[0];
      for (const node of group) {
        if (node === lead) continue;
        if (node.forms <= FOLD_SMALL_FORMS) node.canonical = lead.canonical;
      }
    }
  }

  const out = new Map<string, string>();
  for (const node of nodes) for (const n of node.names) out.set(n, node.canonical);
  return out;
}

/**
 * Rewrite each form's `consultant` to its canonical BA spelling, so the same person reads
 * identically on every card (not "RHEA MAE BERMIL" on one and "Rhea Mae P. Bermil" on the
 * next). Clusters across the whole board; blank names are left as-is. Pure — returns a new
 * board, forms untouched apart from the label.
 */
export function withCanonicalBa<T extends {forms: ReadonlyArray<{consultant: string | null}>}>(board: T, known: string[] = [], opts: {foldFirstName?: boolean} = {}): T {
  const map = reconcileBaNames(
    board.forms.map((f) => f.consultant),
    known,
    opts,
  );
  return {
    ...board,
    forms: board.forms.map((f) => {
      const t = f.consultant?.trim();
      return t ? {...f, consultant: map.get(t) ?? t} : f;
    }),
  };
}

/**
 * One BA per physical form (QA Nov 26): handwriting reads one person's name differently on each page
 * ("Elaiza Mae V. Calen / Calem / Calern / Calleja", "Cherry Mae P. Baluco / Balisco / Bacoo"). Within
 * each form (formRuns), the pages' names are clustered as on the board (reconcileBaNames, first-name
 * fold on); the cluster most pages read wins. Its spelling: the registry's (`known`) when it has one,
 * else the normalized name most pages wrote (middle initials and case ignored), a tie going to the
 * reading closest to all the others (never simply the longest: "Nanette Vadpacagia" lost to
 * "Saladaga"), written in its fullest form. Pages in that cluster, pages that read no BA, and pages
 * whose "BA" is really the form's store (a word of the store's registry name, e.g. "Walter Plaridel"
 * for WALTERMART PLARIDEL) take it, keeping what they read in `consultant_read`. A page naming
 * someone else keeps its own name. Two pages must agree before anything changes. Pure.
 */
export function formConsultants<T extends ClassifiedPage>(
  pages: T[],
  positionOf: (p: T) => {source: string; index: number} | null,
  known: string[] = [],
  storeNameOf: (code: string) => string | null = () => null,
): T[] {
  const out = [...pages];
  const words = (s: string) => baSlug(s).split(' ').filter((w) => w.length >= 5);
  for (const run of formRuns(out, positionOf)) {
    const codes = [...new Set(run.map((x) => x.p.store_code).filter((c): c is string => Boolean(c)))];
    const storeWords = codes.flatMap((c) => words(storeNameOf(c) ?? ''));
    const isStoreName = (name: string) => words(name).some((w) => storeWords.some((sw) => wordMatches(w, sw, true)));
    const named = run.filter((x) => x.p.consultant && baSlug(x.p.consultant) && !isStoreName(x.p.consultant));
    if (named.length < 2) continue;
    const canon = reconcileBaNames(named.map((x) => x.p.consultant), known, {foldFirstName: true});
    const votes = new Map<string, number>();
    for (const x of named) {
      const c = canon.get((x.p.consultant ?? '').trim());
      if (c) votes.set(c, (votes.get(c) ?? 0) + 1);
    }
    const ranked = [...votes].sort((a, b) => b[1] - a[1]);
    if (!ranked.length || ranked[0][1] < 2 || (ranked[1] && ranked[1][1] === ranked[0][1])) continue;
    const winner = ranked[0][0];
    const members = named.map((x) => (x.p.consultant ?? '').trim()).filter((n) => canon.get(n) === winner);
    const spelled = known.some((k) => k.trim() === winner) ? winner : agreedSpelling(members);
    for (const x of run) {
      const read = x.p.consultant?.trim() || null;
      const takes = !read || isStoreName(read) || canon.get(read) === winner;
      if (!takes || read === spelled) continue;
      out[x.i] = {...out[x.i], consultant: spelled, consultant_read: read};
    }
  }
  return out;
}

/** The spelling most readings agree on: the normalized name (baSlug) written most often, a tie going
 *  to the one closest to all the others; then its fullest written form. Pure. */
export function agreedSpelling(readings: string[]): string {
  const bySlug = new Map<string, string[]>();
  for (const r of readings) {
    const s = baSlug(r);
    if (s) bySlug.set(s, [...(bySlug.get(s) ?? []), r]);
  }
  const slugs = [...bySlug.keys()];
  const spread = (s: string) => slugs.reduce((n, t) => n + editDistance(s, t) * (bySlug.get(t)?.length ?? 1), 0);
  const best = slugs.sort((a, b) => (bySlug.get(b)!.length - bySlug.get(a)!.length) || spread(a) - spread(b))[0];
  return bySlug
    .get(best)!
    .slice()
    .sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length || b.length - a.length)[0];
}
