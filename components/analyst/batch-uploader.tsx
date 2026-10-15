'use client';

import {useEffect, useRef, useState} from 'react';
import Link from 'next/link';
import {AlertTriangle, ArrowRight, Check, ChevronRight, CloudUpload, Loader2, Plus, RotateCcw, Sparkles, Trash2, X} from 'lucide-react';
import {useUploadQueue, type QueueItem} from '@/components/analyst/upload-queue';
import {eta, itemLabel, itemPercent, summarize} from '@/components/analyst/upload-queue-format';
import {batchCoverage, FORM_PAGES, MAX_BATCH_FILES} from '@/src/upload-batch';
import {FileTypeBadge} from '@/components/analyst/file-type-badge';
import {StoreCodeField} from '@/components/analyst/store-code-field';
import type {StoreOption} from '@/src/goldline-data';
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

  const pick = (files: FileList | null | undefined) => {
    if (!files?.length || disabled) return;
    void q.addFiles(Array.from(files));
    if (inputRef.current) inputRef.current.value = '';
  };

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
          accept=".csv,.pdf,text/csv,application/pdf"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          disabled={disabled}
          onChange={(e) => pick(e.target.files)}
        />

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="font-heading text-base font-semibold">{hasItems ? 'This store’s form' : 'Add files'}</h2>
            <p className="text-xs text-muted-foreground">
              {hasItems
                ? busy
                  ? `Reading ${s.done} of ${s.total} done${left ? ` · ${left}` : ''}. You can keep working; progress follows you.`
                  : `${s.done} of ${s.total} read${s.failed ? ` · ${s.failed} failed` : ''}.`
                : `One store’s pages at a time: a PDF per page or one PDF with every page. Up to ${MAX_BATCH_FILES} files, 25 MB each.`}
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
              'group flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center outline-none transition-[background-color,border-color] duration-150 ease-out focus-visible:ring-3 focus-visible:ring-ring/40',
              dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-foreground/30 hover:bg-muted/40',
              disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
            )}
          >
            <span className={cn('flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground transition-transform duration-200 ease-out', dragging && 'scale-110 bg-primary/15 text-primary')}>
              {q.preparing ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <CloudUpload className="size-5" aria-hidden />}
            </span>
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
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              >
                <div className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none" style={{width: `${s.percent}%`}} />
              </div>
            )}

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

            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border" aria-label="Files in this batch">
              {q.items.map((i) => (
                <FileRow key={i.id} i={i} batchId={q.batch.id ?? null} now={now} onRetry={() => q.retry(i.id)} onCancel={() => q.cancel(i.id)} onRemove={() => q.remove(i.id)} />
              ))}
            </ul>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="outline" size="sm" disabled={disabled || q.preparing} onClick={() => inputRef.current?.click()}>
                {q.preparing ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                {q.preparing ? 'Preparing pages…' : 'Add more files'}
              </Button>
              {q.batch.id && s.readyForReview > 0 && (
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
      </CardContent>
    </Card>
  );
}

function FileRow({i, batchId, now, onRetry, onCancel, onRemove}: {i: QueueItem; batchId: string | null; now: number; onRetry: () => void; onCancel: () => void; onRemove: () => void}) {
  const pct = itemPercent(i, now);
  const failed = i.state === 'failed';
  const done = i.state === 'done';
  // A read page opens the batch review on that page's tab (the same view as "Review &
  // commit"), so there is one place to review. The whole row is the target (stretched
  // link), so there's no small "Open" to aim for.
  const href = done && i.uploadId && i.kind === 'pdf' ? (batchId ? `/uploads/batch/${batchId}?page=${i.uploadId}` : `/uploads/${i.uploadId}`) : null;
  return (
    <li
      className={cn(
        'relative flex items-center gap-3 px-3.5 py-2.5',
        i.state === 'cancelled' && 'opacity-50',
        href && 'transition-colors duration-150 ease-out hover:bg-muted/60 has-[a:focus-visible]:bg-muted/60',
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
        <span
          className={cn('truncate text-xs', failed ? 'text-destructive' : 'text-muted-foreground')}
          style={done && i.flagged ? {color: 'color-mix(in oklab, var(--status-warn) 72%, var(--foreground))'} : undefined}
          title={failed ? i.error : undefined}
        >
          {itemLabel(i)}
        </span>
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
