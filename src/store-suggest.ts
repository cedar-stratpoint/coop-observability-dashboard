// Suggest a registry store for a form whose store couldn't be read or matched (Nov 25:
// Commit all picks stores in its confirm). Pure. Only rare words count (a word in at most
// three store names: "Digos", not "Gaisano" or "Mall"), and only a clear winner is
// suggested: a tie suggests nothing. A suggestion is a prefill the person sees and can
// change, never a silent decision.

const STOP = new Set(['watsons', 'watson', 'the', 'and', 'mall', 'city', 'store', 'branch']);
const RARE = 3;

function words(s: string | null | undefined): Set<string> {
  return new Set(
    (s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)),
  );
}

export function suggestStore(readName: string | null | undefined, stores: Array<{code: string; name: string}>): string | null {
  const read = words(readName);
  if (!read.size) return null;
  const named = stores.map((s) => ({code: s.code, w: words(s.name)}));
  const df = new Map<string, number>();
  for (const s of named) for (const w of s.w) df.set(w, (df.get(w) ?? 0) + 1);
  const scored = named
    .map((s) => ({code: s.code, score: [...read].reduce((n, w) => (s.w.has(w) && (df.get(w) ?? 0) <= RARE ? n + 1 / df.get(w)! : n), 0)}))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length || (scored[1] && scored[1].score === scored[0].score)) return null;
  return scored[0].code;
}
