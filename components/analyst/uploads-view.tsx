'use client';

import Link from 'next/link';
import {useEffect, useMemo, useState} from 'react';
import {useRouter} from 'next/navigation';
import {AlertTriangle, CheckCircle2, ChevronLeft, Clock, FileStack, LayoutGrid, List, Loader2, Search, SlidersHorizontal, Trash2, X, XCircle} from 'lucide-react';
import type {StoreOption, UploadKind, UploadRow, UploadStatus} from '@/src/goldline-data';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {BatchUploader} from '@/components/analyst/batch-uploader';
import {DeleteUploadDialog} from '@/components/analyst/delete-upload-dialog';
import {DeleteScanDialog} from '@/components/analyst/delete-scan-dialog';
import {FileTypeBadge} from '@/components/analyst/file-type-badge';
import {Button} from '@/components/ui/button';
import {NativeSelect} from '@/components/ui/native-select';
import {Pagination} from '@/components/analyst/pagination';
import {cn} from '@/lib/utils';
import {GL_PAGE} from '@/src/goldline-ui';
import {groupUploads, uploadGroupKey, type UploadGroup} from '@/src/goldline-upload-groups';

// The Uploads inbox for one company: add a POS .csv, a Watsons POS Sales Data .xlsx
// (one month, every store) or a scanned inventory .pdf
// (BatchUploader — a store's form in one go, live per-file progress), then triage the file list. CSVs commit
// straight to sales; PDFs are read by Claude Vision and land in review — selecting
// one opens its review page. Search, status/type filters (status also from
// ?status=), and pagination run client-side. Deleting goes through a confirmation
// that spells out any committed data it takes with it, then a toast confirms it.

const ROW_SIZES = [10, 20, 50] as const;
const TILE_SIZES = [12, 24, 36] as const;

export const KIND_LABEL: Record<UploadKind, string> = {pos_csv: 'Sales export', pos_xlsx: 'POS Sales Data', inventory_pdf: 'Inventory scan'};

type StatusFilter = 'all' | UploadStatus;
type KindFilter = 'all' | UploadKind;

const STATUS_META: Record<UploadStatus, {label: string; cls: string; Icon: typeof Clock}> = {
  processing: {label: 'Processing', cls: 'text-muted-foreground bg-muted', Icon: Loader2},
  needs_review: {label: 'Needs review', cls: 'text-amber-700 bg-amber-500/15 dark:text-amber-400', Icon: AlertTriangle},
  committed: {label: 'Committed', cls: 'text-emerald-700 bg-emerald-500/15 dark:text-emerald-400', Icon: CheckCircle2},
  failed: {label: 'Failed', cls: 'text-destructive bg-destructive/10', Icon: XCircle},
  rejected: {label: 'Rejected', cls: 'text-destructive bg-destructive/10', Icon: XCircle},
};

export function StatusPill({status}: {status: UploadStatus}) {
  const m = STATUS_META[status] ?? STATUS_META.processing;
  const {Icon} = m;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', m.cls)}>
      <Icon className={cn('size-3', status === 'processing' && 'animate-spin')} />
      {m.label}
    </span>
  );
}

export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
}

/** "Nov 4, 2026" from a YYYY-MM-DD day. */
function fmtDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
}

/** One drop as a tile: source scan, day, file count, and a status breakdown. The card opens
 *  the scan (its pages sorted into store forms); the trash button deletes the whole drop
 *  through the same confirmation + progress as the scan page, sitting above the open overlay. */
function GroupTile({
  g,
  company,
  canEdit,
  onDeleted,
}: {
  g: UploadGroup;
  company: string;
  canEdit: boolean;
  onDeleted: (info: {files: number; source: string}) => void;
}) {
  const review = g.byStatus.needs_review ?? 0;
  const committed = g.byStatus.committed ?? 0;
  const bad = (g.byStatus.failed ?? 0) + (g.byStatus.rejected ?? 0);
  const processing = g.byStatus.processing ?? 0;
  return (
    <div className="group relative flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-all hover:border-foreground/25 hover:shadow-md focus-within:ring-3 focus-within:ring-ring/40">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <FileStack className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <Link
            href={`/uploads/scan/${encodeURIComponent(g.source)}`}
            title={g.source}
            className="block truncate text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:ring-3 focus-visible:after:ring-ring/40"
          >
            {g.source}
          </Link>
          <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
            {fmtDay(g.day)} · {g.files} {g.files === 1 ? 'file' : 'files'}
          </div>
        </div>
        {canEdit && (
          <DeleteScanDialog
            company={company}
            source={g.source}
            onDeleted={onDeleted}
            trigger={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete scan ${g.source}`}
                className="relative z-10 -mt-1 -mr-1 shrink-0 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </Button>
            }
          />
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {review > 0 && <Tag cls="text-amber-700 bg-amber-500/15 dark:text-amber-400" n={review} label="to review" />}
        {committed > 0 && <Tag cls="text-emerald-700 bg-emerald-500/15 dark:text-emerald-400" n={committed} label="committed" />}
        {bad > 0 && <Tag cls="text-destructive bg-destructive/10" n={bad} label={bad === 1 ? 'issue' : 'issues'} />}
        {processing > 0 && <Tag cls="text-muted-foreground bg-muted" n={processing} label="reading" />}
      </div>
    </div>
  );
}

function Tag({cls, n, label}: {cls: string; n: number; label: string}) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums', cls)}>
      <span className="font-semibold">{n}</span> {label}
    </span>
  );
}

/** A human label for a file row: a page split from a scan reads "Page 10 of 98", with
 *  the raw filename kept as a quiet sub-line; a whole form or sales export keeps its own
 *  (already human) name and has no sub-line. */
function pageLabel(filename: string): {title: string; sub: string | null} {
  const m = /^(.*) \(page (\d+) of (\d+)\)\.pdf$/i.exec(filename);
  return m ? {title: `Page ${m[2]} of ${m[3]}`, sub: filename} : {title: filename, sub: null};
}

type Toast = {id: number; kind: 'ok' | 'err'; text: string};

export function UploadsView({
  company,
  canEdit,
  configured,
  uploads,
  initialStatus = 'all',
  stores = [],
}: {
  company: string;
  canEdit: boolean;
  configured: boolean;
  uploads: UploadRow[];
  initialStatus?: StatusFilter;
  stores?: StoreOption[];
}) {
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(initialStatus);
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [from, setFrom] = useState(''); // YYYY-MM-DD, uploaded on or after
  const [to, setTo] = useState(''); // YYYY-MM-DD, uploaded on or before
  const [page, setPage] = useState(1);
  const [rowSize, setRowSize] = useState<number>(ROW_SIZES[0]); // rows per page (10/20/50)
  const [tileSize, setTileSize] = useState<number>(TILE_SIZES[0]); // tiles per page (12/24/36)
  // 'list' = the flat file table; 'groups' = one tile per drop. Selecting a tile sets
  // `groupKey`, which scopes the list to that drop's files.
  const [view, setView] = useState<'list' | 'groups'>('groups');
  const [groupKey, setGroupKey] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<UploadRow | null>(null);

  // Toasts: short confirmations (deleted, sales saved). Auto-dismiss after 4.5 s;
  // announced politely to screen readers.
  const [toasts, setToasts] = useState<Toast[]>([]);
  function toast(kind: Toast['kind'], text: string) {
    if (!text) return;
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), {id, kind, text}]);
  }
  useEffect(() => {
    if (!toasts.length) return;
    const t = setTimeout(() => setToasts((all) => all.slice(1)), 4500);
    return () => clearTimeout(t);
  }, [toasts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return uploads.filter((u) => {
      if (statusFilter !== 'all' && u.status !== statusFilter) return false;
      if (kindFilter !== 'all' && u.kind !== kindFilter) return false;
      if (q && !u.filename.toLowerCase().includes(q)) return false;
      const day = (u.created_at ?? '').slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (groupKey && uploadGroupKey(u) !== groupKey) return false;
      return true;
    });
  }, [uploads, query, statusFilter, kindFilter, from, to, groupKey]);

  // Groups honour the status/type/search/date filters too, so the tile view narrows
  // with the same controls (but not the group drill-in, which IS the group).
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const forGroups = uploads.filter((u) => {
      if (statusFilter !== 'all' && u.status !== statusFilter) return false;
      if (kindFilter !== 'all' && u.kind !== kindFilter) return false;
      if (q && !u.filename.toLowerCase().includes(q)) return false;
      const day = (u.created_at ?? '').slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    });
    return groupUploads(forGroups);
  }, [uploads, query, statusFilter, kindFilter, from, to]);

  const selectedGroup = groupKey ? groups.find((g) => g.key === groupKey) ?? null : null;

  // The tile grid (grouped view, no drill-in) paginates by tiles; everything else (the
  // flat list, and a group's files) paginates by rows.
  const tileMode = view === 'groups' && !selectedGroup;
  const pageSize = tileMode ? tileSize : rowSize;
  const items = tileMode ? groups : filtered;
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageRows = tileMode ? [] : filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const pageTiles = tileMode ? groups.slice((safePage - 1) * pageSize, safePage * pageSize) : [];
  const hasActiveFilters = Boolean(query || from || to || statusFilter !== 'all' || kindFilter !== 'all');
  const showFilters = filtersOpen || hasActiveFilters;

  return (
    <div className={cn(GL_PAGE, 'gap-8')}>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="font-heading text-xl font-semibold tracking-tight">Uploads</h1>
          <Link
            href="/uploads/forms"
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm transition-colors hover:border-foreground/25"
          >
            <LayoutGrid className="size-3.5 text-muted-foreground" /> All forms
          </Link>
        </div>
        <p className="text-sm text-muted-foreground">
          Add a store&apos;s inventory form (every page at once), a POS sales export, or a month of Watsons POS Sales Data.
          Scans are read automatically and wait for your review; sales are saved right away.
        </p>
      </header>

      <BatchUploader canEdit={canEdit} configured={configured} stores={stores} />

      {/* File list */}
      <Card>
        <CardHeader className="gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {selectedGroup ? (
              <button
                type="button"
                onClick={() => {
                  setGroupKey(null);
                  setPage(1);
                }}
                className="group flex min-w-0 items-center gap-2 text-left"
              >
                <ChevronLeft className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
                <span className="min-w-0">
                  <CardTitle className="truncate">{selectedGroup.source}</CardTitle>
                  <span className="block text-xs text-muted-foreground">{fmtDay(selectedGroup.day)} · back to groups</span>
                </span>
              </button>
            ) : (
              <CardTitle>Files</CardTitle>
            )}
            <div className="flex items-center gap-3">
              {selectedGroup && (
                <Link
                  href={`/uploads/scan/${encodeURIComponent(selectedGroup.source)}`}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium transition-colors hover:border-foreground/25"
                >
                  <LayoutGrid className="size-3.5 text-muted-foreground" /> See forms in this scan
                </Link>
              )}
              <span className="text-xs text-muted-foreground tabular-nums">
                {view === 'groups' && !selectedGroup ? `${groups.length} ${groups.length === 1 ? 'upload' : 'uploads'}` : `${filtered.length} of ${uploads.length}`}
              </span>
              <button
                type="button"
                onClick={() => setFiltersOpen((o) => !o)}
                aria-expanded={showFilters}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium transition-colors hover:border-foreground/25"
              >
                <SlidersHorizontal className="size-3.5 text-muted-foreground" /> Filters
                {hasActiveFilters && <span aria-hidden className="size-1.5 rounded-full bg-primary" />}
              </button>
              {!selectedGroup && (
                <div className="inline-flex rounded-md border border-border p-0.5" role="tablist" aria-label="View">
                  {([['groups', LayoutGrid, 'Grouped'], ['list', List, 'All files']] as const).map(([v, Icon, label]) => (
                    <button
                      key={v}
                      type="button"
                      role="tab"
                      aria-selected={view === v}
                      onClick={() => {
                        setView(v);
                        setPage(1);
                      }}
                      className={cn(
                        'inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors',
                        view === v ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <Icon className="size-3.5" /> {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {showFilters && (
          <div className="flex w-full flex-wrap items-center gap-2 border-t border-border pt-3">
            <div className="relative w-full sm:w-auto">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
                placeholder="Search file name…"
                aria-label="Search file name"
                className="h-8 w-full rounded-md border border-border bg-background pr-2.5 pl-8 text-sm outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 sm:w-56"
              />
            </div>
            {/* Upload date range — applies to both views. */}
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              From
              <input
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPage(1);
                }}
                aria-label="Uploaded on or after"
                className="h-8 rounded-md border border-border bg-background px-2 text-sm outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
              />
            </label>
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              To
              <input
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPage(1);
                }}
                aria-label="Uploaded on or before"
                className="h-8 rounded-md border border-border bg-background px-2 text-sm outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
              />
            </label>
            {(from || to) && (
              <button
                type="button"
                onClick={() => {
                  setFrom('');
                  setTo('');
                  setPage(1);
                }}
                className="h-8 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Clear dates
              </button>
            )}
            <NativeSelect
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as StatusFilter);
                setPage(1);
              }}
            >
              <option value="all">All statuses</option>
              <option value="needs_review">Needs review</option>
              <option value="committed">Committed</option>
              <option value="processing">Processing</option>
              <option value="failed">Failed</option>
              <option value="rejected">Rejected</option>
            </NativeSelect>
            <NativeSelect
              aria-label="Filter by type"
              value={kindFilter}
              onChange={(e) => {
                setKindFilter(e.target.value as KindFilter);
                setPage(1);
              }}
            >
              <option value="all">All types</option>
              <option value="pos_csv">Sales CSV</option>
              <option value="pos_xlsx">POS Sales Data</option>
              <option value="inventory_pdf">Inventory PDF</option>
            </NativeSelect>
          </div>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {view === 'groups' && !selectedGroup ? (
            groups.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {uploads.length === 0 ? 'No files yet. Add one above.' : 'No uploads match.'}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {pageTiles.map((g) => (
                  <GroupTile
                    key={g.key}
                    g={g}
                    company={company}
                    canEdit={canEdit}
                    onDeleted={({files}) => {
                      toast('ok', `Scan deleted · ${files} ${files === 1 ? 'page' : 'pages'} removed`);
                      router.refresh();
                    }}
                  />
                ))}
              </div>
            )
          ) : pageRows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {uploads.length === 0 ? 'No files yet. Add one above.' : 'No files match.'}
            </p>
          ) : (
            <>
            {/* Phones: one card per file — name, type · when, status, delete. */}
            <ul role="list" className="-mx-4 flex flex-col divide-y divide-border border-t border-border md:hidden">
              {pageRows.map((u) => (
                <li key={u.id} className="relative flex items-center gap-3 px-4 py-3">
                  <FileTypeBadge filename={u.filename} />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <Link
                      href={`/uploads/${u.id}`}
                      className="truncate font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                      title={u.filename}
                    >
                      {pageLabel(u.filename).title}
                    </Link>
                    <span className="truncate text-xs text-muted-foreground">
                      {KIND_LABEL[u.kind] ?? 'Inventory scan'} · {fmtWhen(u.created_at)}
                    </span>
                    <StatusPill status={u.status} />
                    {/* Touch screens never show a tooltip: say why it was rejected / failed. */}
                    {u.reject_reason && <span className="text-xs text-muted-foreground">{u.reject_reason}</span>}
                  </div>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${u.filename}`}
                      className="relative z-10 text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteTarget(u)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <div className="overflow-x-auto max-md:hidden">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">File</th>
                    <th className="py-2 pr-3 font-medium">Type</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 font-medium">Uploaded</th>
                    <th className="py-2 pr-3 font-medium">By</th>
                    {canEdit && <th className="py-2 font-medium sr-only">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((u) => (
                    <tr
                      key={u.id}
                      tabIndex={0}
                      role="button"
                      onClick={() => router.push(`/uploads/${u.id}`)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          router.push(`/uploads/${u.id}`);
                        }
                      }}
                      className="cursor-pointer border-b border-border/60 outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50"
                    >
                      <td className="max-w-[22rem] py-2.5 pr-3">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <FileTypeBadge filename={u.filename} />
                          <span className="flex min-w-0 flex-col" title={u.filename}>
                            <span className="truncate font-medium">{pageLabel(u.filename).title}</span>
                            {pageLabel(u.filename).sub && (
                              <span className="truncate font-mono text-[11px] text-muted-foreground">{pageLabel(u.filename).sub}</span>
                            )}
                          </span>
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                        {KIND_LABEL[u.kind] ?? 'Inventory scan'}
                      </td>
                      {/* The pill carries the state; the reason is a hover detail, not a red line per row. */}
                      <td className="py-2.5 pr-3" title={u.reject_reason ?? undefined}>
                        <StatusPill status={u.status} />
                      </td>
                      <td className="py-2.5 pr-3 text-xs text-muted-foreground tabular-nums">{fmtWhen(u.created_at)}</td>
                      <td className="max-w-[12rem] truncate py-2.5 pr-3 text-xs text-muted-foreground">{u.uploaded_by ?? '—'}</td>
                      {canEdit && (
                        <td className="py-2.5 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Delete ${u.filename}`}
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => setDeleteTarget(u)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
          {items.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {tileMode ? 'Tiles' : 'Rows'} per page
                <NativeSelect
                  aria-label={tileMode ? 'Tiles per page' : 'Rows per page'}
                  value={pageSize}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (tileMode) setTileSize(n);
                    else setRowSize(n);
                    setPage(1);
                  }}
                  className="h-8 w-auto"
                >
                  {(tileMode ? TILE_SIZES : ROW_SIZES).map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </NativeSelect>
              </label>
              {pageCount > 1 && <Pagination page={safePage} pageCount={pageCount} onPage={setPage} />}
            </div>
          )}
        </CardContent>
      </Card>

      <DeleteUploadDialog
        company={company}
        upload={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={(text) => {
          setDeleteTarget(null);
          toast('ok', text);
          router.refresh();
        }}
      />

      {/* Toast stack — bottom-right on desktop, bottom-center above the mobile tab bar. */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-50 flex flex-col items-center gap-2 md:inset-x-auto md:right-6 md:bottom-6 md:items-end"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border border-border bg-popover px-3.5 py-3 text-sm text-popover-foreground shadow-lg transition-[opacity,transform] duration-200 ease-out starting:translate-y-2 starting:opacity-0"
          >
            {t.kind === 'ok' ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" style={{color: 'var(--status-good)'}} aria-hidden />
            ) : (
              <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            )}
            <span className="min-w-0 flex-1">{t.text}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
              className="-mr-1 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
