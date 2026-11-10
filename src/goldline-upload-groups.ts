// Group the Uploads file list by the drop it came from: all pages split from one
// multi-page scan ("Scan… (page N of M).pdf") share a source name, so one drop of 98
// pages is one group, not 98 rows. A group is keyed by source + upload DAY, so the
// same scan uploaded on two different days are two groups (they don't mix). A single
// file (CSV, XLSX, one-page PDF) is its own group of one. PURE (no React/DB) so it
// unit-tests. Used by the Uploads "Groups" view.

import {scanPosition} from './upload-batch';

export type GroupableUpload = {filename: string; created_at: string; status: string; batch_name?: string | null};

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
  /** True when this group is a split multi-page scan (not a lone file). */
  isSplit: boolean;
};

/** The source name a filename groups under: the scan name for a split page, else the
 *  whole filename. */
export function uploadSource(filename: string): string {
  return scanPosition(filename)?.source ?? filename;
}

/** The group key for one upload: `source|YYYY-MM-DD` (day from created_at). */
export function uploadGroupKey(u: Pick<GroupableUpload, 'filename' | 'created_at'>): string {
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
  type Acc = Omit<UploadGroup, 'files' | 'pages' | 'byStatus'> & {_files: number; _pageStatus: Map<string, string>};
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
        _files: 0,
        _pageStatus: new Map<string, string>(),
      };
      map.set(key, g);
    }
    g._files++;
    if (!g.name && u.batch_name?.trim()) g.name = u.batch_name.trim();
    const id = pageIdentity(u.filename);
    const prev = g._pageStatus.get(id);
    g._pageStatus.set(id, prev === undefined ? u.status : betterStatus(prev, u.status));
    if (at && at < g.firstAt) g.firstAt = at;
    if (at && at > g.lastAt) g.lastAt = at;
    if (scanPosition(u.filename)) g.isSplit = true;
  }
  return [...map.values()]
    .map(({_files, _pageStatus, ...g}) => {
      const byStatus: Record<string, number> = {};
      for (const s of _pageStatus.values()) byStatus[s] = (byStatus[s] ?? 0) + 1;
      return {...g, files: _files, pages: _pageStatus.size, byStatus};
    })
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt) || a.source.localeCompare(b.source));
}
