// The Per file list of one scan, as pure logic shared by the list (components/analyst/
// scan-views.tsx) and the one-page review's ‹ › arrows (app/uploads/[id]/page.tsx), so the
// arrows step through exactly the rows the reviewer was looking at: same order, same filters.

import type {FormVersion} from './goldline-extract';
import {scanPageLabel} from './upload-batch';

/** The fields of an upload row this module reads (UploadRow satisfies it). */
export type NavFile = {
  id: string;
  filename: string;
  status: string;
  created_at: string;
  page_kind?: string | null;
  form_version?: string | null;
};

// The best outcome wins when a page was tried several times: a committed or read page
// beats one still processing, which beats a set-aside, which beats a failure; newest
// breaks a tie. Retries and re-uploads each make a fresh row, so a page can have many.
export const STATUS_RANK: Record<string, number> = {committed: 5, needs_review: 4, processing: 3, rejected: 2, failed: 1};

// Each page carries independent facets, filtered on their own rows so they never share a
// chip: its TYPE (what the page is), its review STATUS, and (inventory forms only) VERSION.
export type PageType = 'inventory' | 'sales' | 'blank';
export const TYPE_ORDER: PageType[] = ['inventory', 'sales', 'blank'];
export type PageStatus = 'needs_review' | 'processing' | 'failed' | 'rejected' | 'committed';
export const STATUS_FILTER_ORDER: PageStatus[] = ['needs_review', 'processing', 'failed', 'rejected', 'committed'];
export const VERSION_FILTER_ORDER: FormVersion[] = ['legacy', 'v1', 'v2'];

/** A page Coop couldn't read (or is still reading) has no settled type: no Type chip, it is
 *  found under Status instead. */
export function pageType(u: Pick<NavFile, 'page_kind'>): PageType | null {
  if (u.page_kind === 'sales') return 'sales';
  if (u.page_kind === 'blank') return 'blank';
  if (u.page_kind === 'inventory') return 'inventory';
  return null;
}

export type FileGroup<T extends NavFile> = {idx: number; best: T; others: T[]};

/** One row per scanned page (its best attempt), in scan order. */
export function groupFiles<T extends NavFile>(files: T[]): FileGroup<T>[] {
  const byPage = new Map<number, T[]>();
  for (const f of files) {
    const idx = scanPageLabel(f.filename).index;
    const arr = byPage.get(idx) ?? [];
    arr.push(f);
    byPage.set(idx, arr);
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, rows]) => {
      const sorted = [...rows].sort((a, b) => (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0) || b.created_at.localeCompare(a.created_at));
      return {idx, best: sorted[0], others: sorted.slice(1)};
    });
}

/** The list's filters, as they travel in the URL (`type`, `status`, `fv`; list page `lp`). */
export type FileFilter = {type: PageType | 'all'; status: PageStatus | 'all'; fv: FormVersion | 'all'};

const pick = <T extends string>(allowed: readonly T[], v: string | null | undefined): T | 'all' =>
  (allowed as readonly string[]).includes(v ?? '') ? (v as T) : 'all';

export function parseFileFilter(p: {type?: string | null; status?: string | null; fv?: string | null}): FileFilter {
  return {type: pick(TYPE_ORDER, p.type), status: pick(STATUS_FILTER_ORDER, p.status), fv: pick(VERSION_FILTER_ORDER, p.fv)};
}

/** The three facets combine with AND; Version applies only to inventory forms. */
export function matchesFilter(u: Pick<NavFile, 'status' | 'page_kind' | 'form_version'>, f: FileFilter): boolean {
  return (
    (f.type === 'all' || pageType(u) === f.type) &&
    (f.status === 'all' || u.status === f.status) &&
    (f.fv === 'all' || (pageType(u) === 'inventory' && u.form_version === f.fv))
  );
}

/** Where one file sits in the filtered list, and its neighbours for the ‹ › arrows. A file
 *  outside the filter (an older attempt, a page just committed while filtered to "Needs
 *  review", or a stale link) sits at its scan position: the arrows still step to the nearest
 *  listed pages either side. */
export function fileNeighbours<T extends NavFile>(files: T[], filter: FileFilter, id: string): {prev: T | null; next: T | null} {
  const shown = groupFiles(files).filter((g) => matchesFilter(g.best, filter));
  const at = shown.findIndex((g) => g.best.id === id);
  if (at >= 0) return {prev: shown[at - 1]?.best ?? null, next: shown[at + 1]?.best ?? null};
  const me = files.find((f) => f.id === id);
  const idx = me ? scanPageLabel(me.filename).index : 0;
  const before = shown.filter((g) => g.idx < idx);
  return {prev: before[before.length - 1]?.best ?? null, next: shown.find((g) => g.idx > idx)?.best ?? null};
}

/** A store/BA scope the one-page review stays inside: its arrows, Back and breadcrumb cover
 *  only that store's (or BA's) pages, not the whole scan. */
export type FileScope = {kind: 'store'; code: string} | {kind: 'ba'; name: string} | null;

/** The query that carries the list's filters (and the scan-level version card, plus any
 *  store/BA scope) into a page review, so its arrows and Back keep the same list. `from=file`
 *  marks the one-page view. */
export function fileReviewQuery(filter: FileFilter, version: FormVersion | null, scope: FileScope = null): string {
  const qs = new URLSearchParams({from: 'file'});
  if (filter.type !== 'all') qs.set('type', filter.type);
  if (filter.status !== 'all') qs.set('status', filter.status);
  if (filter.fv !== 'all') qs.set('fv', filter.fv);
  if (version) qs.set('version', version);
  if (scope?.kind === 'store') qs.set('store', scope.code);
  if (scope?.kind === 'ba') qs.set('ba', scope.name);
  return qs.toString();
}

/** The same filters as list-page URL params (for the review's fresh-tab Back fallback). */
export function fileListParams(filter: FileFilter, version: FormVersion | null): URLSearchParams {
  const qs = new URLSearchParams({view: 'file'});
  if (version) qs.set('version', version);
  if (filter.type !== 'all') qs.set('type', filter.type);
  if (filter.status !== 'all') qs.set('status', filter.status);
  if (filter.fv !== 'all') qs.set('fv', filter.fv);
  return qs;
}
