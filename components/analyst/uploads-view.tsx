'use client';

import Link from 'next/link';
import {useEffect, useMemo, useState} from 'react';
import {useRouter} from 'next/navigation';
import {AlertTriangle, CheckCircle2, Clock, Loader2, Search, Trash2, X, XCircle} from 'lucide-react';
import type {StoreOption, UploadKind, UploadRow, UploadStatus} from '@/src/goldline-data';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {BatchUploader} from '@/components/analyst/batch-uploader';
import {DeleteUploadDialog} from '@/components/analyst/delete-upload-dialog';
import {FileTypeBadge} from '@/components/analyst/file-type-badge';
import {Button} from '@/components/ui/button';
import {NativeSelect} from '@/components/ui/native-select';
import {Pagination} from '@/components/analyst/pagination';
import {cn} from '@/lib/utils';

// The Uploads inbox for one company: add a POS .csv or a scanned inventory .pdf
// (BatchUploader — a store's form in one go, live per-file progress), then triage the file list. CSVs commit
// straight to gl_sales; PDFs are read by Claude Vision and land in review — selecting
// one opens its review page. Search, status/type filters (status also from
// ?status=), and pagination run client-side. Deleting goes through a confirmation
// that spells out any committed data it takes with it, then a toast confirms it.

const PAGE_SIZE = 8;

type StatusFilter = 'all' | UploadStatus;
type KindFilter = 'all' | UploadKind;

const STATUS_META: Record<UploadStatus, {label: string; cls: string; Icon: typeof Clock}> = {
  processing: {label: 'Processing', cls: 'text-muted-foreground bg-muted', Icon: Loader2},
  needs_review: {label: 'Needs review', cls: 'text-amber-700 bg-amber-500/15 dark:text-amber-400', Icon: AlertTriangle},
  committed: {label: 'Committed', cls: 'text-emerald-700 bg-emerald-500/15 dark:text-emerald-400', Icon: CheckCircle2},
  failed: {label: 'Failed', cls: 'text-destructive bg-destructive/10', Icon: XCircle},
  rejected: {label: 'Rejected', cls: 'text-destructive bg-destructive/10', Icon: XCircle},
};

function StatusPill({status}: {status: UploadStatus}) {
  const m = STATUS_META[status] ?? STATUS_META.processing;
  const {Icon} = m;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', m.cls)}>
      <Icon className={cn('size-3', status === 'processing' && 'animate-spin')} />
      {m.label}
    </span>
  );
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
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
  const [page, setPage] = useState(1);

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
      return true;
    });
  }, [uploads, query, statusFilter, kindFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">Uploads</h1>
        <p className="text-sm text-muted-foreground">
          Add a store&apos;s inventory form (every page at once) or a POS sales export. Scans are read automatically and wait
          for your review; sales are saved right away.
        </p>
      </header>

      <BatchUploader canEdit={canEdit} configured={configured} stores={stores} />

      {/* File list */}
      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Files</CardTitle>
            <span className="text-xs text-muted-foreground tabular-nums">
              {filtered.length} of {uploads.length}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
                placeholder="Search file name…"
                aria-label="Search file name"
                className="h-8 w-56 rounded-md border border-border bg-background pr-2.5 pl-8 text-sm outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
              />
            </div>
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
              <option value="inventory_pdf">Inventory PDF</option>
            </NativeSelect>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {pageRows.length === 0 ? (
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
                      {u.filename}
                    </Link>
                    <span className="truncate text-xs text-muted-foreground">
                      {u.kind === 'pos_csv' ? 'Sales export' : 'Inventory scan'} · {fmtWhen(u.created_at)}
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
                      <td className="max-w-[20rem] py-2.5 pr-3">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <FileTypeBadge filename={u.filename} />
                          <span className="truncate font-medium" title={u.filename}>
                            {u.filename}
                          </span>
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 text-xs text-muted-foreground">
                        {u.kind === 'pos_csv' ? 'Sales export' : 'Inventory scan'}
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
          <Pagination page={safePage} pageCount={pageCount} onPage={setPage} className="pt-1" />
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
