// Pure helpers for the top-bar view switcher: menu grouping/order and a stable
// per-company color. Display-only — membershipViews() keeps its own order because
// default view resolution depends on it.

export type SwitcherView = {key: string; companyId: string | null; role: string; name: string};

/** Coop Admin (cross-tenant) first — the menu draws a divider after it — then
 *  companies A–Z by display name (id as a tiebreak so the order is total). */
export function groupViews(views: SwitcherView[]): {coop: SwitcherView | null; companies: SwitcherView[]} {
  const coop = views.find((v) => v.companyId === null) ?? null;
  const companies = views
    .filter((v) => v.companyId !== null)
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}) ||
        (a.companyId as string).localeCompare(b.companyId as string),
    );
  return {coop, companies};
}

// Hand-picked hues that read as distinct in both themes and stay clear of the
// status colors' meaning. Known tenants get a fixed hue that fits the brand
// (Goldline → gold); any other company gets a stable hue from its id.
const HUES = [205, 285, 25, 160, 330, 245, 115];
const FIXED: Record<string, number> = {goldline: 75, zoomy: 160};

export function companyHue(companyId: string): number {
  if (companyId in FIXED) return FIXED[companyId];
  let h = 0;
  for (let i = 0; i < companyId.length; i++) h = (h * 31 + companyId.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

/** One or two letters for a company badge: "Goldline Cosmetics" → "GC", "Zoomy" → "Z". */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0][0]).toUpperCase();
}
