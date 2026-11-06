'use client';

import {useEffect, useMemo, useRef, useState} from 'react';
import Link from 'next/link';
import {AlertTriangle, ArrowRight, Check, ChevronDown, ChevronRight, Loader2, Plus, RotateCcw, Sparkles, Trash2, Upload, X} from 'lucide-react';
import {useUploadQueue, type QueueItem} from '@/components/analyst/upload-queue';
import {eta, groupLabel, groupQueueItems, itemCategory, itemLabel, itemPercent, summarize, CATEGORY_LABEL, FILTER_ORDER, type ItemCategory, type QueueGroup} from '@/components/analyst/upload-queue-format';
import {batchCoverage, FORM_PAGES, groupForms, MAX_BATCH_FILES} from '@/src/upload-batch';
import {reconcileBaNames} from '@/src/goldline-ba-reconcile';
import {FileTypeBadge} from '@/components/analyst/file-type-badge';
import {UploadIllustration} from '@/components/analyst/upload-illustration';
import {StoreCodeField} from '@/components/analyst/store-code-field';
import {Pagination} from '@/components/analyst/pagination';
import type {SplitForm, StoreOption} from '@/src/goldline-data';
import {Card, CardContent} from '@/components/ui/card';
import {Button, buttonVariants} from '@/components/ui/button';
import {cn} from '@/lib/utils';

// The Uploads screen's batch uploader: one store's inventory form for one period,
// added in one go — a PDF per page, or one multi-page PDF (split into pages on drop),
// plus a sales CSV if needed. Files are read 2 at a time; each row shows its own
// progress and detected page; store + period are entered once (prefilled from page
// 1's printed header) and apply to every page. When everything's read, "Review &
// commit" opens the batch review. The queue itself lives in the app shell, so this can
// be left mid-upload — a small indicator follows the user around.

const fmtSize = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const fieldCls =
  'h-9 rounded-md border border-border bg-background px-2.5 text-sm outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-60';

export function BatchUploader({canEdit, configured, stores}: {canEdit: boolean; configured: boolean; stores: StoreOption[]}) {
  const q = useUploadQueue();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // Files staged but not yet submitted — they show on screen and a scan starts reading
  // only once the user hits Upload. The user can keep adding or remove any first.
  const [pending, setPending] = useState<File[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const running = Boolean(q?.items.some((i) => i.state === 'running'));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);

  if (!q) return null;
  const disabled = !canEdit || !configured;
  const s = summarize(q.items, now);
  const busy = s.running + s.waiting > 0;
  const hasItems = q.items.length > 0;
  const pdfItems = q.items.filter((i) => i.kind === 'pdf' && i.state !== 'cancelled');
  const coverage = batchCoverage(pdfItems.filter((i) => i.state === 'done').map((i) => ({page: i.page ?? null})));
  const startedAt = Math.min(...q.items.map((i) => i.startedAt ?? Infinity));
  const left = busy ? eta(Number.isFinite(startedAt) ? startedAt : null, s.percent, now) : null;
  const canReview = !busy && Boolean(q.batch.id) && s.readyForReview > 0;
  // Page numbers restarting (…5, 1…) mean the scan holds several stores' forms; they're
  // split into one batch each once every page is read (q.forms).
  const manyForms = Boolean(q.forms) || groupForms(pdfItems.filter((i) => i.state === 'done').map((i) => ({page: i.page ?? null}))).length > 1;

  // Stage the chosen files (append + de-dupe) instead of reading them straight away — a
  // 98-page scan shouldn't start processing the instant a file is picked, and the user
  // can review the selection, add more, or drop any before confirming.
  const pick = (files: FileList | null | undefined) => {
    if (!files?.length || disabled) return;
    setPending((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      return [...prev, ...Array.from(files).filter((f) => !seen.has(`${f.name}:${f.size}`))];
    });
    if (inputRef.current) inputRef.current.value = '';
  };
  const confirmPending = () => {
    if (pending.length) void q.addFiles(pending);
    setPending([]);
  };
  const removePending = (i: number) => setPending((prev) => prev.filter((_, idx) => idx !== i));

  const dropProps = {
    onDragEnter: (e: React.DragEvent) => {
      e.preventDefault();
      if (!disabled) setDragging(true);
    },
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      pick(e.dataTransfer.files);
    },
  };

  return (
    <Card {...dropProps} className={cn('transition-colors duration-150', dragging && hasItems && 'ring-2 ring-primary/60')}>
      <CardContent className="flex flex-col gap-4">
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".csv,.xlsx,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          disabled={disabled}
          onChange={(e) => pick(e.target.files)}
        />

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="font-heading text-base font-semibold">{!hasItems ? 'Add files' : q.forms ? `${q.forms.length} forms in this scan` : manyForms ? 'Several forms in this scan' : 'This store’s form'}</h2>
            <p className="text-xs text-muted-foreground">
              {hasItems ? (
                busy ? (
                  `Reading ${s.done} of ${s.total} done${left ? ` · ${left}` : ''}. You can keep working; progress follows you.`
                ) : (
                  // Colour-coded so the split reads on first glance: green for what came
                  // through, neutral for pages set aside (sales/blank), red only for real
                  // failures.
                  <>
                    <span
                      className="font-medium tabular-nums"
                      style={{color: s.done > 0 ? 'color-mix(in oklab, var(--status-good) 72%, var(--foreground))' : undefined}}
                    >
                      {s.done} of {s.total} read
                    </span>
                    {s.setAside > 0 && (
                      <>
                        <span aria-hidden> · </span>
                        <span className="font-medium tabular-nums">{s.setAside} set aside</span>
                      </>
                    )}
                    {s.failed > 0 && (
                      <>
                        <span aria-hidden> · </span>
                        <span className="font-medium tabular-nums" style={{color: 'color-mix(in oklab, var(--status-crit) 72%, var(--foreground))'}}>
                          {s.failed} failed
                        </span>
                      </>
                    )}
                    .
                  </>
                )
              ) : (
                `One store’s form, or many stores scanned into one PDF: Coop splits it into one form per store. Up to ${MAX_BATCH_FILES} pages, 25 MB per page (a whole multi-page scan can be much larger).`
              )}
            </p>
          </div>
          {hasItems && !busy && (
            <Button variant="ghost" size="sm" onClick={q.reset}>
              Start a new batch
            </Button>
          )}
        </div>

        {!configured && <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">Uploads aren&apos;t configured for this environment yet.</p>}
        {configured && !canEdit && <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">Your role can view uploads but not add them.</p>}

        {q.notice && (
          <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="flex-1">{q.notice}</span>
            <button type="button" aria-label="Dismiss" onClick={q.dismissNotice} className="rounded p-0.5 hover:bg-destructive/10">
              <X className="size-3.5" />
            </button>
          </p>
        )}

        {!hasItems ? (
          <div
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-disabled={disabled}
            aria-label="Choose files to upload, or drop them here"
            onClick={() => !disabled && inputRef.current?.click()}
            onKeyDown={(e) => {
              if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            {...dropProps}
            className={cn(
              'group flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center outline-none transition-[background-color,border-color] duration-150 ease-out focus-visible:ring-3 focus-visible:ring-ring/40',
              dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-foreground/30 hover:bg-muted/40',
              disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
            )}
          >
            {q.preparing ? (
              <span className="flex size-11 items-center justify-center rounded-full bg-primary/15 text-primary">
                <Loader2 className="size-5 animate-spin" aria-hidden />
              </span>
            ) : (
              <UploadIllustration active={dragging} className="mb-1" />
            )}
            <span className="text-sm">
              <span className="font-medium">{q.preparing ? 'Preparing pages…' : dragging ? 'Drop to add them' : 'Drop files here'}</span>
              {!dragging && !q.preparing && (
                <>
                  <span className="text-muted-foreground"> or </span>
                  <span className="font-medium text-primary underline-offset-4 group-hover:underline">browse</span>
                </>
              )}
            </span>
            <span className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <FileTypeBadge filename="x.pdf" /> Inventory form (pages or whole form)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <FileTypeBadge filename="x.csv" /> POS sales export
              </span>
              <span className="inline-flex items-center gap-1.5">
                <FileTypeBadge filename="x.xlsx" /> POS Sales Data (Watsons, one month)
              </span>
            </span>
          </div>
        ) : (
          <>
            {busy && (
              <div
                role="progressbar"
                aria-label="Batch progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(s.percent)}
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
              >
                <div className="gl-progress-fill h-full min-w-[0.5rem] rounded-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none" style={{width: `${s.percent}%`}} />
              </div>
            )}

            {manyForms ? (
              <FormsPanel forms={q.forms} splitting={q.splitting} busy={busy} stores={stores} />
            ) : (
            <>
            {/* Store + period, once for every page. */}
            <fieldset className="flex flex-col gap-2 rounded-xl border border-border p-3.5" disabled={disabled}>
              <legend className="px-1 text-xs font-medium">
                Store and period <span className="font-normal text-muted-foreground">· applies to every page</span>
              </legend>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Store</span>
                  <StoreCodeField value={q.batch.storeCode} onChange={(code) => q.setBatchInfo({storeCode: code})} stores={stores} disabled={disabled} />
                </div>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">From</span>
                  <input type="date" value={q.batch.periodStart} onChange={(e) => q.setBatchInfo({periodStart: e.target.value})} className={fieldCls} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">To</span>
                  <input
                    type="date"
                    value={q.batch.periodEnd}
                    min={q.batch.periodStart || undefined}
                    onChange={(e) => q.setBatchInfo({periodEnd: e.target.value})}
                    className={fieldCls}
                  />
                </label>
                {q.batch.prefilled && (
                  <span className="mb-2 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                    <Sparkles className="size-3" aria-hidden /> Read from page 1. Check it
                  </span>
                )}
              </div>
              {!q.batch.storeCode && !q.batch.periodStart && pdfItems.length > 0 && !coverage.have.includes(1) && (
                <p className="text-[11px] text-muted-foreground">Page 1 prints the store and period; if it&apos;s not in this batch, enter them here.</p>
              )}
            </fieldset>

            {/* Form pages coverage. */}
            {pdfItems.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Form pages">
                <span className="mr-1 text-muted-foreground">Form pages</span>
                {FORM_PAGES.map((n) => {
                  const have = coverage.have.includes(n);
                  const dup = coverage.duplicates.includes(n);
                  return (
                    <span
                      key={n}
                      title={dup ? `Page ${n} is here twice` : have ? `Page ${n} read` : `No page ${n} yet`}
                      className={cn(
                        'inline-flex h-7 min-w-9 items-center justify-center gap-1 rounded-md border px-2 font-medium tabular-nums',
                        have ? 'border-primary/40 bg-primary/10' : 'border-dashed border-border text-muted-foreground/70',
                        dup && 'border-[color-mix(in_oklab,var(--status-warn)_60%,transparent)] bg-[color-mix(in_oklab,var(--status-warn)_12%,transparent)]',
                      )}
                    >
                      {n}
                      {have && !dup && <Check className="size-3" aria-hidden />}
                      {dup && <AlertTriangle className="size-3" aria-hidden />}
                    </span>
                  );
                })}
                {!busy && coverage.missing.length > 0 && coverage.missing.length < 5 && (
                  <span className="ml-1 text-muted-foreground">Missing page {coverage.missing.join(', ')}. Add it, or commit what&apos;s here.</span>
                )}
                {coverage.duplicates.length > 0 && (
                  <span className="ml-1" style={{color: 'color-mix(in oklab, var(--status-warn) 72%, var(--foreground))'}}>
                    Page {coverage.duplicates.join(', ')} uploaded twice. Remove one.
                  </span>
                )}
              </div>
            )}
            </>
            )}

            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border" aria-label="Files in this batch">
              {groupQueueItems(q.items, now).map((g) =>
                g.isSplit ? (
                  <GroupRow key={g.key} g={g} batchId={manyForms ? null : (q.batch.id ?? null)} now={now} api={q} />
                ) : (
                  <FileRow key={g.items[0].id} i={g.items[0]} batchId={manyForms ? null : (q.batch.id ?? null)} now={now} onRetry={() => q.retry(g.items[0].id)} onCancel={() => q.cancel(g.items[0].id)} onRemove={() => q.remove(g.items[0].id)} />
                ),
              )}
            </ul>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="outline" size="sm" disabled={disabled || q.preparing} onClick={() => inputRef.current?.click()}>
                {q.preparing ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                {q.preparing ? 'Preparing pages…' : 'Add more files'}
              </Button>
              {q.batch.id && s.readyForReview > 0 && !manyForms && (
                <Link
                  href={`/uploads/batch/${q.batch.id}`}
                  aria-disabled={!canReview}
                  className={cn(buttonVariants({size: 'sm'}), !canReview && 'pointer-events-none opacity-50')}
                >
                  Review &amp; commit {s.readyForReview} {s.readyForReview === 1 ? 'page' : 'pages'} <ArrowRight className="size-3.5" />
                </Link>
              )}
            </div>
          </>
        )}

        {/* Staging tray: the files picked but not yet submitted. Shown on screen so the
            user can add more (drop/browse above) or remove any, then confirm with Upload. */}
        {pending.length > 0 && (
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/20 p-3.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium">
                {pending.length} {pending.length === 1 ? 'file' : 'files'} ready to upload
              </span>
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {fmtSize(pending.reduce((a, f) => a + f.size, 0))}
              </span>
            </div>
            <ul className="flex max-h-56 flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border bg-background">
              {pending.map((f, i) => (
                <li key={`${f.name}-${f.size}-${i}`} className="flex items-center gap-2.5 px-3 py-2">
                  <FileTypeBadge filename={f.name} />
                  <span className="min-w-0 flex-1 truncate text-sm" title={f.name}>{f.name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{fmtSize(f.size)}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${f.name}`}
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => removePending(i)}
                  >
                    <X className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Add more above, or remove any, then upload.</span>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setPending([])}>Clear</Button>
                <Button size="sm" onClick={confirmPending} disabled={disabled}>
                  <Upload className="size-3.5" /> Upload {pending.length} {pending.length === 1 ? 'file' : 'files'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// How many per-page rows to show at once when a scan group is expanded — a 98-page
// scan paginates instead of unrolling the whole list.
const PAGES_PER_VIEW = 12;

// A multi-page scan collapses to ONE row: the source PDF, an aggregate "N of M read"
// line and progress, with a chevron to expand the per-page rows. Keeps a 98-page
// upload from flooding the list (plan §06 UX). Collapsed by default; the expanded
// per-page rows are paged so even a 98-page scan stays navigable.
function GroupRow({g, batchId, now, api}: {g: QueueGroup; batchId: string | null; now: number; api: NonNullable<ReturnType<typeof useUploadQueue>>}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<'all' | ItemCategory>('all');
  // How many pages fall in each plain-language bucket, for the filter chips + counts.
  const counts = useMemo(() => {
    const c = {} as Record<ItemCategory, number>;
    for (const i of g.items) {
      const k = itemCategory(i);
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [g.items]);
  const present = FILTER_ORDER.filter((c) => (counts[c] ?? 0) > 0);
  // Pages the user just hit retry on: keep them in view while they re-read (even under a
  // filter they no longer match) so the row shows "Retrying…" in place instead of popping
  // out the instant the icon is clicked.
  const [retrying, setRetrying] = useState<Set<string>>(() => new Set());
  const handleRetry = (id: string) => {
    setRetrying((s) => new Set(s).add(id));
    api.retry(id);
  };
  const filtered =
    filter === 'all'
      ? g.items
      : g.items.filter((i) => itemCategory(i) === filter || (retrying.has(i.id) && itemCategory(i) === 'working'));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGES_PER_VIEW));
  const safePage = Math.min(page, pageCount);
  const shown = filtered.slice((safePage - 1) * PAGES_PER_VIEW, safePage * PAGES_PER_VIEW);
  const choose = (f: 'all' | ItemCategory) => {
    setFilter(f);
    setPage(1);
  };
  const pct = g.total ? Math.round((g.done / g.total) * 100) : 0;
  const working = g.running > 0 || g.waiting > 0;
  const allDone = g.done === g.total && g.total > 0;
  return (
    <li className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-3 px-3.5 py-2.5 text-left transition-colors duration-150 ease-out hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
      >
        <FileTypeBadge filename="scan.pdf" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-sm font-medium" title={g.source}>{g.source}</span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{g.total} pages · {fmtSize(g.size)}</span>
          </div>
          <span className="truncate text-xs" style={g.failed ? {color: 'color-mix(in oklab, var(--status-crit) 72%, var(--foreground))'} : undefined}>
            {groupLabel(g)}
          </span>
          {working && (
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className="gl-progress-fill h-full rounded-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none" style={{width: `${pct}%`}} />
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {allDone && <Check className="size-4" style={{color: 'var(--status-good)'}} aria-label="All pages read" />}
          <ChevronDown aria-hidden className={cn('size-4 text-muted-foreground transition-transform duration-150', open && 'rotate-180')} />
        </div>
      </button>
      {open && (
        <div className="flex flex-col border-t border-border bg-muted/20">
          {/* Filter chips — only when there's more than one bucket to sort between. A
              "Show" label + a separator line make the row read as a control, and the
              failures chip is tinted so it doesn't blend in. */}
          {present.length >= 2 && (
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-3" role="group" aria-label="Filter pages">
              <span className="mr-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Show</span>
              <FilterChip active={filter === 'all'} onClick={() => choose('all')}>
                All <span className="tabular-nums opacity-70">{g.items.length}</span>
              </FilterChip>
              {present.map((c) => (
                <FilterChip key={c} active={filter === c} tone={c === 'failed' ? 'crit' : 'default'} onClick={() => choose(c)}>
                  {CATEGORY_LABEL[c]} <span className="tabular-nums opacity-70">{counts[c]}</span>
                </FilterChip>
              ))}
            </div>
          )}
          <ul className="flex flex-col divide-y divide-border pl-3" aria-label={`Pages of ${g.source}`}>
            {shown.map((i) => (
              <FileRow key={i.id} i={i} batchId={batchId} now={now} retrying={retrying.has(i.id)} onRetry={() => handleRetry(i.id)} onCancel={() => api.cancel(i.id)} onRemove={() => api.remove(i.id)} />
            ))}
          </ul>
          {pageCount > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2">
              <span className="text-[11px] text-muted-foreground tabular-nums">
                Showing {(safePage - 1) * PAGES_PER_VIEW + 1} to {Math.min(safePage * PAGES_PER_VIEW, filtered.length)} of {filtered.length}
              </span>
              <Pagination page={safePage} pageCount={pageCount} onPage={setPage} label={`Pages of ${g.source}`} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** A calm status pill: muted for the "set aside" kinds, red only for a genuine error. */
function CategoryPill({cat}: {cat: ItemCategory}) {
  const crit = cat === 'failed';
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={crit ? {color: 'color-mix(in oklab, var(--status-crit) 72%, var(--foreground))', background: 'color-mix(in oklab, var(--status-crit) 14%, transparent)'} : {background: 'var(--muted)', color: 'var(--foreground)'}}
    >
      {CATEGORY_LABEL[cat]}
    </span>
  );
}

function FileRow({i, batchId, now, onRetry, onCancel, onRemove, retrying = false}: {i: QueueItem; batchId: string | null; now: number; onRetry: () => void; onCancel: () => void; onRemove: () => void; retrying?: boolean}) {
  const pct = itemPercent(i, now);
  const failed = i.state === 'failed';
  const done = i.state === 'done';
  const cat = itemCategory(i);
  // The user just hit retry and it's re-reading: show "Retrying…" in place (spinner +
  // a soft active tint), so the click lands as visible feedback, not a vanishing row.
  const isRetrying = retrying && (i.state === 'queued' || i.state === 'running');
  // A read page opens the batch review on that page's tab (the same view as "Review &
  // commit"), so there is one place to review. The whole row is the target (stretched
  // link), so there's no small "Open" to aim for.
  const href = done && i.uploadId && i.kind === 'pdf' ? (batchId ? `/uploads/batch/${batchId}?page=${i.uploadId}` : `/uploads/${i.uploadId}`) : null;
  return (
    <li
      className={cn(
        'relative flex items-center gap-3 px-3.5 py-2.5 transition-colors duration-300 ease-out',
        i.state === 'cancelled' && 'opacity-50',
        isRetrying && 'bg-primary/5',
        href && 'hover:bg-muted/60 has-[a:focus-visible]:bg-muted/60',
      )}
    >
      {href && (
        <Link
          href={href}
          aria-label={`Review ${i.name}${i.page ? ` (page ${i.page})` : ''}`}
          title={i.name}
          className="absolute inset-0 z-0 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        />
      )}
      <FileTypeBadge filename={i.name} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-sm font-medium" title={i.name}>
            {i.name}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{fmtSize(i.size)}</span>
        </div>
        {isRetrying ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium" style={{color: 'color-mix(in oklab, var(--primary) 70%, var(--foreground))'}}>
            <Loader2 className="size-3 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
            <span className="truncate">Retrying…{i.state === 'running' ? ' reading the page' : ''}</span>
          </span>
        ) : cat === 'sales' || cat === 'blank' || cat === 'other' ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <CategoryPill cat={cat} /> <span className="truncate">set aside, not counted</span>
          </span>
        ) : cat === 'failed' ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <CategoryPill cat={cat} /> <span className="truncate">{i.error ?? 'Please try again.'}</span>
          </span>
        ) : (
          <span
            className="truncate text-xs text-muted-foreground"
            style={done && i.flagged ? {color: 'color-mix(in oklab, var(--status-warn) 72%, var(--foreground))'} : undefined}
          >
            {itemLabel(i)}
          </span>
        )}
        {i.state === 'running' && (
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none" style={{width: `${pct}%`}} />
          </div>
        )}
      </div>
      {/* Icons let clicks fall through to the row link; only the buttons catch them. */}
      <div className="pointer-events-none relative z-10 flex shrink-0 items-center gap-1 [&_button]:pointer-events-auto">
        {done && <Check className="size-4" style={{color: 'var(--status-good)'}} aria-label="Done" />}
        {href && <ChevronRight aria-hidden className="size-4 text-muted-foreground" />}
        {failed && (
          <Button variant="ghost" size="icon-sm" aria-label={`Retry ${i.name}`} onClick={onRetry}>
            <RotateCcw className="size-3.5" />
          </Button>
        )}
        {(i.state === 'running' || i.state === 'queued' || i.state === 'waiting_period') && (
          <Button variant="ghost" size="icon-sm" aria-label={`Cancel ${i.name}`} onClick={onCancel}>
            <X className="size-3.5" />
          </Button>
        )}
        {(failed || i.state === 'cancelled') && (
          <Button variant="ghost" size="icon-sm" aria-label={`Remove ${i.name} from the list`} onClick={onRemove}>
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
    </li>
  );
}

/** A toggle chip for the per-scan page filter (All / Read / Couldn't read / …). `crit`
 *  tints the failures chip red so it stands out from the calm set-aside buckets. */
function FilterChip({active, onClick, tone = 'default', children}: {active: boolean; onClick: () => void; tone?: 'default' | 'crit'; children: React.ReactNode}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
        tone === 'crit'
          ? active
            ? 'border-[color:var(--status-crit)] bg-[color:var(--status-crit)]/15 text-[color:var(--status-crit)]'
            : 'border-[color:var(--status-crit)]/40 bg-[color:var(--status-crit)]/5 text-[color:var(--status-crit)] hover:bg-[color:var(--status-crit)]/12'
          : active
            ? 'border-primary bg-primary/15 text-foreground'
            : 'border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

const pageList = (pages: number[]) => {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  if (!sorted.length) return 'pages not numbered';
  const run = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
  return run && sorted.length > 1 ? `pages ${sorted[0]} to ${sorted.at(-1)}` : `${sorted.length === 1 ? 'page' : 'pages'} ${sorted.join(', ')}`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}` : iso);

type FormRow = SplitForm & {baLabel: string | null};
type StoreGroup = {key: string; code: string | null; name: string; forms: FormRow[]};

// Hick's Law: a 98-page scan can split into dozens of forms, and the same store's
// periods pile up as near-identical rows. Collapse that into one group per store
// (name once, its periods under it) and page through a handful of stores at a time,
// so the reviewer picks a store, not scans a wall. Forms with no store read sit first.
const STORES_PER_PAGE = 6;

/** Several stores in one scan: forms grouped by store, BA names reconciled, paged. */
function FormsPanel({forms, splitting, busy, stores}: {forms: SplitForm[] | null; splitting: boolean; busy: boolean; stores: StoreOption[]}) {
  const [page, setPage] = useState(1);
  const nameOf = useMemo(() => new Map(stores.map((s) => [s.code, s.name])), [stores]);
  const groups = useMemo<StoreGroup[]>(() => {
    if (!forms) return [];
    // One canonical BA spelling across the scan, so "LEONISA RAMOS" and "Leonisa Ramo"
    // read as one person (no registry here — cluster the written names among themselves).
    const baCanon = reconcileBaNames(forms.map((f) => f.consultant));
    const canonBa = (c: string | null) => (c?.trim() ? baCanon.get(c.trim()) ?? c.trim() : null);
    const by = new Map<string, StoreGroup>();
    for (const f of forms) {
      const key = f.storeCode ?? '__nostore__';
      const g =
        by.get(key) ??
        {key, code: f.storeCode, name: f.storeCode ? nameOf.get(f.storeCode) ?? `Store ${f.storeCode}` : 'Store not on the form', forms: []};
      g.forms.push({...f, baLabel: canonBa(f.consultant)});
      by.set(key, g);
    }
    // Forms missing a store come first (they need one picked), then stores A→Z.
    return [...by.values()].sort((a, b) => (a.code === null ? -1 : b.code === null ? 1 : a.name.localeCompare(b.name)));
  }, [forms, nameOf]);

  if (!forms) {
    return (
      <p className="flex items-center gap-2 rounded-xl border border-border px-3.5 py-3 text-sm text-muted-foreground">
        {splitting && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />}
        {busy
          ? 'This scan holds more than one store’s form. Coop splits it into one form per store once every page is read.'
          : 'Splitting the scan into one form per store…'}
      </p>
    );
  }

  const blank = forms.filter((f) => !f.storeCode).length;
  const pageCount = Math.max(1, Math.ceil(groups.length / STORES_PER_PAGE));
  const safePage = Math.min(page, pageCount);
  const shown = groups.slice((safePage - 1) * STORES_PER_PAGE, safePage * STORES_PER_PAGE);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Each form is its own review, grouped by store. {blank ? `${blank} ${blank === 1 ? 'form has' : 'forms have'} no store written on page 1; pick the store when you review ${blank === 1 ? 'it' : 'them'}.` : 'Store and period were read from each page 1. Check them when you review.'}
      </p>

      {shown.map((g) => (
        <section key={g.key} className="flex flex-col gap-1.5" aria-label={g.name}>
          <div className="flex items-baseline justify-between gap-3 px-0.5">
            <h3 className="flex min-w-0 items-baseline gap-2">
              <span className={cn('truncate text-sm font-semibold', g.code === null && 'text-[color:var(--status-crit)]')}>{g.name}</span>
              {g.code && <span className="shrink-0 font-mono text-xs font-normal text-muted-foreground">· {g.code}</span>}
            </h3>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {g.forms.length} {g.forms.length === 1 ? 'form' : 'forms'}
            </span>
          </div>
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
            {g.forms.map((f) => {
              const period = f.periodStart && f.periodEnd ? `${fmtDay(f.periodStart)} to ${fmtDay(f.periodEnd)}` : null;
              const sub = [period ? pageList(f.pages) : null, f.baLabel ? `BA ${f.baLabel}` : null].filter(Boolean).join(' · ');
              return (
                <li key={f.batchId}>
                  <Link href={`/uploads/batch/${f.batchId}`} className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm transition-colors duration-150 hover:bg-muted/50">
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium">{period ?? pageList(f.pages)}</span>
                      {sub && <span className="truncate text-xs text-muted-foreground">{sub}</span>}
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
                      Review <ChevronRight className="size-3.5" aria-hidden />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {pageCount > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
          <span className="text-xs text-muted-foreground tabular-nums">
            {groups.length} stores · page {safePage} of {pageCount}
          </span>
          <Pagination page={safePage} pageCount={pageCount} onPage={setPage} label="Forms by store" />
        </div>
      )}
    </div>
  );
}
