'use client';

import {useMemo, useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {ArrowLeft, ArrowRight, CheckCircle2, ExternalLink, FileText, Loader2, Maximize2, X} from 'lucide-react';
import type {ExtractionRecord, FormPageStrip, StoreOption, UploadRow} from '@/src/goldline-data';
import {StoreCodeField} from '@/components/analyst/store-code-field';
import type {ExtractedRow} from '@/src/goldline-extract-run';
import {commitReview} from '@/app/uploads/actions';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {cn} from '@/lib/utils';
import {DocumentConfidence} from '@/components/analyst/document-confidence';
import {reviewRowEl, ReviewRows, type ColKey, type ReviewView} from '@/components/analyst/review-rows';
import {LOW_BELOW, rowConfidence, toneText} from '@/src/review-confidence';
import {pageTotal, reconcile, stepFlag, unresolvedFlags, type CatalogLite} from '@/src/review-workbench';

// Review workbench for one scanned inventory page. Shows the staged Claude Vision
// read, pre-filled and editable; low-confidence rows are flagged so the reviewer
// fixes the exceptions, confirms the header (store + period), and commits to
// inventory. A sales CSV has no extraction, so it renders a status summary.

const LOW = LOW_BELOW; // below this a row is flagged for human eyes (shared with the confidence summary).
const peso = (n: number) => `₱${n.toLocaleString('en-US', {maximumFractionDigits: 0})}`;

type EditRow = ExtractedRow;

function toIntOrNull(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function UploadReview({
  company,
  canEdit,
  upload,
  extraction,
  scanUrl,
  productNames = {},
  inventoryHref = null,
  catalog = {},
  pageStrip = null,
  stores = [],
}: {
  company: string;
  canEdit: boolean;
  upload: UploadRow;
  extraction: ExtractionRecord | null;
  /** Same-origin proxy path to the stored scan (streams the private file), or null. */
  scanUrl?: string | null;
  /** item_code → printed product name (from the page manifest), for the rows table. */
  productNames?: Record<string, string>;
  /** Inventory page for the store + period this scan was committed to, once committed. */
  inventoryHref?: string | null;
  /** item_code → printed product line + price (catalog), for the form grid and totals check. */
  catalog?: Record<string, CatalogLite>;
  /** Form pages 1–5 of THIS form (same count, or the same upload batch), with flags. */
  pageStrip?: FormPageStrip | null;
  /** The company's stores, for the store picker. */
  stores?: StoreOption[];
}) {
  const router = useRouter();
  const committed = upload.status === 'committed' || extraction?.status === 'confirmed';
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const head = extraction?.data;
  const [rows, setRows] = useState<EditRow[]>(() => (head?.rows ?? []).map((r) => ({...r})));
  const [storeCode, setStoreCode] = useState(head?.store_code ?? '');
  const [periodStart, setPeriodStart] = useState(head?.period_start ?? '');
  const [periodEnd, setPeriodEnd] = useState(head?.period_end ?? '');
  // Flags = rows under the threshold, fixed at load (editing a value doesn't change
  // the reader's confidence). A flag is resolved by editing its row or "Looks right".
  const flagged = useMemo(
    () => (head?.rows ?? []).map((r, i) => ({c: rowConfidence(r.confidence), i})).filter((x) => x.c < LOW).map((x) => x.i),
    [head],
  );
  const [resolved, setResolved] = useState<Set<number>>(() => new Set());
  const [active, setActive] = useState<number | null>(null);
  const [view, setView] = useState<ReviewView>(flagged.length ? 'needs' : 'all');
  const [formTotal, setFormTotal] = useState('');
  const [query, setQuery] = useState(''); // the rows search, lifted so jumping to a flag can clear it
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{kind: 'ok' | 'err'; text: string} | null>(null);

  const docConfidence = extraction?.docConfidence ?? null;
  const open = unresolvedFlags(flagged, resolved);
  const totals = useMemo(() => pageTotal(rows, catalog), [rows, catalog]);
  const check = reconcile(totals.total, formTotal);

  function updateCell(index: number, key: ColKey, raw: string) {
    setRows((prev) => {
      const next = [...prev];
      next[index] = {...next[index], [key]: toIntOrNull(raw)};
      return next;
    });
    // Correcting a flagged row resolves it — only when the value actually changes.
    const original = head?.rows?.[index]?.[key] ?? null;
    if (flagged.includes(index) && toIntOrNull(raw) !== original) resolve(index);
  }

  function resolve(index: number) {
    setResolved((prev) => (prev.has(index) ? prev : new Set(prev).add(index)));
  }

  /** Move the navigator to a flag and bring its row into view (first input focused). */
  function goToFlag(index: number | null) {
    if (index == null) return;
    setActive(index);
    setQuery(''); // a search could be hiding the target row
    requestAnimationFrame(() => {
      const row = reviewRowEl(index);
      row?.scrollIntoView({behavior: 'smooth', block: 'center'});
      row?.querySelector<HTMLInputElement>('input')?.focus({preventScroll: true});
    });
  }

  async function commit() {
    setBusy(true);
    setNotice(null);
    const res = await commitReview({
      company,
      uploadId: upload.id,
      storeCode,
      periodStart,
      periodEnd,
      consultant: head?.consultant ?? null,
      rows: rows.map((r) => ({
        item_code: r.item_code,
        stockroom: r.stockroom,
        drawer: r.drawer,
        selling_area: r.selling_area,
        delivery: r.delivery,
        ending_on_hand: r.ending_on_hand,
      })),
    });
    setBusy(false);
    if (res.ok) {
      setNotice({kind: 'ok', text: `Committed ${res.committed} inventory rows.`});
      router.refresh();
    } else {
      setNotice({kind: 'err', text: res.error});
    }
  }

  // Two-column only when there's a scan to show beside the workbench (inventory PDF).
  const twoCol = Boolean(scanUrl && extraction);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-6">
      <div className="flex flex-col gap-1">
        <Link href="/uploads" className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Back to uploads
        </Link>
        <h1 className="font-heading text-xl font-semibold tracking-tight break-all">{upload.filename}</h1>
        {extraction && pageStrip && (
          <nav aria-label="Form pages" className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="mr-1 text-muted-foreground">
              {pageStrip.scope === 'count' ? 'Pages in this count' : pageStrip.scope === 'batch' ? 'Pages in this batch' : 'Pages uploaded with this one'}
            </span>
            {pageStrip.cells.map((p) => {
              const inner = (
                <>
                  {p.page}
                  {p.status === 'committed' ? (
                    <CheckCircle2 aria-label="committed" className="size-3" style={{color: toneText('var(--status-good)')}} />
                  ) : p.flagged > 0 ? (
                    <span aria-label={`${p.flagged} flagged`} className="size-1.5 rounded-full" style={{background: 'var(--status-crit)'}} />
                  ) : null}
                </>
              );
              const cls = cn(
                'inline-flex h-7 min-w-9 items-center justify-center gap-1 rounded-md border px-2 font-medium tabular-nums transition-colors',
                p.current ? 'border-primary bg-primary/10 text-foreground' : 'border-border',
              );
              if (p.current) return <span key={p.page} className={cls} aria-current="page">{inner}</span>;
              if (!p.uploadId)
                return (
                  <span
                    key={p.page}
                    className={cn(cls, 'border-dashed text-muted-foreground/60')}
                    title={pageStrip.scope === 'batch' ? 'No readable scan of this page in this batch' : 'No scan of this page in this form yet'}
                  >
                    {p.page}
                  </span>
                );
              return (
                <Link key={p.page} href={`/uploads/${p.uploadId}`} className={cn(cls, 'hover:bg-muted')} title={`Open page ${p.page} of this form`}>
                  {inner}
                </Link>
              );
            })}
            <span className="ml-1 text-[11px] text-muted-foreground">red dot = has flags · ✓ committed</span>
            {pageStrip.batchId && (
              <Link href={`/uploads/batch/${pageStrip.batchId}`} className="ml-1 text-[11px] font-medium text-primary underline-offset-4 hover:underline">
                Review the batch
              </Link>
            )}
          </nav>
        )}
      </div>

      {committed && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-emerald-500/15 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          <span className="inline-flex items-center gap-2">
            <CheckCircle2 className="size-4" /> This upload is committed.
          </span>
          {inventoryHref && (
            <Link href={inventoryHref} className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline">
              View in Inventory <ArrowRight className="size-3.5" />
            </Link>
          )}
        </div>
      )}

      <div className={cn('flex flex-col gap-5', twoCol && 'lg:flex-row lg:items-start')}>
        {/* Left: scan preview, pinned under the app header while the rows scroll (desktop);
            sized to the viewport so it's always fully in view. Click to enlarge. */}
        {scanUrl && (
          <div className="lg:sticky lg:top-[calc(3.5rem+1rem)] lg:w-[28%] lg:shrink-0">
            <Card>
              <CardHeader className="gap-0">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="inline-flex items-center gap-2 text-sm">
                    <FileText className="size-3.5 text-muted-foreground" /> Scan
                  </CardTitle>
                  <a href={scanUrl} target="_blank" rel="noopener noreferrer">
                    <Button variant="ghost" size="xs">
                      <ExternalLink className="size-3.5" /> Open
                    </Button>
                  </a>
                </div>
              </CardHeader>
              <CardContent>
                {/* Click the thumbnail to enlarge. The iframe is pointer-events-none so the
                    click lands on the button overlay, not the embedded PDF viewer. */}
{/* Phones can't show a PDF inside the page — open it in the phone's viewer instead. */}
                <a
                  href={scanUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-3 text-sm transition-colors active:bg-muted md:hidden"
                >
                  <FileText aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium">View the scan</span>
                    <span className="text-xs text-muted-foreground">Opens the PDF to compare with the rows below</span>
                  </span>
                  <ExternalLink aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                </a>
                <button
                  type="button"
                  onClick={() => setLightboxOpen(true)}
                  className="group relative block w-full overflow-hidden rounded-md border border-border bg-muted max-md:hidden"
                  aria-label="Enlarge scan"
                >
                  <iframe
                    src={scanUrl}
                    title="Scanned inventory form"
                    tabIndex={-1}
                    className="pointer-events-none h-[360px] w-full lg:h-[min(640px,calc(100dvh-12rem))]"
                  />
                  <span className="absolute inset-0 flex items-end justify-center bg-gradient-to-t from-black/40 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
                    <span className="inline-flex items-center gap-1 rounded-md bg-background/90 px-2 py-1 text-xs font-medium text-foreground">
                      <Maximize2 className="size-3" /> Click to enlarge
                    </span>
                  </span>
                </button>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Right: the review content (~72% when two-column). */}
        <div className="flex min-w-0 flex-1 flex-col gap-5">

      {/* CSV / no-extraction summary */}
      {!extraction && (
        <Card>
          <CardHeader>
            <CardTitle>{upload.kind === 'pos_csv' ? 'Sales CSV' : 'Upload'}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <p className="text-muted-foreground">
              {upload.kind === 'pos_csv'
                ? 'Sales files commit directly to the sales table, so there is nothing to review here.'
                : 'No extraction is staged for this file.'}
            </p>
            <p>
              Status: <span className="font-medium">{upload.status}</span>
            </p>
            {upload.reject_reason && <p className="text-destructive">{upload.reject_reason}</p>}
          </CardContent>
        </Card>
      )}

      {/* PDF review workbench */}
      {extraction && (
        <>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <CardTitle>Document</CardTitle>
                {extraction.page ? (
                  <span className="text-xs text-muted-foreground">Inventory form · page {extraction.page} of 5</span>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <DocumentConfidence
                docConfidence={docConfidence}
                rowConfidences={rows.map((r) => r.confidence)}
                onReviewFlagged={() => {
                  setView('needs');
                  goToFlag(open[0] ?? flagged[0] ?? null);
                }}
              />

              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-xs font-medium text-muted-foreground">Which store and period is this count for?</legend>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium">Store</span>
                    <StoreCodeField value={storeCode} onChange={setStoreCode} stores={stores} disabled={committed || !canEdit} />
                  </div>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium">Period start</span>
                    <input
                      type="date"
                      value={periodStart ?? ''}
                      onChange={(e) => setPeriodStart(e.target.value)}
                      disabled={committed || !canEdit}
                      className="h-9 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-60"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium">Period end</span>
                    <input
                      type="date"
                      value={periodEnd ?? ''}
                      min={periodStart || undefined}
                      onChange={(e) => setPeriodEnd(e.target.value)}
                      disabled={committed || !canEdit}
                      className="h-9 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-60"
                    />
                  </label>
                </div>
                {(extraction.page ?? 1) > 1 && !committed && (
                  <p className="text-xs text-muted-foreground">
                    Pages 2 to 5 don&apos;t print the store or period. Use the same ones as this store&apos;s page 1 so all pages land in
                    one Inventory count.
                  </p>
                )}
              </fieldset>

              {/* Totals check: the page's value vs the total written at the bottom of the form. */}
              <section aria-label="Totals check" className="flex flex-col gap-2 border-t border-border pt-4">
                <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
                  <div className="flex flex-col">
                    <span className="text-xs font-medium">This page&apos;s ending value</span>
                    <span className="font-mono text-lg tabular-nums">{peso(totals.total)}</span>
                    <span className="text-[11px] text-muted-foreground">
                      on hand × printed price{totals.unpriced ? ` · ${totals.unpriced} counted ${totals.unpriced === 1 ? 'item has' : 'items have'} no price` : ''}
                    </span>
                  </div>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium">Total written on the form</span>
                    <input
                      inputMode="decimal"
                      value={formTotal}
                      onChange={(e) => setFormTotal(e.target.value)}
                      placeholder="₱ from the TOTAL box"
                      className="h-9 w-44 rounded-md border border-border bg-background px-2.5 font-mono text-sm tabular-nums outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
                    />
                  </label>
                  <span aria-live="polite" className="pb-2 text-sm font-medium">
                    {check.state === 'match' && <span style={{color: toneText('var(--status-good)')}}>✓ Reconciled</span>}
                    {check.state === 'off' && (
                      <span style={{color: toneText('var(--status-crit)')}}>
                        Off by {peso(Math.abs(check.diff))}: the page reads {check.diff > 0 ? 'higher' : 'lower'} than the form
                      </span>
                    )}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Optional. A mismatch usually means a misread count, so check the flagged rows and any row with a big value.
                </p>
              </section>
            </CardContent>
          </Card>

          <ReviewRows
            rows={rows}
            query={query}
            onQuery={setQuery}
            productNames={productNames}
            catalog={catalog}
            flagged={flagged}
            resolved={resolved}
            active={active}
            view={view}
            editable={!committed && canEdit}
            onView={setView}
            onCell={updateCell}
            onResolve={(i) => {
              resolve(i);
              goToFlag(unresolvedFlags(flagged, new Set(resolved).add(i))[0] ?? null);
            }}
            onStep={(dir) => {
              setView('needs');
              // Walk the open flags first; once all are resolved, walk them all.
              goToFlag(stepFlag(open.length ? open : flagged, active, dir));
            }}
          />

          {/* Commit bar */}
          {!committed && canEdit && (
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={commit} disabled={busy || rows.length === 0 || open.length > 0}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                {busy ? 'Committing…' : 'Confirm & commit'}
              </Button>
              {open.length > 0 && !notice && (
                <button type="button" onClick={() => goToFlag(open[0])} className="text-xs text-muted-foreground underline-offset-4 hover:underline">
                  Resolve {open.length} flagged {open.length === 1 ? 'row' : 'rows'} to commit
                </button>
              )}
              {notice && (
                <span className={cn('text-xs', notice.kind === 'ok' ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive')}>
                  {notice.text}
                </span>
              )}
            </div>
          )}
          {committed && notice && (
            <span className="text-xs text-emerald-700 dark:text-emerald-400">{notice.text}</span>
          )}
        </>
      )}
        </div>
      </div>

      {/* Enlarged scan — full-screen lightbox. Escape / click backdrop / × to close. */}
      {scanUrl && lightboxOpen && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/70 p-4 transition-opacity duration-150 ease-out starting:opacity-0 sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label="Scanned file"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setLightboxOpen(false);
          }}
        >
          <div className="mb-2 flex items-center justify-end gap-2">
            <a href={scanUrl} target="_blank" rel="noopener noreferrer">
              <Button variant="secondary" size="sm">
                <ExternalLink className="size-3.5" /> Open in new tab
              </Button>
            </a>
            <Button variant="secondary" size="sm" autoFocus onClick={() => setLightboxOpen(false)}>
              <X className="size-4" /> Close
            </Button>
          </div>
          <iframe src={scanUrl} title="Scanned inventory form (enlarged)" className="min-h-0 w-full flex-1 rounded-md bg-white" />
          <button
            type="button"
            aria-label="Close"
            onClick={() => setLightboxOpen(false)}
            className="absolute inset-0 -z-10 cursor-default"
          />
        </div>
      )}
    </div>
  );
}
