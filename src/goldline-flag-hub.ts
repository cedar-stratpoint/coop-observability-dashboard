// Flags hub (P0, Nov 26). PURE so it unit-tests; the page reads lines with flagLines
// (src/goldline-flag-lines-data.ts). Plan: knowledge/tasks/2026-11-26-nichido-flags-hub.md.
//
// Every flag line lands in exactly one tier, so the eye knows where to start:
//   needs    blocks a commit or a value: an unanswered band price, or a "can't read" mark,
//            on a page still in review. The one tinted strip on the page (Von Restorff).
//   open     everything else still open: Coop's checks, damage, other, a price kept at the
//            printed one on a committed page.
//   fyi      notes and revisions, relabelled columns, products written in: worth knowing,
//            not a fix. Collapsed.
//   cleared  cleared marks and resolved checks (a resolved check still counts against the BA).
// A check is never cleared from the hub: it always counts (Oct 26). It can take a remark.

import type {FlagLine} from './goldline-flag-lines';

export type HubTier = 'needs' | 'open' | 'fyi' | 'cleared';
export const HUB_TIERS: HubTier[] = ['needs', 'open', 'fyi', 'cleared'];

/** Mark kinds that inform rather than ask for a fix. */
const FYI_KINDS = new Set(['note', 'column_changed', 'added_row']);
/** Mark kinds that stop a page's value from being right until someone answers. */
const BLOCKING_KINDS = new Set(['price', 'illegible']);

/** True when the hub replaces /flags (GOLDLINE_FLAGS_HUB=1). Off = today's pages, unchanged. */
export const flagsHubEnabled = (env: Record<string, string | undefined> = process.env) => env.GOLDLINE_FLAGS_HUB === '1';

export function tierOf(l: FlagLine): HubTier {
  if (!l.open) return 'cleared';
  if (l.source === 'check') return 'open';
  if (l.kind && FYI_KINDS.has(l.kind)) return 'fyi';
  if (l.kind && BLOCKING_KINDS.has(l.kind) && l.uploadStatus === 'needs_review') return 'needs';
  return 'open';
}

/** One kind of flag across sources: a check kind or a mark kind. */
export const kindKey = (l: FlagLine) => `${l.source === 'check' ? 'check' : 'mark'}:${l.kind ?? l.why}`;

export type HubKind = {key: string; label: string; count: number};

/** Kinds among the lines, most first (then by name), with the label the lines use. */
export function hubKinds(lines: readonly FlagLine[]): HubKind[] {
  const by = new Map<string, HubKind>();
  for (const l of lines) {
    const k = kindKey(l);
    const cur = by.get(k);
    if (cur) cur.count++;
    else by.set(k, {key: k, label: l.why, count: 1});
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export type HubGroup = {key: string; label: string; lines: FlagLine[]};

/** Lines grouped by kind, biggest group first; lines inside keep their order. */
export function groupByKind(lines: readonly FlagLine[]): HubGroup[] {
  const by = new Map<string, HubGroup>();
  for (const l of lines) {
    const k = kindKey(l);
    const g = by.get(k);
    if (g) g.lines.push(l);
    else by.set(k, {key: k, label: l.why, lines: [l]});
  }
  return [...by.values()].sort((a, b) => b.lines.length - a.lines.length || a.label.localeCompare(b.label));
}

export type HubView = {needs: FlagLine[]; open: HubGroup[]; fyi: HubGroup[]; cleared: FlagLine[]; counts: Record<HubTier, number>; kinds: HubKind[]};

/**
 * The hub's layout for lines already filtered by store, month, source and search: the tiers,
 * the kind chips (from the lines still open, so a chip never leads to an empty view), and the
 * chosen kind applied last. `kind` null = every kind.
 */
export function hubView(lines: readonly FlagLine[], kind: string | null): HubView {
  const kinds = hubKinds(lines.filter((l) => l.open));
  const shown = kind ? lines.filter((l) => kindKey(l) === kind) : lines;
  const tiers: Record<HubTier, FlagLine[]> = {needs: [], open: [], fyi: [], cleared: []};
  for (const l of shown) tiers[tierOf(l)].push(l);
  return {
    needs: tiers.needs,
    open: groupByKind(tiers.open),
    fyi: groupByKind(tiers.fyi),
    cleared: tiers.cleared,
    counts: {needs: tiers.needs.length, open: tiers.open.length, fyi: tiers.fyi.length, cleared: tiers.cleared.length},
    kinds,
  };
}

/** The kind chips to show (Hick's law): the top `max` by count, the rest behind "+N". The
 *  chosen kind always shows, even when it is not in the top. */
export function visibleKinds(kinds: readonly HubKind[], chosen: string | null, max = 6): {shown: HubKind[]; more: number} {
  const top = kinds.slice(0, max);
  const pick = chosen ? kinds.find((k) => k.key === chosen) : undefined;
  const shown = pick && !top.includes(pick) ? [...top, pick] : top;
  return {shown, more: kinds.length - shown.length};
}

/** Ids of the open review marks in a group, for "Clear all". Checks are never in it. */
export const clearableIds = (lines: readonly FlagLine[]) => lines.filter((l) => l.open && l.source !== 'check' && l.id).map((l) => l.id as string);

/** The line's heading: the store (name, else code, else "Store not known yet") and where. */
export function lineTitle(l: FlagLine): string {
  const store = l.storeName ?? l.storeCode ?? 'Store not known yet';
  const where = l.page != null ? (l.pageOf ? `Page ${l.page} of ${l.pageOf}` : `Page ${l.page}`) : null;
  return where ? `${store} · ${where}` : store;
}
