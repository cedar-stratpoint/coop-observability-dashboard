// Group the Uploads file list by the drop it came from: all pages split from one
// multi-page scan ("Scan… (page N of M).pdf") share a source name, so one drop of 98
// pages is one group, not 98 rows. A group is keyed by source + upload DAY, so the
// same scan uploaded on two different days are two groups (they don't mix). A single
// file (CSV, XLSX, one-page PDF) is its own group of one. PURE (no React/DB) so it
// unit-tests. Used by the Uploads "Groups" view.

import {scanPosition} from './upload-batch';

export type GroupableUpload = {filename: string; created_at: string; status: string};

export type UploadGroup = {
  key: string;
  /** The source scan name (filename without the "(page N of M)" suffix), or the whole
   *  filename for a file that wasn't split. */
  source: string;
  /** Upload day, YYYY-MM-DD. */
  day: string;
  files: number;
  firstAt: string; // earliest created_at in the group
  lastAt: string; // latest created_at in the group
  /** Count per status (needs_review, committed, processing, failed, rejected). */
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

/**
 * Group uploads by source + day, newest group first. Each group tallies its files and
 * their statuses, and whether it's a split multi-page scan (so the UI can show the raw
 * filename for a lone file but a "N files" scan tile for a drop).
 */
export function groupUploads<T extends GroupableUpload>(uploads: T[]): UploadGroup[] {
  const map = new Map<string, UploadGroup & {_members: number}>();
  for (const u of uploads) {
    const key = uploadGroupKey(u);
    const at = u.created_at ?? '';
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        source: uploadSource(u.filename),
        day: at.slice(0, 10),
        files: 0,
        firstAt: at,
        lastAt: at,
        byStatus: {},
        isSplit: false,
        _members: 0,
      };
      map.set(key, g);
    }
    g.files++;
    g._members++;
    g.byStatus[u.status] = (g.byStatus[u.status] ?? 0) + 1;
    if (at && at < g.firstAt) g.firstAt = at;
    if (at && at > g.lastAt) g.lastAt = at;
    if (scanPosition(u.filename)) g.isSplit = true;
  }
  return [...map.values()]
    .map(({_members, ...g}) => g)
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt) || a.source.localeCompare(b.source));
}
