import {pageItemNames} from '@/src/goldline-legacy-extract';
import {rowNames} from '@/src/row-names';
import {printedPageItems, withPrintedHeadings} from '@/src/goldline-printed-page';
import {notFound, redirect} from 'next/navigation';
import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {catalogForCodes, formPageStrip, getBatch, getExtraction, getPageSuggestion, getUpload, listStores, listUploads} from '@/src/goldline-data';
import {getCurrentBas} from '@/src/goldline-ba-data';
import {uploadSource} from '@/src/goldline-upload-groups';
import {fileListParams, fileNeighbours, fileReviewQuery, parseFileFilter} from '@/src/scan-file-nav';
import {scanPageLabel} from '@/src/upload-batch';
import type {FormVersion} from '@/src/goldline-extract';
import {duplicateMatchFor, scanScopeIds} from '@/src/goldline-triage-data';
import {committedSnapshotFor, previousCounts} from '@/src/goldline-inventory-data';
import {historyCheckEnabled, historyNotes, latestBefore} from '@/src/goldline-history-check';
import {UploadReview} from '@/components/analyst/upload-review';
import {marksForUploads} from '@/src/goldline-review-marks-data';
import {addableProducts} from '@/src/goldline-add-row-data';
import {DuplicateBanner} from '@/components/analyst/duplicate-banner';
import {firstIsoDate, isoPeriod} from '@/src/period-date';

export const dynamic = 'force-dynamic';

// Per-file review page. A scanned inventory PDF opens the review workbench (the
// staged Claude Vision extraction, editable before commit); a sales CSV has no
// extraction, so it shows a status summary. Scoped to the active company — a
// mismatched id (or another tenant's) resolves to notFound().
//
// Opened from a scan's Per file list (`?from=file`), it is the one-page-at-a-time review:
// no batch redirect, store/period/BA prefilled from what Coop read on THIS page, a commit
// for this page alone, and ‹ › arrows through the same filtered list the reviewer came from.
const VERSIONS: FormVersion[] = ['legacy', 'v1', 'v2', 'unknown'];

export default async function Page(props: {params: Promise<{id: string}>; searchParams: Promise<Record<string, string | string[] | undefined>>}) {
  const {id} = await props.params;
  const sp = await props.searchParams;
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : null);
  const fromFile = one('from') === 'file';
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Sign in to a company you belong to to review uploads.</p>
      </div>
    );
  }
  const upload = await getUpload(ctx.companyId, id);
  if (!upload) notFound();
  // A page of a single store's FORM batch is reviewed WITH its batch: one place for the
  // store, period, every page and the commit, whichever way you got here (a file in the
  // batch, the Files list, a page link). A server-ingested SCAN batch is different, it spans
  // many pages across many stores, so it is never "one store's form": its pages are reviewed
  // one at a time here and sorted from the triage board, never funnelled into batch-review.
  // Committed, failed and single-file uploads keep this page too.
  // The Per file list opts out as well: there a page is reviewed and committed on its own.
  if (!fromFile && upload.kind === 'inventory_pdf' && upload.status === 'needs_review' && upload.batch_id) {
    const batch = await getBatch(ctx.companyId, upload.batch_id);
    if (batch?.status === 'open' && batch.kind !== 'scan') redirect(`/uploads/batch/${batch.id}?page=${upload.id}`);
  }
  const extraction = upload.kind === 'inventory_pdf' ? await getExtraction(ctx.companyId, id) : null;
  // Same-origin proxy (streams the private file) so the browser can embed it in an
  // <iframe> under the app CSP; null when there's no stored file.
  const scanUrl = upload.storage_path ? `/api/goldline/uploads/${upload.id}/file` : null;
  // Product names come from the detected page's manifest (item_code → printed product),
  // so the reviewer sees names next to the codes.
  const productNames: Record<string, string> = {};
  // A Legacy page names its rows from the Legacy form's own list (it has rows the shared list lacks).
  Object.assign(productNames, pageItemNames(upload.form_version, extraction?.page));
  // Once committed, link straight to the store + period this scan fed in Inventory.
  const snap = upload.status === 'committed' ? await committedSnapshotFor(ctx.companyId, upload.id) : null;
  const inventoryHref = snap
    ? `/stock?store=${encodeURIComponent(snap.store_code)}&period=${snap.period_start}_${snap.period_end}`
    : null;
  // Catalog line + price for this page's items (form grid, totals check) and the
  // latest scan of each form page (page strip). Only for a scan with an extraction.
  const codes = extraction?.data?.rows?.map((r) => r.item_code) ?? [];
  const [catalogRaw, pageStrip, stores] = extraction
    ? await Promise.all([catalogForCodes(ctx.companyId, codes), fromFile ? Promise.resolve(null) : formPageStrip(ctx.companyId, upload.id), listStores(ctx.companyId)])
    : [{}, null, []];
  // Headings and prices as printed on this version's form, so the grid matches the paper.
  const catalog = withPrintedHeadings(catalogRaw, printedPageItems(upload.form_version, extraction?.page));

  // The one-page view: where this page sits in the scan's Per file list (same filter, same
  // order, so the arrows step through what the reviewer was looking at), and Coop's
  // suggestion for its store, period and BA: this page's own read first, then the batch.
  let nav = null;
  let suggestion = null;
  let bas: {byStore: Record<string, string>; names: string[]} | undefined;
  if (fromFile) {
    const source = uploadSource(upload.filename);
    const version = VERSIONS.find((v) => v === one('version')) ?? null;
    const filter = parseFileFilter({type: one('type'), status: one('status'), fv: one('fv')});
    // Opened from a chosen store or BA (the triage board): the arrows, Back and breadcrumb all
    // stay inside that store/BA, not the whole scan. BA wins when both are present (the BA view
    // drills into the store view narrowed by BA). No scope = the plain Per file list.
    const baParam = one('ba');
    const storeParam = one('store');
    const scope = baParam ? ({kind: 'ba', name: baParam} as const) : storeParam ? ({kind: 'store', code: storeParam} as const) : null;
    const query = fileReviewQuery(filter, version, scope);
    const [all, read, batch, baReg] = await Promise.all([
      listUploads(ctx.companyId),
      getPageSuggestion(ctx.companyId, upload.id),
      upload.batch_id ? getBatch(ctx.companyId, upload.batch_id) : Promise.resolve(null),
      extraction ? getCurrentBas(ctx.companyId) : Promise.resolve(undefined),
    ]);
    const allFiles = all.filter((u) => uploadSource(u.filename) === source && (!version || (u.form_version ?? 'unknown') === version));
    // Narrow the ‹ › stepper to just this store's / BA's pages, grouped the same way the board is.
    const scopedIds = scope ? await scanScopeIds(ctx.companyId, source, scope, scope.kind === 'ba' ? baReg?.names ?? [] : []) : null;
    const files = scopedIds ? allFiles.filter((u) => scopedIds.has(u.id)) : allFiles;
    const {prev, next} = fileNeighbours(files, filter, upload.id);
    const enc = encodeURIComponent;
    const scanBase = `/uploads/scan/${enc(source)}`;
    // Keep the scan detail scoped to THIS upload drop (its batch) across Back and the breadcrumb,
    // so returning from a page review lands on this batch's scan — not every re-upload of the same
    // filename merged back together (PR #639's `?batch=` scope). upload.batch_id is the drop here.
    const batchQ = upload.batch_id ? `batch=${enc(upload.batch_id)}` : '';
    const scanWith = (qs: string) => {
      const parts = [batchQ, qs].filter(Boolean);
      return parts.length ? `${scanBase}?${parts.join('&')}` : scanBase;
    };
    const scanHref = scanWith('');
    const back = fileListParams(filter, version);
    // Back / the breadcrumb's scope link return to the board the way the reviewer left it: the
    // store (or BA) filtered view, or the Per file list with its filters when there's no scope.
    const scopeLabel = scope ? (scope.kind === 'ba' ? scope.name : stores.find((s) => s.code === scope.code)?.name ?? `Store ${scope.code}`) : null;
    const scopeHref = scope
      ? scanWith(scope.kind === 'ba' ? `view=store&ba=${enc(scope.name)}` : `view=store&store=${enc(scope.code)}`)
      : null;
    const backHref = scopeHref ?? scanWith(back.toString());
    nav = {
      source,
      label: scanPageLabel(upload.filename).title,
      prevHref: prev ? `/uploads/${prev.id}?${query}` : null,
      nextHref: next ? `/uploads/${next.id}?${query}` : null,
      backHref,
      // The clickable trail: the scan, then the chosen store/BA (when scoped).
      crumbs: [{label: source, href: scope ? scanHref : backHref}, ...(scope ? [{label: scopeLabel!, href: scopeHref!}] : [])],
    };
    const head = extraction?.data;
    const v = (x: string | null | undefined) => (x && x.trim() ? x.trim() : null); // '' is "not read"
    const pageStore = v(read.storeCode) ?? v(head?.store_code);
    // The page sort's date (YYYY-MM-DD, year-checked) first; else the reader's written date
    // converted ("10/16/2026"), since a non-ISO value blanks the date box.
    const {start: pageStart, end: pageEnd} = isoPeriod([read.periodStart, head?.period_start], [read.periodEnd, head?.period_end]);
    // The batch's store is only a fair guess for a page of the same count: in a shuffled
    // pile the batch carries one form's store, and a page dated another period is another
    // form. Better an honest blank (filled from the last committed page) than a wrong store.
    const samePeriod = !pageStart || (pageStart === batch?.period_start && (!pageEnd || pageEnd === batch?.period_end));
    const batchStore = samePeriod ? v(batch?.store_code) : null;
    suggestion = {
      storeCode: pageStore ?? batchStore,
      storeFrom: pageStore ? ('page' as const) : batchStore ? ('batch' as const) : null,
      periodStart: pageStart ?? firstIsoDate(batch?.period_start),
      periodEnd: pageEnd ?? firstIsoDate(batch?.period_end),
      consultant: v(read.consultant) ?? v(head?.consultant),
    };
    bas = baReg;
  }
  // Opened on its own (not from the scan's page list, e.g. a direct or "earlier copy" link):
  // still fill the period boxes from the page sort's date, else the reader's converted text.
  let periodDefault: {start: string | null; end: string | null} | null = null;
  if (!suggestion && extraction) {
    const read = await getPageSuggestion(ctx.companyId, upload.id);
    periodDefault = isoPeriod([read.periodStart, extraction.data?.period_start], [read.periodEnd, extraction.data?.period_end]);
  }
  // History check (flags only): rows the same store's last committed count can't explain.
  let rowNotes: Record<number, string> = {};
  if (extraction && upload.status === 'needs_review' && historyCheckEnabled(ctx.companyId)) {
    const head = extraction.data;
    const store = suggestion?.storeCode ?? (head?.store_code?.trim() || null);
    const start = suggestion?.periodStart ?? periodDefault?.start ?? null;
    const prev = await previousCounts(ctx.companyId, store, start, codes);
    if (start && prev.length) rowNotes = historyNotes(head?.rows ?? [], latestBefore(prev, start), upload.form_version);
  }
  // Phase 2: a re-upload / duplicate of the same form page, with a count diff. Only
  // meaningful while this page is still under review (not after it's committed itself).
  const duplicate = upload.kind === 'inventory_pdf' && upload.status === 'needs_review'
    ? await duplicateMatchFor(ctx.companyId, upload.id)
    : null;
  // Review flags (NICH-42). A database without the table yet (p6_review_marks.sql) just shows none.
  const marks = upload.kind === 'inventory_pdf'
    ? await marksForUploads(ctx.companyId, [upload.id]).catch((e) => (console.error('review marks', e), []))
    : [];
  // Add product row (NICH-42): only while the page can still be edited and committed.
  const addable = upload.kind === 'inventory_pdf' && upload.status === 'needs_review' && canEditData(ctx.role)
    ? await addableProducts(ctx.companyId, upload.form_version).catch((e) => (console.error('addable products', e), []))
    : [];
  return (
    <div className="flex flex-col gap-4">
      {duplicate && (
        <div className="mx-auto w-full max-w-[140rem] px-4 pt-6 xl:px-6">
          <DuplicateBanner match={duplicate} />
        </div>
      )}
      <UploadReview
      key={upload.id}
      company={ctx.companyId}
      canEdit={canEditData(ctx.role)}
      upload={upload}
      marks={marks}
      addable={addable}
      extraction={extraction}
      scanUrl={scanUrl}
      productNames={productNames}
      rowNames={rowNames(extraction?.data?.rows ?? [], upload.form_version, extraction?.page)}
      inventoryHref={inventoryHref}
      catalog={catalog}
      pageStrip={pageStrip}
      stores={stores}
      nav={nav}
      suggestion={suggestion}
      periodDefault={periodDefault}
      rowNotes={rowNotes}
      bas={bas}
    />
    </div>
  );
}
