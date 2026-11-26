// Suggest a registry store for a form whose store couldn't be read or matched (Nov 25:
// Commit all picks stores in its confirm), and check a read code against the written name
// (snapStoreWithName, QA Nov 26). Pure. Only rare words count (a word in at most three store
// names: "Digos", not "Gaisano" or "Mall"), and only a clear winner is suggested: a tie
// suggests nothing. A suggestion is a prefill the person sees and can change, never a silent
// decision.
//
// Fuzzy since the 65-page staging run (Nov 26), which showed exact whole words miss real
// handwriting against the registry:
//  - registry names are cut at 20 characters ("ROBINSONS PLACE MALO", "MARIA CRISTINA ROSIT"),
//    so a cut last word matches the start of a written word ("Malolos", "Rocitas");
//  - BAs and the registry both abbreviate ("Rob", "Ma.", "Sta."), so those expand the same way on
//    both sides ("Rob Malolos" had matched ROB PLACE SANTIAGO by the word "rob");
//  - spelling and reading slips ("Christina" for CRISTINA) pass within one edit (two on long words).

// "Santa"/"Santo" (written "Sta"/"Sto") are place-name prefixes that never pick a store alone.
const STOP = new Set(['watsons', 'watson', 'the', 'and', 'mall', 'city', 'store', 'branch', 'santa', 'santo']);
const RARE = 3;
/** Registry names are stored cut to this many characters. */
const NAME_CAP = 20;
/** Abbreviations written on forms and used in the registry, mapped to one spelling. */
const ALIAS: Record<string, string> = {rob: 'robinsons', robinson: 'robinsons', ma: 'maria', sta: 'santa', sto: 'santo'};

function words(s: string | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')) {
    const w = ALIAS[raw] ?? raw;
    if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w) && !out.includes(w)) out.push(w);
  }
  return out;
}

/** Levenshtein distance (short words only). */
function dist(a: string, b: string): number {
  let prev = Array.from({length: b.length + 1}, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Does a written word match a registry word? `cut` = the registry word is the last word of a
 *  name stored at the cap, so it may be the start of a longer word. */
export function wordMatches(written: string, reg: string, cut = false): boolean {
  if (written === reg) return true;
  // A registry word with a branch number glued on ("PABLO2", "LUCENA2", "FAIRVIEW2") names a
  // different store from the plain one, so it only matches exactly.
  if (/\d/.test(reg) || /\d/.test(written)) return false;
  // A cut fragment needs 4+ letters: "MAL" (from "...BAGUIO MAL") would start "Malolos".
  if (cut && reg.length >= 4 && written.length > reg.length) {
    const head = written.slice(0, reg.length);
    if (head === reg || (reg.length >= 5 && dist(head, reg) <= 1)) return true;
  }
  if (written.length >= 5 && reg.length >= 5) return dist(written, reg) <= (Math.min(written.length, reg.length) >= 8 ? 2 : 1);
  return false;
}

export function suggestStore(readName: string | null | undefined, stores: Array<{code: string; name: string}>): string | null {
  const read = words(readName);
  if (!read.length) return null;
  const named = stores.map((s) => {
    const w = words(s.name);
    // Only the name's true last word can be cut off; when that is a filler word ("GAISANO - TAGUM
    // CITY") nothing is cut, so "TAGUM" never starts "Bagumbayan".
    const last = s.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').pop() ?? '';
    const cutWord = ALIAS[last] ?? last;
    return {code: s.code, w, cut: s.name.trim().length >= NAME_CAP && w[w.length - 1] === cutWord ? cutWord : null};
  });
  // Rarity is measured on the WRITTEN word: how many stores it matches under the fuzzy rules. A
  // cut registry fragment ("SANT", "CENT") is unique as a string but matches common written words
  // ("Santa", "Center"), so counting registry strings would make those look rare (staging run:
  // every "Sta Rosa" went to SM CITY-GENERAL SANT and "Center" tied "Pulilan").
  const score = new Map<string, number>();
  for (const r of read) {
    const hits = named.filter((s) => s.w.some((w) => wordMatches(r, w, w === s.cut)));
    if (!hits.length || hits.length > RARE) continue;
    for (const s of hits) score.set(s.code, (score.get(s.code) ?? 0) + 1 / hits.length);
  }
  const scored = [...score].map(([code, sc]) => ({code, score: sc})).sort((a, b) => b.score - a.score);
  if (!scored.length || (scored[1] && scored[1].score === scored[0].score)) return null;
  return scored[0].code;
}
