'use client';

import {useEffect, useMemo, useRef, useState, useTransition} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, Crosshair, ExternalLink, FileText, Loader2, Maximize2, X} from 'lucide-react';
import type {BatchRow, ExtractionRecord, StoreOption, UploadRow} from '@/src/goldline-data';
import {StoreCodeField} from '@/components/analyst/store-code-field';
import {ScanPageViewer} from '@/components/analyst/scan-page-viewer';
import type {ExtractedRow} from '@/src/goldline-extract-run';
import {rowBandFor} from '@/src/goldline-extract';
import {commitBatchAction, updateBatchInfoAction} from '@/app/uploads/actions';
import {batchCoverage, batchReadiness, storeConflict, scanPageLabel, FORM_PAGES} from '@/src/upload-batch';
import {uploadSource} from '@/src/goldline-upload-groups';
import {LOW_BELOW, rowConfidence, toneText} from '@/src/review-confidence';
import {stepFlag, unresolvedFlags, type CatalogLite} from '@/src/review-workbench';
import {draftKey, packPage, parseDraft, unpackPage, type Draft} from '@/src/review-draft';
import {DocumentConfidence} from '@/components/analyst/document-confidence';
import {reviewRowEl, ReviewRows, type ColKey, type ReviewView} from '@/components/analyst/review-rows';
import {useUploadQueue} from '@/components/analyst/upload-queue';
import {Card, CardContent} from '@/components/ui/card';
import {Button, buttonVariants} from '@/components/ui/button';
import {cn} from '@/lib/utils';

// Batch review: one store's inventory form for one period, page by page, then ONE
// commit for every page. Store + period live at the top (once for all pages). Each
// page tab shows its scan, confidence and rows (same review tools as a single scan);
// tabs carry their open-flag count so nothing is missed. The sticky bar always says
// exactly what's left before "Commit all pages" can run.

export type BatchReviewPage = {
  page: number | null;
  upload: UploadRow;
  extraction: ExtractionRecord | null;
  productNames: Record<string, string>;
  scanUrl: string | null;
  detectedStore: string | null;
};

type PageState = {
  rows: ExtractedRow[];
  resolved: Set<number>;
  active: number | null;
  view: ReviewView;
  query: string;
  seed: string; // which server snapshot the edits started from (see seedKey)
};

// A page's edits start from its extraction. Re-seed only when the server has something
// new for it (a page still reading when the review opened has since finished) — never
// on a plain refresh, so in-progress edits survive pages arriving while you review.
const seedKey = (p: BatchReviewPage) => `${p.upload.status}:${p.extraction ? p.extraction.data?.rows?.length ?? 0 : 'none'}`;

function flagsOf(p: BatchReviewPage): number[] {
  return (p.extraction?.data?.rows ?? [])
    .map((r, i) => ({c: rowConfidence(r.confidence), i}))
    .filter((x) => x.c < LOW_BELOW)
    .map((x) => x.i);
}

function seedPage(p: BatchReviewPage): PageState {
  return {
    rows: (p.extraction?.data?.rows ?? []).map((r) => ({...r})),
    resolved: new Set<number>(),
    active: null,
    view: flagsOf(p).length ? 'needs' : 'all',
    query: '',
    seed: seedKey(p),
  };
}

function toIntOrNull(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

const fieldCls =
  'h-9 rounded-md border border-border bg-background px-2.5 text-sm outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-60';

export function BatchReview({
  company,
  canEdit,
  batch,
  defaults,
  pages,
  catalog,
  stores,
  bas,
  otherFiles,
  initialPageId = null,
}: {
  company: string;
  canEdit: boolean;
  batch: BatchRow;
  defaults: {storeCode: string; periodStart: string; periodEnd: string; consultant: string | null};
  pages: BatchReviewPage[];
  catalog: Record<string, CatalogLite>;
  stores: StoreOption[];
  /** The BA list: each store's current BA and every name, for the BA field. */
  bas?: {byStore: Record<string, string>; names: string[]};
  otherFiles: UploadRow[];
  /** The page (upload id) to open on: set when the reviewer came in from one file. */
  initialPageId?: string | null;
}) {
  const router = useRouter();
  const queue = useUploadQueue();
  const committed = batch.status === 'committed';
  const editable = canEdit && !committed;

  const [storeCode, setStoreCode] = useState(defaults.storeCode);
  const [periodStart, setPeriodStart] = useState(defaults.periodStart);
  const [periodEnd, setPeriodEnd] = useState(defaults.periodEnd);
  // The BA written on the form (page 1's header). Left blank, the save uses the store's
  // BA learned from its earlier forms, so the flags still count against someone.
  const [ba, setBa] = useState(defaults.consultant ?? '');
  const storeBa = bas?.byStore[storeCode] ?? null;
  const [tabId, setTabId] = useState<string | null>((pages.find((p) => p.upload.id === initialPageId) ?? pages[0])?.upload.id ?? null);
  // The enlarged scan. `highlight` (set by the per-row "Show in scan" locate button)
  // is an approximate row band — top/height as fractions of the page — computed from
  // the item's printed position in the page's fixed template.
  const [lightbox, setLightbox] = useState<{url: string; highlight?: {top: number; height: number; label: string}} | null>(null);
  // Which page-number groups have their copies expanded (tab strip, grouped view).
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [committing, startCommit] = useTransition();

  // Flags per page come from the reader (editing a value doesn't change its confidence).
  const flaggedById = useMemo(() => Object.fromEntries(pages.map((p) => [p.upload.id, flagsOf(p)])), [pages]);
  const [state, setState] = useState<Record<string, PageState>>(() => Object.fromEntries(pages.map((p) => [p.upload.id, seedPage(p)])));

  // Pages that arrived or finished reading since the review opened: seed them now
  // (render-time adjustment, so they're never shown without state).
  const stale = pages.filter((p) => state[p.upload.id]?.seed !== seedKey(p));
  if (stale.length) {
    setState((all) => {
      const next = {...all};
      for (const p of stale) {
        const had = next[p.upload.id];
        // Keep edits only when the reading itself is unchanged (e.g. just committed
        // elsewhere); a new or re-read extraction starts from the fresh rows.
        const sameReading = had && had.seed.split(':')[1] === seedKey(p).split(':')[1] && had.seed.split(':')[1] !== 'none';
        next[p.upload.id] = sameReading ? {...had, seed: seedKey(p)} : seedPage(p);
      }
      return next;
    });
  }

  const reviewable = pages.filter((p) => p.upload.status === 'needs_review');
  const coverage = batchCoverage(pages.map((p) => ({page: p.page})));
  const pageInfo = pages.map((p) => {
    const flags = flaggedById[p.upload.id] ?? [];
    return {
      uploadId: p.upload.id,
      page: p.page,
      flagged: flags.length,
      resolved: flags.filter((i) => state[p.upload.id]?.resolved.has(i)).length,
      status: p.upload.status,
      detectedStore: p.detectedStore,
    };
  });
  const readiness = batchReadiness({storeCode, periodStart, periodEnd, pages: pageInfo});
  // Store-change guard: which pages read which store, so a mixed-store batch is flagged.
  const storeGuard = storeConflict(pageInfo.filter((p) => p.status === 'needs_review'));

  const tab = Math.max(0, pages.findIndex((p) => p.upload.id === tabId));
  const setTab = (k: number) => {
    const id = pages[k]?.upload.id ?? null;
    setTabId(id);
    // Keep the open page in the address, so Back/refresh/a shared link return to it.
    if (id) window.history.replaceState(null, '', `?page=${id}`);
  };

  // Unsaved edits are kept in this browser per batch (see src/review-draft.ts), so
  // leaving the review and coming back keeps the reviewer's values and checked flags.
  // `hydrated` flips in the same update as the restore, so the save effect first runs
  // with the restored state and never overwrites a stored draft with the fresh reading.
  const draftsLoaded = useRef(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (draftsLoaded.current) return;
    draftsLoaded.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- marks the one-time localStorage restore below as done
    setHydrated(true);
    if (!editable) return;
    let draft: Draft | null = null;
    try {
      draft = parseDraft(window.localStorage.getItem(draftKey(batch.id)));
    } catch {
      /* storage blocked: review still works, edits just aren't kept */
    }
    if (!draft) return;
    const saved = draft.pages;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore from localStorage after hydration (reading it during render would mismatch the server HTML)
    setState((all) => {
      const next = {...all};
      for (const p of pages) {
        if (p.upload.status !== 'needs_review') continue;
        const back = unpackPage(p.extraction?.data?.rows ?? [], saved[p.upload.id]);
        if (back && next[p.upload.id]) next[p.upload.id] = {...next[p.upload.id], rows: back.rows, resolved: back.resolved};
      }
      return next;
    });
  }, [batch.id, editable, pages]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      if (committed) {
        window.localStorage.removeItem(draftKey(batch.id)); // nothing left to keep
        return;
      }
      if (!editable) return; // view-only: never touch an editor's draft in this browser
      const out: Draft = {v: 1, savedAt: Date.now(), pages: {}};
      for (const p of pages) {
        const s = state[p.upload.id];
        if (!s || p.upload.status !== 'needs_review') continue;
        const d = packPage(p.extraction?.data?.rows ?? [], s.rows, s.resolved);
        if (d) out.pages[p.upload.id] = d;
      }
      if (Object.keys(out.pages).length) window.localStorage.setItem(draftKey(batch.id), JSON.stringify(out));
      else window.localStorage.removeItem(draftKey(batch.id));
    } catch {
      /* storage blocked or full */
    }
  }, [hydrated, state, pages, editable, committed, batch.id]);
  const cur = pages[tab];
  const curState = cur ? state[cur.upload.id] : null;
  const curFlags = cur ? flaggedById[cur.upload.id] ?? [] : [];
  const setCur = (p: Partial<PageState> | ((s: PageState) => Partial<PageState>)) =>
    cur && setState((all) => ({...all, [cur.upload.id]: {...all[cur.upload.id], ...(typeof p === 'function' ? p(all[cur.upload.id]) : p)}}));

  function saveInfo(next: {storeCode?: string; periodStart?: string; periodEnd?: string}) {
    const v = {storeCode, periodStart, periodEnd, ...next};
    if (!editable) return;
    void updateBatchInfoAction({company, batchId: batch.id, ...v});
  }

  function goToFlag(index: number | null) {
    if (index == null) return;
    setCur({active: index, query: '', view: 'needs'});
    requestAnimationFrame(() => {
      const row = reviewRowEl(index);
      row?.scrollIntoView({behavior: 'smooth', block: 'center'});
      row?.querySelector<HTMLInputElement>('input')?.focus({preventScroll: true});
    });
  }

  function commitAll() {
    if (!readiness.ready) return;
    setError(null);
    startCommit(async () => {
      const res = await commitBatchAction({
        company,
        batchId: batch.id,
        storeCode,
        periodStart,
        periodEnd,
        consultant: ba.trim() || null,
        pages: reviewable.map((p) => ({
          uploadId: p.upload.id,
          rows: (state[p.upload.id]?.rows ?? []).map((r) => ({
            item_code: r.item_code,
            stockroom: r.stockroom,
            drawer: r.drawer,
            selling_area: r.selling_area,
            delivery: r.delivery,
            ending_on_hand: r.ending_on_hand,
          })),
        })),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDone(res.committed);
      try {
        window.localStorage.removeItem(draftKey(batch.id));
      } catch {
        /* storage blocked */
      }
      if (queue?.batch.id === batch.id) queue.reset(); // the corner indicator's job is done
      router.refresh();
    });
  }

  const inventoryHref =
    storeCode && periodStart && periodEnd ? `/stock?store=${encodeURIComponent(storeCode)}&period=${periodStart}_${periodEnd}` : '/stock';
  const openFlags = pageInfo.reduce((n, p) => n + Math.max(0, p.flagged - p.resolved), 0);
  // Confidence framing: lead with what was read cleanly, not with the flag count.
  const totalRows = pages.reduce((n, p) => n + (state[p.upload.id]?.rows.length ?? 0), 0);
  const confident = Math.max(0, totalRows - openFlags);
  // Where this form came from: the scan drop and which of its pages is open now, so Back
  // returns to the scan (not the default Uploads screen) and the context is visible.
  const scanSource = uploadSource(pages[0]?.upload.filename ?? '');
  const curPageLabel = cur ? scanPageLabel(cur.upload.filename).title : null;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 pt-6 pb-6">
      <div className="flex flex-col gap-1.5">
        <nav className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" aria-label="Breadcrumb">
          <Link href={`/uploads/scan/${encodeURIComponent(scanSource)}`} className="inline-flex shrink-0 items-center gap-1 transition-colors hover:text-foreground">
            <ArrowLeft className="size-3.5" /> <span className="max-w-[16rem] truncate">{scanSource}</span>
          </Link>
          {curPageLabel && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate font-medium text-foreground">{curPageLabel}</span>
            </>
          )}
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-xl font-semibold tracking-tight">Review this store&apos;s form</h1>
          {committed ? (
            <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium" style={{color: toneText('var(--status-good)'), background: 'color-mix(in oklab, var(--status-good) 14%, transparent)'}}>
              <CheckCircle2 className="size-3.5" /> Committed
            </span>
          ) : totalRows > 0 ? (
            <span className="text-sm text-muted-foreground">
              Read <span className="font-semibold text-foreground tabular-nums">{confident}</span> of{' '}
              <span className="font-semibold text-foreground tabular-nums">{totalRows}</span> rows confidently
              {openFlags > 0 ? (
                <>
                  {' · '}
                  <span className="font-medium text-[color:var(--status-warn)]">{openFlags} to glance at</span>
                </>
              ) : (
                ' · nothing left to check'
              )}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              {pages.length} {pages.length === 1 ? 'page' : 'pages'}
            </span>
          )}
        </div>
      </div>

      {(committed || done != null) && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-sm" style={{color: toneText('var(--status-good)'), background: 'color-mix(in oklab, var(--status-good) 12%, transparent)'}}>
          <span className="inline-flex items-center gap-2">
            <CheckCircle2 className="size-4" />
            {done != null ? `Committed ${done} counts from ${reviewable.length} ${reviewable.length === 1 ? 'page' : 'pages'}.` : 'This form is committed.'}
          </span>
          <Link href={inventoryHref} className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline">
            View in Inventory <ArrowRight className="size-3.5" />
          </Link>
        </div>
      )}

      {/* Store + period — once for every page. */}
      <Card>
        <CardContent className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-2" disabled={!editable}>
            <legend className="mb-2 text-xs font-medium">
              Store, period and BA <span className="font-normal text-muted-foreground">· applies to every page below</span>
            </legend>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Store</span>
                <StoreCodeField
                  value={storeCode}
                  onChange={(code) => {
                    setStoreCode(code);
                    saveInfo({storeCode: code});
                  }}
                  stores={stores}
                  disabled={!editable}
                />
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">From</span>
                <input type="date" value={periodStart} onChange={(e) => {
                  setPeriodStart(e.target.value);
                  saveInfo({periodStart: e.target.value});
                }} className={fieldCls} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">To</span>
                <input type="date" value={periodEnd} min={periodStart || undefined} onChange={(e) => {
                  setPeriodEnd(e.target.value);
                  saveInfo({periodEnd: e.target.value});
                }} className={fieldCls} />
              </label>
              <label className="flex min-w-48 flex-1 flex-col gap-1">
                <span className="text-xs text-muted-foreground">BA on the form</span>
                <input
                  value={ba}
                  onChange={(e) => setBa(e.target.value)}
                  list="ba-names"
                  maxLength={80}
                  placeholder={storeBa ?? 'Full name'}
                  autoComplete="off"
                  className={fieldCls}
                />
                <datalist id="ba-names">
                  {(bas?.names ?? []).map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              {ba.trim()
                ? 'Saved with this BA. A BA Coop already knows is recognised, even shortened (“Liza M.”); a new name is added as a new BA and becomes this store’s BA from this cycle.'
                : storeBa
                  ? `Blank on the form: saved under ${storeBa}, this store’s BA from its earlier forms.`
                  : 'Blank on the form and Coop hasn’t seen a BA for this store yet. Type the name from the form; flags count against the BA.'}
            </p>
          </fieldset>
          {(coverage.missing.length > 0 && coverage.missing.length < 5) || coverage.duplicates.length > 0 ? (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {coverage.duplicates.length > 0 && (
                <span className="inline-flex items-center gap-1" style={{color: toneText('var(--status-warn)')}}>
                  <AlertTriangle className="size-3.5" aria-hidden /> Page {coverage.duplicates.join(', ')} is here twice. Remove the extra copy from Uploads.
                </span>
              )}
              {coverage.missing.length > 0 && (
                <span className="text-muted-foreground">
                  Not in this batch: page {coverage.missing.join(', ')}. You can commit what&apos;s here and add the rest later.
                </span>
              )}
            </p>
          ) : null}
          {storeGuard.conflict && (
            <div
              className="flex flex-col gap-1.5 rounded-lg px-3 py-2.5 text-xs"
              style={{color: toneText('var(--status-crit)'), background: 'color-mix(in oklab, var(--status-crit) 10%, transparent)'}}
            >
              <span className="inline-flex items-center gap-1.5 font-medium">
                <AlertTriangle className="size-3.5" aria-hidden /> {storeGuard.stores.length} different stores read across these pages.
              </span>
              <span className="text-muted-foreground">
                A batch is one store&apos;s form. Split it into one form per store from Uploads, or remove the pages that don&apos;t belong, before you commit.
              </span>
              {/* Hick's Law: show the store SET first (short), hide the long per-page list behind a disclosure. */}
              <div className="mt-0.5 flex flex-wrap gap-1.5">
                {storeGuard.stores.map((s) => (
                  <span key={s} className="rounded-full px-2 py-0.5 font-mono tabular-nums" style={{background: 'color-mix(in oklab, var(--status-crit) 14%, transparent)'}}>{s}</span>
                ))}
              </div>
              <details className="mt-0.5">
                <summary className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground">Which page read which store</summary>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                  {pages.filter((p) => p.detectedStore).map((p) => (
                    <span key={p.upload.id} className="text-muted-foreground tabular-nums">
                      Page {p.page ?? '?'}: <span className="text-foreground">{p.detectedStore}</span>
                    </span>
                  ))}
                </div>
              </details>
            </div>
          )}
        </CardContent>
      </Card>

      {pages.length === 0 ? (
        <Card>
          <CardContent className="px-6 py-10 text-center text-sm text-muted-foreground">No scanned pages in this batch yet.</CardContent>
        </Card>
      ) : (
        <>
          {/* Pages, grouped by page number so a big pile (many stores, unknown pages)
              reads as a few labelled rows instead of a wall of identical pills (Hick's
              Law). A copy chip shows only its status; the group header carries the
              number. Unknown pages collapse behind a disclosure. */}
          {(() => {
            // index-keyed copies per page number (1-5), plus the 'unknown' bucket.
            const byPage = new Map<string, number[]>();
            pages.forEach((p, k) => {
              const key = p.page ? String(p.page) : 'unknown';
              (byPage.get(key) ?? byPage.set(key, []).get(key)!).push(k);
            });
            const chip = (k: number, n: number, idxInGroup: number, groupSize: number) => {
              const p = pages[k];
              const info = pageInfo[k];
              const open = Math.max(0, info.flagged - info.resolved);
              const dup = p.page != null && coverage.duplicates.includes(p.page);
              return (
                <button
                  key={p.upload.id}
                  role="tab"
                  type="button"
                  aria-selected={tab === k}
                  aria-label={`Page ${p.page ?? '?'}${groupSize > 1 ? ` copy ${idxInGroup + 1}` : ''}`}
                  onClick={() => setTab(k)}
                  className={cn(
                    'inline-flex h-8 min-w-8 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium transition-[background-color,border-color,transform] duration-150 ease-out active:scale-[0.97]',
                    tab === k ? 'border-primary bg-primary/10' : 'border-border hover:border-foreground/30',
                  )}
                >
                  {groupSize > 1 && <span className="text-xs text-muted-foreground tabular-nums">{idxInGroup + 1}</span>}
                  {p.upload.status === 'committed' ? (
                    <CheckCircle2 className="size-3.5" style={{color: 'var(--status-good)'}} aria-label="committed" />
                  ) : open ? (
                    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums" style={{color: toneText('var(--status-crit)'), background: 'color-mix(in oklab, var(--status-crit) 14%, transparent)'}}>
                      {open}
                    </span>
                  ) : (
                    <CheckCircle2 className="size-3.5 text-muted-foreground" aria-label="nothing to check" />
                  )}
                  {dup && <AlertTriangle className="size-3.5" style={{color: 'var(--status-warn)'}} aria-label="duplicate page" />}
                </button>
              );
            };
            const unknown = byPage.get('unknown') ?? [];
            return (
              <div role="tablist" aria-label="Pages" className="flex flex-col gap-1.5">
                {FORM_PAGES.map((n) => {
                  const copies = byPage.get(String(n)) ?? [];
                  if (copies.length === 0) {
                    return coverage.missing.includes(n) && coverage.missing.length < 5 ? (
                      <div key={n} className="flex items-center gap-2">
                        <span className="w-14 shrink-0 text-xs font-medium text-muted-foreground">Page {n}</span>
                        <span className="text-xs text-muted-foreground/60">not in this batch</span>
                      </div>
                    ) : null;
                  }
                  return (
                    <div key={n} className="flex items-center gap-2">
                      <span className="w-14 shrink-0 text-xs font-medium">Page {n}</span>
                      <div className="flex flex-wrap gap-1.5">{copies.map((k, i) => chip(k, n, i, copies.length))}</div>
                    </div>
                  );
                })}
                {unknown.length > 0 && (
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      onClick={() => setOpenGroups((g) => ({...g, unknown: !g.unknown}))}
                      aria-expanded={Boolean(openGroups.unknown)}
                      className="inline-flex h-6 shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <ChevronDown className={cn('size-3.5 transition-transform', openGroups.unknown && 'rotate-180')} />
                      Unknown ({unknown.length})
                    </button>
                    {openGroups.unknown && (
                      <div className="flex flex-wrap gap-1.5">{unknown.map((k, i) => chip(k, 0, i, unknown.length))}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {cur && curState && (
            <div role="tabpanel" className="flex flex-col gap-5 lg:flex-row lg:items-start">
              {cur.scanUrl && (
                <div className="lg:sticky lg:top-[calc(3.5rem+1rem)] lg:w-[28%] lg:shrink-0">
                  <Card>
                    <CardContent className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-sm font-medium">
                          <FileText className="size-3.5 text-muted-foreground" /> Scan
                        </span>
                        <a href={cur.scanUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-muted">
                          <ExternalLink className="size-3.5" /> Open
                        </a>
                      </div>
{/* Phones can't show a PDF inside the page — open it in the phone's viewer instead. */}
                <a
                  href={cur.scanUrl}
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
                        onClick={() => setLightbox({url: cur.scanUrl!})}
                        aria-label="Enlarge scan"
                        className="group relative block w-full overflow-hidden rounded-md border border-border bg-muted max-md:hidden"
                      >
                        <iframe src={cur.scanUrl} title={`Scan of ${cur.upload.filename}`} tabIndex={-1} className="pointer-events-none h-[360px] w-full lg:h-[min(640px,calc(100dvh-12rem))]" />
                        <span className="absolute inset-0 flex items-end justify-center bg-gradient-to-t from-black/40 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
                          <span className="inline-flex items-center gap-1 rounded-md bg-background/90 px-2 py-1 text-xs font-medium">
                            <Maximize2 className="size-3" /> Click to enlarge
                          </span>
                        </span>
                      </button>
                      <span className="truncate text-[11px] text-muted-foreground" title={cur.upload.filename}>
                        {cur.upload.filename}
                      </span>
                    </CardContent>
                  </Card>
                </div>
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-5">
                <Card>
                  <CardContent>
                    <DocumentConfidence
                      docConfidence={cur.extraction?.docConfidence ?? null}
                      rowConfidences={curState.rows.map((r) => r.confidence)}
                      onReviewFlagged={() => goToFlag(unresolvedFlags(curFlags, curState.resolved)[0] ?? curFlags[0] ?? null)}
                    />
                  </CardContent>
                </Card>
                <ReviewRows
                  rows={curState.rows}
                  productNames={cur.productNames}
                  catalog={catalog}
                  flagged={curFlags}
                  resolved={curState.resolved}
                  active={curState.active}
                  view={curState.view}
                  query={curState.query}
                  onQuery={(q) => setCur({query: q})}
                  editable={editable && cur.upload.status === 'needs_review'}
                  onView={(v) => setCur({view: v})}
                  onCell={(index: number, key: ColKey, raw: string) =>
                    setCur((s) => {
                      const rows = [...s.rows];
                      rows[index] = {...rows[index], [key]: toIntOrNull(raw)};
                      const original = cur.extraction?.data?.rows?.[index]?.[key] ?? null;
                      const resolved = curFlags.includes(index) && toIntOrNull(raw) !== original ? new Set(s.resolved).add(index) : s.resolved;
                      return {rows, resolved};
                    })
                  }
                  onResolve={(i) => {
                    const next = new Set(curState.resolved).add(i);
                    setCur({resolved: next});
                    goToFlag(unresolvedFlags(curFlags, next)[0] ?? null);
                  }}
                  onStep={(dir) => {
                    const open = unresolvedFlags(curFlags, curState.resolved);
                    goToFlag(stepFlag(open.length ? open : curFlags, curState.active, dir));
                  }}
                  onLocate={cur.scanUrl && cur.page ? (itemCode) => {
                    const band = rowBandFor(itemCode, cur.page!);
                    const names = cur.productNames;
                    const label = `${itemCode}${names[itemCode] ? ` · ${names[itemCode]}` : ''} · page ${cur.page}`;
                    setLightbox({url: cur.scanUrl!, highlight: band ? {...band, label} : undefined});
                  } : undefined}
                />
              </div>
            </div>
          )}
        </>
      )}

      {otherFiles.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Also in this batch: {otherFiles.map((f) => f.filename).join(', ')} (sales, saved directly).
        </p>
      )}

      {/* Sticky commit bar */}
      {editable && reviewable.length > 0 && done == null && (
        <div className="sticky bottom-0 z-30 -mx-4 border-t border-border bg-background/90 backdrop-blur-sm max-md:bottom-16">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <span aria-live="polite" className={cn('text-sm', error ? 'text-destructive' : 'text-muted-foreground')}>
              {error ?? (readiness.ready ? `Ready: ${reviewable.length} ${reviewable.length === 1 ? 'page' : 'pages'} into one Inventory count.` : readiness.reason)}
            </span>
            <div className="flex items-center gap-2">
              {!readiness.ready && openFlags > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const k = pageInfo.findIndex((p) => p.flagged > p.resolved);
                    if (k >= 0) {
                      setTab(k);
                      requestAnimationFrame(() => goToFlagOnPage(k));
                    }
                  }}
                >
                  Go to next flag
                </Button>
              )}
              <Button onClick={commitAll} disabled={!readiness.ready || committing}>
                {committing ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                Commit all {reviewable.length} {reviewable.length === 1 ? 'page' : 'pages'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {lightbox && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/70 p-4 transition-opacity duration-150 ease-out starting:opacity-0 sm:p-8" role="dialog" aria-modal="true" aria-label="Scanned page" onKeyDown={(e) => e.key === 'Escape' && setLightbox(null)}>
          <div className="mb-2 flex items-center justify-between gap-2">
            {lightbox.highlight ? (
              <span className="inline-flex items-center gap-1.5 rounded-md bg-background/90 px-2.5 py-1 text-xs font-medium">
                <Crosshair className="size-3.5" style={{color: 'var(--primary)'}} /> {lightbox.highlight.label}
                <span className="text-muted-foreground">· approximate</span>
              </span>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <a href={lightbox.url} target="_blank" rel="noopener noreferrer" className={buttonVariants({variant: 'secondary', size: 'sm'})}>
                <ExternalLink className="size-3.5" /> Open in new tab
              </a>
              <Button variant="secondary" size="sm" autoFocus onClick={() => setLightbox(null)}>
                <X className="size-4" /> Close
              </Button>
            </div>
          </div>
          {/* The page rendered to a canvas, with the approximate row band drawn in the
              page's own coordinate space, so zooming/panning keeps it locked on (the old
              iframe overlay drifted). Falls back to the browser PDF viewer if it can't
              render. The band is approximate — see the "Show in scan" button. */}
          <div className="min-h-0 w-full flex-1">
            <ScanPageViewer url={lightbox.url} highlight={lightbox.highlight} className="h-full" />
          </div>
        </div>
      )}
    </div>
  );

  // Jump to the first open flag on page k (used after switching tabs).
  function goToFlagOnPage(k: number) {
    const p = pages[k];
    const s = state[p.upload.id];
    if (!s) return;
    const first = unresolvedFlags(flaggedById[p.upload.id] ?? [], s.resolved)[0];
    if (first == null) return;
    setState((all) => ({...all, [p.upload.id]: {...all[p.upload.id], active: first, query: '', view: 'needs'}}));
    requestAnimationFrame(() => {
      const row = reviewRowEl(first);
      row?.scrollIntoView({behavior: 'smooth', block: 'center'});
      row?.querySelector<HTMLInputElement>('input')?.focus({preventScroll: true});
    });
  }
}
