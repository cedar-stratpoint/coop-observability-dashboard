// Reconcile the handwritten BA (beauty advisor) names a scan reads. The same person is
// written many ways — "Rhea Mae Bernil", "Rhea Mae P. Bermil", "RHEA MAE BERMIL" — which
// scatters one person's forms across several tiles. This groups the near-identical names
// into one, preferring a name already in the registry as the source of truth so the
// canonical spelling is the one the brand uses. Pure + unit-tested.

import {editDistance} from './goldline-segment';

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
