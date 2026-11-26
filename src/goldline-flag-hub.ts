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

// ---- Tiles (Nov 26, owner: "too long; square tiles first, click one to see its flags") ----
// The overview is one square tile per kind of flag within its tier; opening a tile swaps the
// page to that tile's lines (same page, a Back step), paged.

export type HubTile = {
  /** `${tier}.${kindKey}`, or `cleared.all` for the one Cleared tile. Goes in the URL (?kind=). */
  key: string;
  tier: HubTier;
  /** kindKey of the lines, null for the Cleared tile (every kind). */
  kind: string | null;
  label: string;
  count: number;
  stores: number;
  pages: number;
};

export const CLEARED_TILE = 'cleared.all';
const TILE_KEY = /^(needs|open|fyi)\.(check|mark):[a-z_]{1,40}$/;
export const isTileKey = (s: string | null | undefined): s is string => s === CLEARED_TILE || (typeof s === 'string' && TILE_KEY.test(s));

export const tileKeyOf = (l: FlagLine): string => {
  const tier = tierOf(l);
  return tier === 'cleared' ? CLEARED_TILE : `${tier}.${kindKey(l)}`;
};

/** The tiles for lines already filtered, by tier, biggest first (then by name). The Cleared
 *  tier is one tile for every kind: it is a record, not a to-do. */
export function hubTiles(lines: readonly FlagLine[]): Record<HubTier, HubTile[]> {
  const by = new Map<string, {tile: HubTile; stores: Set<string>; pages: Set<string>}>();
  for (const l of lines) {
    const key = tileKeyOf(l);
    let t = by.get(key);
    if (!t) {
      const tier = tierOf(l);
      t = {tile: {key, tier, kind: tier === 'cleared' ? null : kindKey(l), label: tier === 'cleared' ? 'Cleared and resolved' : l.why, count: 0, stores: 0, pages: 0}, stores: new Set(), pages: new Set()};
      by.set(key, t);
    }
    t.tile.count++;
    if (l.storeCode) t.stores.add(l.storeCode);
    if (l.uploadId) t.pages.add(l.uploadId);
  }
  const out: Record<HubTier, HubTile[]> = {needs: [], open: [], fyi: [], cleared: []};
  for (const {tile, stores, pages} of by.values()) out[tile.tier].push({...tile, stores: stores.size, pages: pages.size});
  for (const tier of HUB_TIERS) out[tier].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return out;
}

/** The lines behind a tile, in the order given. */
export const tileLines = (lines: readonly FlagLine[], key: string): FlagLine[] => lines.filter((l) => tileKeyOf(l) === key);

export const PAGE_SIZE = 25;

/** One page of rows (1-based, clamped), with the page count. */
export function pageOf<T>(rows: readonly T[], page: number, size = PAGE_SIZE): {rows: T[]; page: number; pageCount: number; from: number; to: number} {
  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const from = (p - 1) * size;
  return {rows: rows.slice(from, from + size), page: p, pageCount, from: rows.length ? from + 1 : 0, to: Math.min(rows.length, from + size)};
}

/** Ids of the open review marks in a group, for "Clear all". Checks are never in it. */
export const clearableIds = (lines: readonly FlagLine[]) => lines.filter((l) => l.open && l.source !== 'check' && l.id).map((l) => l.id as string);

/** The line's heading: the store (name, else code, else "Store not known yet") and where. */
export function lineTitle(l: FlagLine): string {
  const store = l.storeName ?? l.storeCode ?? 'Store not known yet';
  const where = l.page != null ? (l.pageOf ? `Page ${l.page} of ${l.pageOf}` : `Page ${l.page}`) : null;
  return where ? `${store} · ${where}` : store;
}
