// Group the Uploads file list by the drop it came from: all pages split from one
// multi-page scan ("Scan… (page N of M).pdf") share a source name, so one drop of 98
// pages is one group, not 98 rows. A group is keyed by source + upload DAY, so the
// same scan uploaded on two different days are two groups (they don't mix). A single
// file (CSV, XLSX, one-page PDF) is its own group of one. PURE (no React/DB) so it
// unit-tests. Used by the Uploads "Groups" view.

import {scanPosition} from './upload-batch';
import {snapStoreWithName, storeRefs, type StoreRef} from './goldline-segment';

/** What a page still to review is missing before Commit all can file it (Nov 25):
 *  'store' when no registry store can be read off it, 'date' when the store is known but no
 *  period was read. Null when nothing is missing: it sits in a store form already, or Commit
 *  all can file it (a misread year is corrected the way the board corrects it). */
export type PageNeed = 'store' | 'date';
export function pageNeed(
  p: {status: string; batchHasStore: boolean; readStore: string | null | undefined; readStart: string | null | undefined; readName?: string | null},
  knownStores: Iterable<string | StoreRef>,
): PageNeed | null {
  if (p.status !== 'needs_review' || p.batchHasStore) return null;
  const snap = snapStoreWithName(p.readStore ?? null, p.readName, storeRefs(knownStores));
  // name_mismatch keeps a real registry code, so the page can still be filed (it's flagged elsewhere).
  if (snap.status !== 'exact' && snap.status !== 'corrected' && snap.status !== 'name_mismatch') return 'store';
  return p.readStart ? null : 'date';
}

export type GroupableUpload = {filename: string; created_at: string; status: string; batch_name?: string | null; batch_id?: string | null;
  /** The upload kind (inventory_pdf, pos_xlsx, pos_csv), for the drop's file type. */
  kind?: string | null;
  /** The upload this page's batch was split from (see src/upload-drops.ts); its own batch when never split. */
  drop_id?: string | null;
  /** What this page still to review is missing before it can be committed (see pageNeed). */
  needs?: PageNeed | null};

export type UploadGroup = {
  key: string;
  /** The source scan name (filename without the "(page N of M)" suffix), or the whole
   *  filename for a file that wasn't split. */
  source: string;
  /** Optional name the user gave this upload at drop time. Shown as the tile/header title
   *  with `source` (the file name) as a quiet subtitle. Null when they named nothing. */
  name: string | null;
  /** Upload day, YYYY-MM-DD. */
  day: string;
  /** Raw upload rows in the group (a re-uploaded page counts each time). Use for delete
   *  mechanics, not for "how many pages" — see `pages`. */
  files: number;
  /** Distinct pages the drop actually covers: a page re-uploaded N times (same "(page N
   *  of M)" position) counts once, so a 98-page scan reads "98 pages" even with retries.
   *  A lone file (CSV, XLSX, one-page PDF) is one. This is the count to show a human. */
  pages: number;
  firstAt: string; // earliest created_at in the group
  lastAt: string; // latest created_at in the group
  /** Pages per status (needs_review, committed, processing, failed, rejected), counted once
   *  per page at its furthest-along outcome, so this sums to `pages`. A page re-fed after a
   *  failed read and then committed counts as committed, not as both an issue and a commit. */
  byStatus: Record<string, number>;
  /** Pages still to review that need a person: no store to file them under, or no date. */
  needsStore: number;
  needsDate: number;
  /** True when this group is a split multi-page scan (not a lone file). */
  isSplit: boolean;
  /** The upload batch this tile is one drop of, when the drop was batched (a multi-file
   *  upload). Null for legacy / un-batched rows, which still group by source + day. */
  batchId: string | null;
  /** Set when this drop is a RE-UPLOAD of a scan already uploaded earlier (same source,
   *  later firstAt): points at the first / canonical drop so the tile can badge "Duplicate"
   *  and name the original. Null for the first (canonical) drop and for lone files. */
  duplicateOf: {key: string; name: string | null; day: string} | null;
  /** The distinct upload kinds in the drop, sorted (one for nearly every drop; two or more is
   *  a mixed drop). Empty when the rows carry no kind. */
  kinds: string[];
};

// ---- What a drop is (Nov 26, owner: "show if the file is a csv, a pdf or mix; better wordings
// could be Inventory form, Watsons sales"). One type per drop, for the tile chip and the Type
// filter: its single kind, or 'mixed' when a drop holds more than one kind of file.

export type DropType = 'inventory_pdf' | 'pos_xlsx' | 'pos_csv' | 'mixed';
export const DROP_TYPE_LABEL: Record<DropType, string> = {
  inventory_pdf: 'Inventory form',
  pos_xlsx: 'Watsons sales',
  pos_csv: 'Sales export',
  mixed: 'Mixed',
};
const KNOWN_KINDS = new Set<string>(['inventory_pdf', 'pos_xlsx', 'pos_csv']);

/** The drop's type from its kinds: the one kind, 'mixed' for more than one, null for none. */
export function dropTypeOf(kinds: readonly string[]): DropType | null {
  const known = kinds.filter((k) => KNOWN_KINDS.has(k));
  if (known.length === 0) return null;
  return known.length === 1 ? (known[0] as DropType) : 'mixed';
}

/** True when a drop passes the Type filter: 'all'; 'mixed' for a drop of several kinds; a kind
 *  for any drop holding that kind (so a mixed drop still shows under each of its kinds, whole). */
export function dropMatchesType(kinds: readonly string[], filter: string): boolean {
  if (filter === 'all') return true;
  if (filter === 'mixed') return dropTypeOf(kinds) === 'mixed';
  return kinds.includes(filter);
}

/** The source name a filename groups under: the scan name for a split page, else the
 *  whole filename. */
export function uploadSource(filename: string): string {
  return scanPosition(filename)?.source ?? filename;
}

/** The group key for one upload: the batch id when the drop was batched (so each drop is its
 *  own group, even re-uploads of the same scan), else `source|YYYY-MM-DD` (legacy / un-batched). */
export function uploadGroupKey(u: Pick<GroupableUpload, 'filename' | 'created_at' | 'batch_id' | 'drop_id'>): string {
  // One tile per upload: a batch split off by store sorting groups under the upload it came from.
  const batchId = u.drop_id?.trim() || u.batch_id?.trim();
  if (batchId) return `b|${batchId}`;
  return `${uploadSource(u.filename)}|${(u.created_at ?? '').slice(0, 10)}`;
}

/** A page's identity for counting: its "(page N of M)" position when it's a split page,
 *  else the whole filename. Re-uploads of the same page share this, so counting distinct
 *  identities gives true pages, not raw upload rows. */
function pageIdentity(filename: string): string {
  const pos = scanPosition(filename);
  return pos ? `${pos.source}|p${pos.index}` : `f|${filename}`;
}

/** How many distinct pages a set of uploads really is: a page re-uploaded several times
 *  (same "(page N of M)" position) counts once; a lone file counts as one. The number a
 *  human means by "how many pages", not the raw upload-row count. */
export function distinctPages(filenames: string[]): number {
  const seen = new Set<string>();
  for (const f of filenames) seen.add(pageIdentity(f));
  return seen.size;
}

// A page can be fed more than once (a re-upload after a failed read). Its copies may hold
// different statuses, so a page resolves to its furthest-along outcome: a page that failed
// once but read on a retry is "read", not an issue; only a page whose every copy failed
// counts as an issue. Order is best → worst.
const STATUS_PREFERENCE = ['committed', 'needs_review', 'processing', 'rejected', 'failed'];
function statusRank(status: string): number {
  const i = STATUS_PREFERENCE.indexOf(status);
  return i === -1 ? STATUS_PREFERENCE.length : i; // an unknown status ranks after the known ones
}
/** The better (furthest-along) of two statuses for the same page. */
function betterStatus(a: string, b: string): string {
  return statusRank(b) < statusRank(a) ? b : a;
}

/** Tally distinct pages by their resolved status from a flat upload list: re-uploads of one
 *  page collapse to its furthest-along outcome, so the result counts pages, not rows, and a
 *  page that failed a read but succeeded on a retry lands under its good status. */
export function pagesByStatus(items: Array<Pick<GroupableUpload, 'filename' | 'status'>>): Record<string, number> {
  const perPage = new Map<string, string>();
  for (const it of items) {
    const id = pageIdentity(it.filename);
    const prev = perPage.get(id);
    perPage.set(id, prev === undefined ? it.status : betterStatus(prev, it.status));
  }
  const out: Record<string, number> = {};
  for (const s of perPage.values()) out[s] = (out[s] ?? 0) + 1;
  return out;
}

/**
 * Group uploads by source + day, newest group first. Each group tallies its raw files and,
 * by page, their resolved status (re-uploads of one page collapse to its best outcome), and
 * whether it's a split multi-page scan (so the UI can show the raw filename for a lone file
 * but a "N pages" scan tile for a drop). `byStatus` is per page, not per row, so it sums to
 * `pages` and a page that failed then read on a retry counts once, under its good status.
 */
export function groupUploads<T extends GroupableUpload>(uploads: T[]): UploadGroup[] {
  type Acc = Omit<UploadGroup, 'files' | 'pages' | 'byStatus' | 'needsStore' | 'needsDate' | 'kinds'> & {_files: number; _pageStatus: Map<string, string>; _need: Map<string, PageNeed>; _kinds: Set<string>};
  const map = new Map<string, Acc>();
  for (const u of uploads) {
    const key = uploadGroupKey(u);
    const at = u.created_at ?? '';
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        source: uploadSource(u.filename),
        name: u.batch_name?.trim() || null,
        day: at.slice(0, 10),
        firstAt: at,
        lastAt: at,
        isSplit: false,
        batchId: u.drop_id?.trim() || u.batch_id?.trim() || null,
        duplicateOf: null,
        _files: 0,
        _pageStatus: new Map<string, string>(),
        _need: new Map<string, PageNeed>(),
        _kinds: new Set<string>(),
      };
      map.set(key, g);
    }
    g._files++;
    if (u.kind) g._kinds.add(u.kind);
    if (!g.name && u.batch_name?.trim()) g.name = u.batch_name.trim();
    const id = pageIdentity(u.filename);
    const prev = g._pageStatus.get(id);
    g._pageStatus.set(id, prev === undefined ? u.status : betterStatus(prev, u.status));
    if (u.status === 'needs_review' && u.needs) g._need.set(id, u.needs);
    if (at && at < g.firstAt) g.firstAt = at;
    if (at && at > g.lastAt) g.lastAt = at;
    if (scanPosition(u.filename)) g.isSplit = true;
  }
  const groups: UploadGroup[] = [...map.values()].map(({_files, _pageStatus, _need, _kinds, ...g}) => {
    const byStatus: Record<string, number> = {};
    for (const s of _pageStatus.values()) byStatus[s] = (byStatus[s] ?? 0) + 1;
    // Only pages that are still to review at their best status (a re-upload committed elsewhere doesn't count).
    const left = [..._need].filter(([id]) => _pageStatus.get(id) === 'needs_review');
    const needsStore = left.filter(([, n]) => n === 'store').length;
    const needsDate = left.filter(([, n]) => n === 'date').length;
    return {...g, files: _files, pages: _pageStatus.size, byStatus, needsStore, needsDate, kinds: [..._kinds].sort()};
  });
  // Mark re-uploads: among groups that share a source (the same scan uploaded more than once),
  // the earliest drop by firstAt is canonical; the rest point at it as duplicates, so a
  // re-upload shows as its own tile badged "Duplicate" instead of silently merging. Groups
  // with a unique source (the common case) stay duplicateOf = null.
  const bySource = new Map<string, UploadGroup[]>();
  for (const g of groups) {
    const list = bySource.get(g.source);
    if (list) list.push(g);
    else bySource.set(g.source, [g]);
  }
  for (const list of bySource.values()) {
    if (list.length < 2) continue;
    const [first, ...rest] = [...list].sort((a, b) => a.firstAt.localeCompare(b.firstAt));
    for (const g of rest) g.duplicateOf = {key: first.key, name: first.name, day: first.day};
  }
  return groups.sort((a, b) => b.lastAt.localeCompare(a.lastAt) || a.source.localeCompare(b.source));
}
