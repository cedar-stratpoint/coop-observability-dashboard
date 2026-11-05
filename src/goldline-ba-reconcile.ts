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

/**
 * Map every raw BA name to its canonical display name. Near-identical names cluster
 * together; a cluster whose slug matches a registry BA takes that registry spelling
 * (source of truth), otherwise the fullest-looking written name (most words, then
 * longest) stands in. Blank names map to null (the caller shows "No BA on the form").
 */
export function reconcileBaNames(names: Array<string | null | undefined>, known: string[] = []): Map<string, string> {
  const uniq = [...new Set(names.map((n) => (n ?? '').trim()).filter(Boolean))];
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

  const out = new Map<string, string>();
  for (const c of clusters) {
    const registry = knownBySlug.find((k) => sameBa(k.slug, c.slug));
    const canonical =
      registry?.name ??
      c.names
        .slice()
        .sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length || b.length - a.length)[0];
    for (const n of c.names) out.set(n, canonical);
  }
  return out;
}

/**
 * Rewrite each form's `consultant` to its canonical BA spelling, so the same person reads
 * identically on every card (not "RHEA MAE BERMIL" on one and "Rhea Mae P. Bermil" on the
 * next). Clusters across the whole board; blank names are left as-is. Pure — returns a new
 * board, forms untouched apart from the label.
 */
export function withCanonicalBa<T extends {forms: ReadonlyArray<{consultant: string | null}>}>(board: T, known: string[] = []): T {
  const map = reconcileBaNames(
    board.forms.map((f) => f.consultant),
    known,
  );
  return {
    ...board,
    forms: board.forms.map((f) => {
      const t = f.consultant?.trim();
      return t ? {...f, consultant: map.get(t) ?? t} : f;
    }),
  };
}
