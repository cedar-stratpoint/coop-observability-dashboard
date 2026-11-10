'use client';

import {useEffect, useMemo, useRef, useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {ArrowLeft, ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, Crosshair, ExternalLink, FileText, Loader2, Maximize2, X} from 'lucide-react';
import type {ExtractionRecord, FormPageStrip, StoreOption, UploadRow} from '@/src/goldline-data';
import {StoreCodeField} from '@/components/analyst/store-code-field';
import type {ExtractedRow} from '@/src/goldline-extract-run';
import {commitReview} from '@/app/uploads/actions';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {cn} from '@/lib/utils';
import {DocumentConfidence} from '@/components/analyst/document-confidence';
import {ConfidenceSticky} from '@/components/analyst/confidence-sticky';
import {ScanPageViewer, type ScanHighlight} from '@/components/analyst/scan-page-viewer';
import {rowBandFor} from '@/src/goldline-extract';
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

/** The one-page view's place in the scan (from the Per file list): its label, the ‹ ›
 *  neighbours in that same filtered list, and the list itself for a fresh-tab Back. */
export type PageNav = {source: string; label: string; prevHref: string | null; nextHref: string | null; backHref: string};
/** Coop's suggestion for this page's header. `storeFrom` says where the store came from. */
export type PageSuggestionView = {storeCode: string | null; storeFrom: 'page' | 'batch' | null; periodStart: string | null; periodEnd: string | null; consultant: string | null};

// What the last committed page of a scan used, so the next page (pages 2 to 5 rarely print a
// store) can start from it, plus a one-line "committed" note to show after moving on. Kept
// per tab in sessionStorage: a convenience, never the source of truth.
type Carry = {storeCode: string; periodStart: string; periodEnd: string; ba: string; done?: string};
const carryKey = (source: string) => `coop.perfile.carry.${source}`;
function readCarry(source: string): Carry | null {
  try {
    const v = JSON.parse(window.sessionStorage.getItem(carryKey(source)) ?? 'null');
    return v && typeof v.storeCode === 'string' ? (v as Carry) : null;
  } catch {
    return null;
  }
}
function writeCarry(source: string, c: Carry) {
  try {
    window.sessionStorage.setItem(carryKey(source), JSON.stringify(c));
  } catch {
    /* storage blocked: the next page just starts from its own suggestion */
  }
}

const navBtn =
  'inline-flex size-8 items-center justify-center rounded-lg border border-border text-muted-foreground transition-[transform,border-color,color] duration-150 ease-out hover:border-foreground/30 hover:text-foreground active:scale-[0.97] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40 motion-reduce:transition-none';

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
  nav = null,
  suggestion = null,
  bas,
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
  /** Set when opened from a scan's Per file list: the one-page view with ‹ › arrows. */
  nav?: PageNav | null;
  /** Coop's prefill for store / period / BA in the one-page view. */
  suggestion?: PageSuggestionView | null;
  /** The BA list (each store's current BA and every name), for the BA field. */
  bas?: {byStore: Record<string, string>; names: string[]};
}) {
  const router = useRouter();
  const committed = upload.status === 'committed' || extraction?.status === 'confirmed';
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // When the lightbox was opened from a row's "locate on scan", the approximate band to draw.
  const [lightboxHighlight, setLightboxHighlight] = useState<ScanHighlight | undefined>(undefined);
  // Sentinel at the end of the full confidence summary; the sticky condensed bar shows once it
  // scrolls above the app header.
  const confEnd = useRef<HTMLDivElement>(null);

  const head = extraction?.data;
  const [rows, setRows] = useState<EditRow[]>(() => (head?.rows ?? []).map((r) => ({...r})));
  const [storeCode, setStoreCode] = useState(suggestion?.storeCode ?? head?.store_code ?? '');
  const [periodStart, setPeriodStart] = useState(suggestion?.periodStart ?? head?.period_start ?? '');
  const [periodEnd, setPeriodEnd] = useState(suggestion?.periodEnd ?? head?.period_end ?? '');
  // The BA written on the form. Blank saves under the store's BA from earlier forms.
  const [ba, setBa] = useState(suggestion?.consultant ?? head?.consultant ?? '');
  const storeBa = bas?.byStore[storeCode] ?? null;
  // Which header fields were carried over from the page committed just before this one.
  const [carried, setCarried] = useState(false);
  const [justDone, setJustDone] = useState<string | null>(null);
  useEffect(() => {
    if (!nav) return;
    const c = readCarry(nav.source);
    if (!c) return;
    // The note shows once, on the page the reviewer moved to after committing.
    if (c.done) {
      setJustDone(c.done);
      writeCarry(nav.source, {...c, done: undefined});
    }
    if (committed || !canEdit) return;
    // Only fill what this page's own reading left empty: its own read always wins.
    const fill = (mine: string | null | undefined, theirs: string, set: (v: string) => void) => {
      if (mine || !theirs) return false;
      set(theirs);
      return true;
    };
    const used = [
      fill(suggestion?.storeCode, c.storeCode, setStoreCode),
      fill(suggestion?.periodStart, c.periodStart, setPeriodStart),
      fill(suggestion?.periodEnd, c.periodEnd, setPeriodEnd),
      fill(suggestion?.consultant, c.ba, setBa),
    ].some(Boolean);
    setCarried(used);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per page (the route keys this component by upload id)
  }, []);

  // ← / → step pages, unless the reviewer is typing in a field (where arrows move the caret).
  useEffect(() => {
    if (!nav) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || lightboxOpen) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const href = e.key === 'ArrowLeft' ? nav.prevHref : e.key === 'ArrowRight' ? nav.nextHref : null;
      if (!href) return;
      e.preventDefault();
      router.replace(href);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nav, router, lightboxOpen]);
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
      consultant: nav ? ba.trim() || null : head?.consultant ?? null,
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
      if (nav) {
        // One page at a time: remember this header for the next page, then move on to it.
        const done = `${nav.label} committed: ${res.committed} ${res.committed === 1 ? 'row' : 'rows'} into Store ${storeCode.trim()}.`;
        writeCarry(nav.source, {storeCode: storeCode.trim(), periodStart, periodEnd, ba: ba.trim(), done: nav.nextHref ? done : undefined});
        if (nav.nextHref) {
          setBusy(true); // stays disabled while the next page loads, so it can't commit twice
          router.replace(nav.nextHref);
          return;
        }
      }
      setNotice({kind: 'ok', text: `Committed ${res.committed} inventory rows.`});
      router.refresh();
    } else {
      setNotice({kind: 'err', text: res.error});
    }
  }

  // Where the prefilled store came from, said plainly, so a wrong guess is easy to spot.
  const suggestionNote = !storeCode.trim()
    ? 'Coop couldn’t read a store on this page. Pick it from the form; the next pages start from it.'
    : carried && !suggestion?.storeCode
      ? `Store ${storeCode} carried over from the page you committed before. Change it if this page is another store’s.`
      : suggestion?.storeCode && storeCode === suggestion.storeCode
        ? suggestion.storeFrom === 'page'
          ? `Coop read Store ${storeCode} on this page. Change it if that’s wrong.`
          : `Suggested from this scan’s batch (Store ${storeCode}). Check it against the page.`
        : 'Committed into this store and period. Pages with the same store and period add up to one Inventory count.';

  // Two-column whenever there's a scan beside the content: the workbench when a page was
  // read, or the "set aside" explainer when it wasn't (a blank back or a sales sheet).
  const twoCol = Boolean(scanUrl);

  // A scanned page with nothing to review: a blank back, a sales sheet, or an unread page.
  // Give it a plain explainer instead of the empty review workbench.
  const isCsv = upload.kind === 'pos_csv' || upload.kind === 'pos_xlsx';
  const setAside =
    upload.page_kind === 'sales'
      ? {pill: 'Sales report', title: 'Sales report, set aside', body: upload.reject_reason ?? 'This page is a sales report, not an inventory form. Sales are handled on their own, so it was set aside.', tone: 'var(--muted-foreground)'}
      : upload.page_kind === 'blank'
        ? {pill: 'Blank page', title: 'Blank page, set aside', body: upload.reject_reason ?? 'This looks like a blank page (a back side with no form), so it was set aside.', tone: 'var(--muted-foreground)'}
        : upload.status === 'failed'
          ? {pill: 'Couldn’t read', title: 'Coop couldn’t read this page', body: upload.reject_reason ?? 'Coop couldn’t read this scan reliably. Re-read it, or review it by hand.', tone: 'var(--status-crit)'}
          : {pill: 'Set aside', title: 'Set aside', body: upload.reject_reason ?? 'This page was set aside, so there is nothing to review or commit here.', tone: 'var(--muted-foreground)'};

  return (
    <div className="mx-auto flex max-w-[108rem] flex-col gap-5 px-4 py-6 xl:px-6">
      {nav ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => {
                // Browser-style Back: the arrows replace history rather than add to it, so
                // one step back is the screen that opened this review (the Per file list,
                // with its filter and list page restored from the URL). A fresh tab with
                // nothing to step back to opens that list instead.
                if (window.history.length > 1) router.back();
                else router.push(nav.backHref);
              }}
              className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-3.5 shrink-0" /> <span className="max-w-[16rem] truncate">{nav.source}</span>
            </button>
            {/* Page stepper, upper right. An arrow shows only when there is a page that way;
                the empty slot keeps the other arrow from jumping under the cursor. Switching
                pages is instant (no slide): it is repeated many times in a session. */}
            <nav aria-label="Pages in this scan" className="flex shrink-0 items-center gap-1.5">
              {nav.prevHref ? (
                <Link href={nav.prevHref} replace aria-label="Previous page" title="Previous page (←)" className={navBtn}>
                  <ChevronLeft className="size-4" />
                </Link>
              ) : (
                <span aria-hidden className="size-8" />
              )}
              <span
                aria-current="page"
                className="inline-flex h-8 items-center rounded-full border px-3 text-xs font-semibold tabular-nums"
                style={{color: toneText('var(--primary)'), background: 'color-mix(in oklab, var(--primary) 14%, transparent)', borderColor: 'color-mix(in oklab, var(--primary) 30%, transparent)'}}
              >
                {nav.label}
              </span>
              {nav.nextHref ? (
                <Link href={nav.nextHref} replace aria-label="Next page" title="Next page (→)" className={navBtn}>
                  <ChevronRight className="size-4" />
                </Link>
              ) : (
                <span aria-hidden className="size-8" />
              )}
            </nav>
          </div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">{committed ? 'This page is committed' : extraction ? 'Review this page' : 'This page'}</h1>
          {justDone && (
            <p aria-live="polite" className="inline-flex items-center gap-1.5 text-xs" style={{color: toneText('var(--status-good)')}}>
              <CheckCircle2 className="size-3.5" /> {justDone}
            </p>
          )}
        </div>
      ) : (
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
                <Link key={p.page} href={`/uploads/${p.uploadId}`} replace className={cn(cls, 'hover:bg-muted')} title={`Open page ${p.page} of this form`}>
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
      )}

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
          <div className={cn('lg:shrink-0', extraction ? 'lg:sticky lg:top-[calc(3.5rem+1rem)] lg:w-[28%]' : 'lg:w-[17rem]')}>
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
                  onClick={() => {
                    setLightboxHighlight(undefined);
                    setLightboxOpen(true);
                  }}
                  className="group relative block w-full overflow-hidden rounded-md border border-border bg-muted max-md:hidden"
                  aria-label="Enlarge scan"
                >
                  <iframe
                    src={scanUrl}
                    title="Scanned inventory form"
                    tabIndex={-1}
                    className={cn('pointer-events-none w-full', extraction ? 'h-[360px] lg:h-[min(640px,calc(100dvh-12rem))]' : 'h-[20rem]')}
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

      {/* A sales CSV / POS export: commits straight to sales, nothing to review. */}
      {!extraction && isCsv && (
        <Card>
          <CardHeader>
            <CardTitle>{upload.kind === 'pos_csv' ? 'Sales CSV' : 'POS Sales Data'}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <p className="text-muted-foreground">Sales files commit directly to the sales table, so there is nothing to review here.</p>
            <p>
              Status: <span className="font-medium">{upload.status}</span>
            </p>
            {upload.reject_reason && <p className="text-destructive">{upload.reject_reason}</p>}
          </CardContent>
        </Card>
      )}

      {/* A scanned page that was set aside (blank back, sales sheet) or couldn't be read:
          a plain explainer beside its modest preview, not the empty review workbench. */}
      {!extraction && !isCsv && (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 py-6">
            <span
              className="inline-flex w-fit items-center rounded-full px-2.5 py-1 text-xs font-medium"
              style={{color: toneText(setAside.tone), background: `color-mix(in oklab, ${setAside.tone} 14%, transparent)`}}
            >
              {setAside.pill}
            </span>
            <h2 className="font-heading text-lg font-semibold tracking-tight">{setAside.title}</h2>
            <p className="max-w-prose text-sm text-muted-foreground">{setAside.body}</p>
            <p className="text-xs text-muted-foreground">
              {upload.status === 'failed'
                ? 'It won’t be committed until it reads. '
                : 'It won’t be committed, which is expected. '}
              {nav?.nextHref && 'Use the arrows above, or ← and →, to move to the next page.'}
            </p>
          </CardContent>
        </Card>
      )}

      {/* PDF review workbench */}
      {extraction && (
        <>
          <ConfidenceSticky
            watch={confEnd}
            docConfidence={docConfidence}
            rowConfidences={rows.map((r) => r.confidence)}
            page={extraction.page}
            onReviewFlagged={() => {
              setView('needs');
              goToFlag(open[0] ?? flagged[0] ?? null);
            }}
          />
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <CardTitle>Document</CardTitle>
                {extraction.page ? (
                  <span className="text-xs text-muted-foreground">Inventory form · page {extraction.page} of 5</span>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-7">
              <DocumentConfidence
                docConfidence={docConfidence}
                rowConfidences={rows.map((r) => r.confidence)}
                onReviewFlagged={() => {
                  setView('needs');
                  goToFlag(open[0] ?? flagged[0] ?? null);
                }}
              />
              <div ref={confEnd} aria-hidden className="h-0" />

              <fieldset className="flex flex-col gap-3">
                <legend className="mb-3 text-xs font-medium text-muted-foreground">
                  {nav ? 'Store, period and BA for this page' : 'Which store and period is this count for?'}
                </legend>
                <div className="flex flex-wrap items-end gap-4">
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
                  {nav && (
                    <label className="flex min-w-48 flex-1 flex-col gap-1">
                      <span className="text-xs font-medium">BA on the form</span>
                      <input
                        value={ba}
                        onChange={(e) => setBa(e.target.value)}
                        list="ba-names"
                        maxLength={80}
                        placeholder={storeBa ?? 'Full name'}
                        autoComplete="off"
                        disabled={committed || !canEdit}
                        className="h-9 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-60"
                      />
                      <datalist id="ba-names">
                        {(bas?.names ?? []).map((n) => (
                          <option key={n} value={n} />
                        ))}
                      </datalist>
                    </label>
                  )}
                </div>
                {nav && !committed && <p className="text-xs text-muted-foreground">{suggestionNote}</p>}
                {!nav && (extraction.page ?? 1) > 1 && !committed && (
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
            onLocate={
              scanUrl && extraction.page
                ? (itemCode) => {
                    const label = `${itemCode}${productNames[itemCode] ? ` · ${productNames[itemCode]}` : ''} · page ${extraction.page}`;
                    // Exact box the reader captured for this row, else the page template's band.
                    const box = rows.find((r) => r.item_code === itemCode)?.box;
                    if (box && typeof box.y_top === 'number' && typeof box.y_bottom === 'number' && box.y_bottom > box.y_top) {
                      setLightboxHighlight({top: box.y_top, height: box.y_bottom - box.y_top, label});
                    } else {
                      const band = rowBandFor(itemCode, extraction.page!);
                      setLightboxHighlight(band ? {...band, label, approximate: true} : undefined);
                    }
                    setLightboxOpen(true);
                  }
                : undefined
            }
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
                {busy ? 'Committing…' : nav ? (nav.nextHref ? 'Commit and go to next page' : 'Commit this page') : 'Confirm & commit'}
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
          <div className="mb-2 flex items-center justify-between gap-2">
            {lightboxHighlight ? (
              <span className="inline-flex items-center gap-1.5 rounded-md bg-background/90 px-2.5 py-1 text-xs font-medium">
                <Crosshair className="size-3.5" style={{color: 'var(--primary)'}} /> {lightboxHighlight.label}
                {lightboxHighlight.approximate && <span className="text-muted-foreground">· approximate</span>}
              </span>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <a href={scanUrl} target="_blank" rel="noopener noreferrer">
                <Button variant="secondary" size="sm">
                  <ExternalLink className="size-3.5" /> Open in new tab
                </Button>
              </a>
              <Button variant="secondary" size="sm" autoFocus onClick={() => setLightboxOpen(false)}>
                <X className="size-4" /> Close
              </Button>
            </div>
          </div>
          {/* The page rendered to a canvas with the approximate row band drawn in the page's own
              coordinate space (same viewer the batch review uses), so the band stays locked on. */}
          <div className="min-h-0 w-full flex-1">
            <ScanPageViewer url={scanUrl} highlight={lightboxHighlight} className="h-full" />
          </div>
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
