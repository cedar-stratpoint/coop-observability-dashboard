'use server';
import {allowedPrices, cleanBands, flaggedRowIndexes, stampPickedPrices, type PaperBand} from '@/src/band-prices';

import {revalidatePath, revalidateTag} from 'next/cache';
import {expireSalesTotals, glTags} from '@/src/goldline-ref-data';
import {runChecks} from '@/src/goldline-checks-data';
import {learnFormBa, resolveFormBa} from '@/src/goldline-ba-data';
import {getDataContext} from '@/src/active-context';
import {canEditData, outOfScopeStores} from '@/src/company';
import {isSettledStatus, type ServerBatchProgress, type ServerPageProgress} from '@/src/server-upload-progress';
import {summarizeScanRows, type ScanReadingSummary} from '@/src/scan-reading';
import {uploadSource} from '@/src/goldline-upload-groups';
import {serverUploadEnabled} from '@/src/goldline-server-upload';
import {logReadEvent} from '@/src/goldline-read-log';
import {setBandMarkStatus} from '@/src/goldline-review-marks-data';
import {auth} from '@/auth';
import {bulkVerdict, type BulkVerdict} from '@/src/upload-batch';
import {LOW_BELOW, rowConfidence} from '@/src/review-confidence';
import {isoPeriod} from '@/src/period-date';
import {knownStoreCodes} from '@/src/goldline-store-registry';
import {duplicateCodeMessage, withProductCodes} from '@/src/accessory-codes';
import {
  fileFormPages,
  setAsidePages,
  setExtractionBandPrice,
  batchFamily,
  BatchConflictError,
  BatchStateError,
  commitBatch,
  commitInventory,
  createBatch,
  deleteImpact,
  deleteUpload,
  deleteScanGroup,
  deleteBatch,
  getBatch,
  getBatchPages,
  getExtraction,
  getUpload,
  latestActiveScan,
  listStores,
  scanGroupSummary,
  scanBatchSummary,
  setUploadsBa,
  setUploadsStore,
  splitBatchIntoForms,
  updateBatchInfo,
  uploadStores,
  type DeleteImpact,
  type ScanGroupSummary,
  type SplitForm,
  type ReviewedInventoryRow,
} from '@/src/goldline-data';

// Server action behind the review screen's "Commit" button. Re-derives the tenant
// context server-side (never trusts a company id from the client beyond the switcher
// hint), re-checks write capability + store scope, coerces the submitted rows, then
// writes inventory and closes the upload. All the authorization that the upload
// route enforces is enforced again here — the two are independent entry points.

export type CommitResult = {ok: true; committed: number} | {ok: false; error: string};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 2000; // a Nichido cycle is ~500 SKUs/page; well under this.
const COUNT_MAX = 1_000_000; // a stock count beyond this is a transcription error, not data.
const COUNT_KEYS = ['stockroom', 'drawer', 'selling_area', 'delivery', 'ending_on_hand'] as const;

/** A real calendar date in YYYY-MM-DD (rejects 2026-02-30 etc.), not just the shape. */
function validIsoDate(s: string): boolean {
  if (!ISO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function toIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function coerceRow(r: unknown): ReviewedInventoryRow | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const code = typeof o.item_code === 'string' ? o.item_code.trim() : '';
  if (!code) return null;
  return {
    item_code: code,
    stockroom: toIntOrNull(o.stockroom),
    drawer: toIntOrNull(o.drawer),
    selling_area: toIntOrNull(o.selling_area),
    delivery: toIntOrNull(o.delivery),
    ending_on_hand: toIntOrNull(o.ending_on_hand),
  };
}

/** What a delete would remove (committed inventory counts / sales rows), for the
 *  confirmation dialog. Read-only; same company scoping as the delete itself. */
export async function deleteImpactAction(input: {
  company: string | null;
  uploadId: string;
}): Promise<{ok: true; impact: DeleteImpact} | {ok: false; error: string}> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role cannot delete uploads.'};
  try {
    const out = await outOfScopeFor(ctx, input.uploadId);
    if (out) return {ok: false, error: out};
    const impact = await deleteImpact(ctx.companyId, input.uploadId);
    if (!impact) return {ok: false, error: 'Upload not found.'};
    return {ok: true, impact};
  } catch (e) {
    console.error('deleteImpactAction', e);
    return {ok: false, error: 'Couldn’t check what this file feeds. Please try again.'};
  }
}

/** A store-scoped role may only delete uploads for its own stores. Returns the refusal
 *  message, or null when allowed (unscoped roles always pass). */
async function outOfScopeFor(ctx: {companyId: string | null; storeScope?: string[] | null}, uploadId: string): Promise<string | null> {
  if (!ctx.companyId || !ctx.storeScope) return null;
  const out = outOfScopeStores(ctx.storeScope, await uploadStores(ctx.companyId, uploadId));
  return out.length ? `This file covers stores outside your access (${out.slice(0, 5).join(', ')}).` : null;
}

/** Delete an upload — file, staged extraction, the inventory counts / sales rows it
 *  is still the source of, and the row — scoped to the active company. */
export async function deleteUploadAction(input: {company: string | null; uploadId: string}): Promise<CommitResult> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role cannot delete uploads.'};
  try {
    const out = await outOfScopeFor(ctx, input.uploadId);
    if (out) return {ok: false, error: out};
    // A scan's stores are few (its counts); a sales file can touch every store, and its
    // rows only matter to counted stores, so it re-runs the checks for those instead.
    const upload = await getUpload(ctx.companyId, input.uploadId);
    const touched = upload?.kind === 'inventory_pdf' ? await uploadStores(ctx.companyId, input.uploadId).catch(() => [] as string[]) : null;
    const ok = await deleteUpload(ctx.companyId, input.uploadId);
    if (!ok) return {ok: false, error: 'Upload not found.'};
    // A sales file's rows are gone with it, so the cached sales totals are too.
    if (upload && upload.kind !== 'inventory_pdf') expireSalesTotals(ctx.companyId);
    await runChecks(ctx.companyId, touched?.length ? touched : undefined).catch((e) => console.error('runChecks after delete', e));
    revalidateTag(glTags.uploads(ctx.companyId), {expire: 0});
    revalidatePath('/uploads');
    revalidatePath('/stock');
    revalidatePath('/overview');
    return {ok: true, committed: 0};
  } catch (e) {
    console.error('deleteUploadAction', e);
    // deleteUpload drops the sales rows first, so a later step failing can still change them.
    expireSalesTotals(ctx.companyId);
    return {ok: false, error: 'Could not delete the upload. Please try again.'};
  }
}

export async function commitReview(input: {
  company: string | null;
  uploadId: string;
  storeCode: string;
  periodStart: string;
  periodEnd: string;
  consultant?: string | null;
  rows: unknown[];
}): Promise<CommitResult> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized to commit for this company.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role cannot commit reviews.'};

  // Ownership: the uploadId is client-supplied — confirm it belongs to THIS tenant
  // before any write, so a crafted id can't cross-link one company's inventory to
  // another's upload (the inventory insert stamps our company_id but would
  // otherwise store a foreign source_upload_id, and the status updates would no-op).
  const upload = await getUpload(ctx.companyId, input.uploadId);
  if (!upload) return {ok: false, error: 'Upload not found.'};

  const store = (input.storeCode ?? '').trim();
  if (!store) return {ok: false, error: 'A store code is required before committing.'};
  if (!validIsoDate(input.periodStart) || !validIsoDate(input.periodEnd)) {
    return {ok: false, error: 'Period start and end must be valid dates (YYYY-MM-DD).'};
  }
  if (input.periodStart > input.periodEnd) {
    return {ok: false, error: 'Period start must not be after period end.'};
  }
  if (outOfScopeStores(ctx.storeScope, [store]).length) {
    return {ok: false, error: `Store ${store} is outside your access.`};
  }

  const coerced = (Array.isArray(input.rows) ? input.rows : [])
    .map(coerceRow)
    .filter((r): r is ReviewedInventoryRow => r !== null)
    .slice(0, MAX_ROWS);
  if (!coerced.length) return {ok: false, error: 'No valid rows to commit.'};
  // Accessories are printed under shared price codes; save each under its own product code.
  const extraction = await getExtraction(ctx.companyId, input.uploadId);
  // A band whose written price the reviewer picked keeps that price on its committed rows.
  const rows = withProductCodes(stampPickedPrices(coerced, cleanBands(extraction?.data?.bands)), upload.form_version, extraction?.page);
  const dup = duplicateCodeMessage(rows);
  if (dup) return {ok: false, error: dup};

  // Counts are non-negative and bounded — reject loudly rather than store garbage.
  for (const r of rows) {
    for (const k of COUNT_KEYS) {
      const v = r[k];
      if (v !== null && (v < 0 || v > COUNT_MAX)) {
        return {ok: false, error: `Row ${r.item_code}: ${k} (${v}) is out of range.`};
      }
    }
  }

  try {
    const consultant = await resolveFormBa(ctx.companyId, store, input.periodEnd, input.consultant);
    const committed = await commitInventory({
      companyId: ctx.companyId,
      uploadId: input.uploadId,
      storeCode: store,
      period: {start: input.periodStart, end: input.periodEnd},
      consultant,
      rows,
    });
    await learnFormBa(ctx.companyId, {store, periodStart: input.periodStart, name: consultant, written: input.consultant, by: (await auth())?.user?.email ?? null});
    // The P2 checks follow every change to counts; a failing check never fails the commit.
    await runChecks(ctx.companyId, [store]).catch((e) => console.error('runChecks after commit', e));
    revalidateTag(glTags.uploads(ctx.companyId), {expire: 0});
    revalidatePath('/uploads');
    revalidatePath(`/uploads/${input.uploadId}`);
    revalidatePath('/flags');
    revalidatePath('/bas');
    return {ok: true, committed};
  } catch (e) {
    // Don't leak Postgres/schema detail to the browser; log it server-side.
    console.error('commitReview failed', e);
    return {ok: false, error: 'Could not commit the review. Please try again.'};
  }
}


// ── Band prices (QA San Pablo, Nov 25) ────────────────────────────────────────────────

export type BandPriceResult = {ok: true; bands: PaperBand[]} | {ok: false; error: string};

/**
 * Pick the price a flagged band is valued at for THIS form: the printed price or the one the
 * paper points at (written beside the band, or implied by its total). `price: null` takes the
 * pick back. Only those two prices are accepted; the catalog never changes. The band's
 * "Price written" flag is cleared by a pick and reopened when it is taken back.
 */
export async function setBandPriceAction(input: {company: string | null; uploadId: string; group: string; price: number | null}): Promise<BandPriceResult> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role cannot edit reviews.'};
  if (typeof input.uploadId !== 'string' || !UUID.test(input.uploadId)) return {ok: false, error: 'That page could not be found.'};
  if (typeof input.group !== 'string' || !input.group.trim() || input.group.length > 200) return {ok: false, error: 'That band could not be found.'};
  try {
    const out = await outOfScopeFor(ctx, input.uploadId);
    if (out) return {ok: false, error: out};
    const upload = await getUpload(ctx.companyId, input.uploadId);
    if (!upload) return {ok: false, error: 'That page could not be found.'};
    if (upload.status !== 'needs_review') return {ok: false, error: 'This page is already committed.'};
    const ex = await getExtraction(ctx.companyId, input.uploadId);
    const band = cleanBands(ex?.data?.bands).find((b) => b.group === input.group);
    if (!band || band.kind == null) return {ok: false, error: 'That band could not be found. Reload the page.'};
    if (input.price != null && !allowedPrices(band).includes(input.price)) return {ok: false, error: 'Pick the printed price or the one on the paper.'};
    const bands = await setExtractionBandPrice(ctx.companyId, input.uploadId, input.group, input.price);
    if (!bands) return {ok: false, error: 'That band could not be found. Reload the page.'};
    const code = ex?.data?.rows?.[band.first_index ?? -1]?.item_code;
    if (code) {
      await setBandMarkStatus(ctx.companyId, input.uploadId, code, input.price == null, (await auth())?.user?.email ?? null).catch((e) => console.error('band mark', e));
    }
    revalidatePath(`/uploads/${input.uploadId}`);
    if (upload.batch_id) revalidatePath(`/uploads/batch/${upload.batch_id}`);
    return {ok: true, bands};
  } catch (e) {
    console.error('setBandPriceAction', e);
    return {ok: false, error: 'Could not save the price. Please try again.'};
  }
}

// ── Upload batches ──────────────────────────────────────────────────────────────

/** Coerce + bound one page's submitted rows (same rules as a single-page commit). */
function cleanRows(raw: unknown[]): {ok: true; rows: ReviewedInventoryRow[]} | {ok: false; error: string} {
  const rows = (Array.isArray(raw) ? raw : [])
    .map(coerceRow)
    .filter((r): r is ReviewedInventoryRow => r !== null)
    .slice(0, MAX_ROWS);
  for (const r of rows) {
    for (const k of COUNT_KEYS) {
      const v = r[k];
      if (v !== null && (v < 0 || v > COUNT_MAX)) return {ok: false, error: `Row ${r.item_code}: ${k} (${v}) is out of range.`};
    }
  }
  return {ok: true, rows};
}

export type BatchResult = {ok: true; batchId: string} | {ok: false; error: string};

/** Start a batch for the active company (the uploader calls this before sending files). */
export async function createBatchAction(input: {company: string | null}): Promise<BatchResult> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized to upload for this company.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role cannot upload data.'};
  try {
    const session = await auth();
    return {ok: true, batchId: await createBatch(ctx.companyId, session?.user?.email ?? null)};
  } catch (e) {
    console.error('createBatchAction', e);
    return {ok: false, error: 'Could not start the upload. Please try again.'};
  }
}

/** Save the batch's store + period (entered once; prefilled from page 1). */
export async function updateBatchInfoAction(input: {
  company: string | null;
  batchId: string;
  storeCode: string;
  periodStart: string;
  periodEnd: string;
}): Promise<{ok: true} | {ok: false; error: string}> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role cannot edit uploads.'};
  const batch = await getBatch(ctx.companyId, input.batchId);
  if (!batch) return {ok: false, error: 'Upload batch not found.'};
  if (batch.status !== 'open') return {ok: false, error: 'This batch is already committed.'};
  const store = (input.storeCode ?? '').trim() || null;
  const start = input.periodStart && validIsoDate(input.periodStart) ? input.periodStart : null;
  const end = input.periodEnd && validIsoDate(input.periodEnd) ? input.periodEnd : null;
  if (start && end && start > end) return {ok: false, error: 'Period start must not be after period end.'};
  if (store && outOfScopeStores(ctx.storeScope, [store]).length) return {ok: false, error: `Store ${store} is outside your access.`};
  try {
    await updateBatchInfo(ctx.companyId, input.batchId, {storeCode: store, periodStart: start, periodEnd: end});
    return {ok: true};
  } catch (e) {
    console.error('updateBatchInfoAction', e);
    return {ok: false, error: 'Could not save the store and period. Please try again.'};
  }
}

/**
 * "Commit all pages": every page of the batch into one Inventory count, with the
 * batch's store + period. Same authorization and validation as a single-page commit,
 * plus: every page must belong to this batch and still be awaiting review.
 */
export async function commitBatchAction(input: {
  company: string | null;
  batchId: string;
  storeCode: string;
  periodStart: string;
  periodEnd: string;
  consultant?: string | null;
  pages: Array<{uploadId: string; rows: unknown[]}>;
}): Promise<CommitResult> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized to commit for this company.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role cannot commit reviews.'};

  const batch = await getBatch(ctx.companyId, input.batchId);
  if (!batch) return {ok: false, error: 'Upload batch not found.'};
  if (batch.status !== 'open') return {ok: false, error: 'This batch is already committed.'};

  const store = (input.storeCode ?? '').trim();
  if (!store) return {ok: false, error: 'A store code is required before committing.'};
  if (!validIsoDate(input.periodStart) || !validIsoDate(input.periodEnd)) {
    return {ok: false, error: 'Period start and end must be valid dates (YYYY-MM-DD).'};
  }
  if (input.periodStart > input.periodEnd) return {ok: false, error: 'Period start must not be after period end.'};
  if (outOfScopeStores(ctx.storeScope, [store]).length) return {ok: false, error: `Store ${store} is outside your access.`};

  const batchPages = await getBatchPages(ctx.companyId, input.batchId);
  const owned = new Map(batchPages.map((p) => [p.upload.id, p]));
  if (batchPages.some((p) => p.upload.status === 'processing')) {
    return {ok: false, error: 'A page is still being read. Wait for it to finish, then commit.'};
  }
  const awaiting = batchPages.filter((p) => p.upload.kind === 'inventory_pdf' && p.upload.status === 'needs_review');
  const pages: Array<{uploadId: string; rows: ReviewedInventoryRow[]}> = [];
  const sent = new Set<string>();
  for (const p of (Array.isArray(input.pages) ? input.pages : []).slice(0, 50)) {
    const mine = owned.get(p?.uploadId);
    if (!mine) return {ok: false, error: 'A page doesn’t belong to this batch.'};
    if (mine.upload.kind !== 'inventory_pdf') continue; // legacy: a CSV that joined a batch commits on its own
    if (mine.upload.status !== 'needs_review') return {ok: false, error: `${mine.upload.filename} isn’t awaiting review.`};
    if (sent.has(p.uploadId)) continue;
    sent.add(p.uploadId);
    const clean = cleanRows(p.rows);
    if (!clean.ok) return clean;
    pages.push({uploadId: p.uploadId, rows: withProductCodes(stampPickedPrices(clean.rows, cleanBands(mine.extraction?.data?.bands)), mine.upload.form_version, mine.extraction?.page)});
  }
  // Every page awaiting review commits together — none left behind in an emptied batch.
  if (awaiting.length !== sent.size || awaiting.some((p) => !sent.has(p.upload.id))) {
    return {ok: false, error: 'The pages in this batch changed. Reload the page to see them all, then commit.'};
  }
  if (!pages.some((p) => p.rows.length)) return {ok: false, error: 'No valid rows to commit.'};

  try {
    const consultant = await resolveFormBa(ctx.companyId, store, input.periodEnd, input.consultant);
    const {committed} = await commitBatch({
      companyId: ctx.companyId,
      batchId: input.batchId,
      storeCode: store,
      period: {start: input.periodStart, end: input.periodEnd},
      consultant,
      pages,
    });
    await learnFormBa(ctx.companyId, {store, periodStart: input.periodStart, name: consultant, written: input.consultant, by: (await auth())?.user?.email ?? null});
    // The P2 checks follow every change to counts; a failing check never fails the commit.
    await runChecks(ctx.companyId, [store]).catch((e) => console.error('runChecks after commit', e));
    revalidateTag(glTags.uploads(ctx.companyId), {expire: 0});
    revalidatePath('/uploads');
    revalidatePath(`/uploads/batch/${input.batchId}`);
    revalidatePath('/stock');
    revalidatePath('/flags');
    revalidatePath('/bas');
    return {ok: true, committed};
  } catch (e) {
    if (e instanceof BatchConflictError) {
      return {ok: false, error: `Item ${e.itemCode} appears more than once. A page may have been scanned twice, or a code was misread. Fix or remove the duplicate and try again.`};
    }
    if (e instanceof BatchStateError) {
      return {
        ok: false,
        error: e.reason === 'closed' ? 'This batch was already committed.' : 'The pages in this batch changed. Reload the page to see them all, then commit.',
      };
    }
    console.error('commitBatchAction', e);
    return {ok: false, error: 'Could not commit these pages. Please try again; committing again is safe.'};
  }
}

// ── Commit all forms of a grouped upload (Nov 25) ─────────────────────────────────────

/** One form as the "Commit all" confirm shows it. Store and period are the ones the form's
 *  own review page would open with (the batch's, else the first page's reading). */
export type BulkCommitForm = {
  batchId: string;
  storeCode: string;
  periodStart: string;
  periodEnd: string;
  pages: number;
  rows: number;
  verdict: BulkVerdict;
};
type BulkPlan = BulkCommitForm & {consultant: string | null; send: Array<{uploadId: string; rows: unknown[]}>};

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * With `dropId`, every batch of that upload counts too (Nov 25), found by the batches
 * themselves, not by how the board grouped pages: one page read with the wrong year split
 * San Pablo's Sep 16 to 30 off its batch on the board, so Commit all never offered it.
 * Those extra batches are only planned when they are open store forms with pages to commit.
 */
async function planBulk(companyId: string, batchIds: string[], dropId?: string | null): Promise<BulkPlan[]> {
  const asked = new Set(batchIds.filter((id) => typeof id === 'string' && UUID.test(id)));
  const family = dropId && UUID.test(dropId) ? await batchFamily(companyId, dropId) : [];
  const ids = [...new Set([...asked, ...family])].slice(0, 200);
  const out: BulkPlan[] = [];
  const known = new Set(await knownStoreCodes(companyId));
  for (const batchId of ids) {
    const batch = await getBatch(companyId, batchId);
    if (!batch) continue; // not this company's
    // Already committed: nothing to do, and not worth a line in the confirm.
    if (batch.status !== 'open') continue;
    // A batch found through the upload (not asked for): only a store form counts.
    if (!asked.has(batchId) && batch.kind !== 'form') continue;
    const base = {batchId, storeCode: batch.store_code ?? '', periodStart: '', periodEnd: '', pages: 0, rows: 0, consultant: null, send: []};
    if (batch.kind !== 'form') {
      out.push({...base, verdict: {state: 'blocked', reason: 'Part of a server scan. Commit its pages one by one.'}});
      continue;
    }
    const pdf = (await getBatchPages(companyId, batchId)).filter((p) => p.upload.kind === 'inventory_pdf');
    const header = pdf.find((p) => p.extraction?.page === 1)?.extraction?.data;
    const period = isoPeriod([batch.period_start, header?.period_start], [batch.period_end, header?.period_end]);
    const storeCode = (batch.store_code ?? header?.store_code ?? '').trim();
    const info = pdf.map((p) => ({
      uploadId: p.upload.id,
      page: p.extraction?.page ?? null,
      flagged: flaggedRowIndexes(p.extraction?.data, LOW_BELOW).length,
      resolved: 0,
      status: p.upload.status,
      detectedStore: p.detectedStore,
    }));
    const reviewable = pdf.filter((p) => p.upload.status === 'needs_review');
    if (!asked.has(batchId) && !reviewable.length) continue;
    // The rows exactly as read: what the form's own review page starts from.
    const send = reviewable.map((p) => ({
      uploadId: p.upload.id,
      rows: (p.extraction?.data?.rows ?? []).map((r) => ({
        item_code: r.item_code,
        stockroom: r.stockroom,
        drawer: r.drawer,
        selling_area: r.selling_area,
        delivery: r.delivery,
        ending_on_hand: r.ending_on_hand,
      })),
    }));
    out.push({
      batchId,
      storeCode,
      periodStart: period.start ?? '',
      periodEnd: period.end ?? '',
      pages: reviewable.length,
      rows: send.reduce((n, p) => n + p.rows.length, 0),
      consultant: header?.consultant ?? null,
      send,
      // A code the registry doesn't know is a misread: the board shows it as "Needs a store".
      verdict:
        storeCode && !known.has(storeCode)
          ? {state: 'blocked', reason: `Store ${storeCode} isn't in the store list. Confirm the store first.`}
          : bulkVerdict({storeCode, periodStart: period.start ?? '', periodEnd: period.end ?? '', pages: info}),
    });
  }
  return out;
}

const FILE_ERROR: Record<string, string> = {
  page_not_found: 'A page of this form is gone. Reload and try again.',
  page_not_to_review: 'A page of this form was already committed or set aside.',
  pages_in_several_batches: 'This form’s pages are mixed with another form. Sort it on the board.',
  batch_not_open: 'This form was already committed.',
};

/**
 * Commit all (Nov 25): file one form under a store and period so it can commit: a store
 * picked in the confirm, or a stray form whose store was read but whose pages never became a
 * store form (a lone page, or a misread year the board corrects). See fileFormPages.
 */
export async function fileFormAction(input: {
  company: string | null;
  uploadIds: string[];
  storeCode: string;
  periodStart: string;
  periodEnd: string;
  /** The person picked this store (the pages' read store is replaced), vs. a store read off the form. */
  picked: boolean;
}): Promise<{ok: true; batchId: string} | {ok: false; error: string}> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized for this company.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role cannot commit reviews.'};
  const store = (input.storeCode ?? '').trim();
  const ids = (Array.isArray(input.uploadIds) ? input.uploadIds : []).filter((x) => typeof x === 'string' && UUID.test(x));
  if (!store || !ids.length) return {ok: false, error: 'Pick a store first.'};
  if (!validIsoDate(input.periodStart) || !validIsoDate(input.periodEnd) || input.periodStart > input.periodEnd) {
    return {ok: false, error: 'No usable date on this form. Open it to set the period.'};
  }
  if (outOfScopeStores(ctx.storeScope, [store]).length) return {ok: false, error: `Store ${store} is outside your access.`};
  try {
    const stores = await listStores(ctx.companyId);
    const known = stores.find((s) => s.code === store);
    if (!known) return {ok: false, error: `Store ${store} isn’t in the store list.`};
    const batchId = await fileFormPages(
      ctx.companyId,
      ids,
      {storeCode: store, storeName: known.name, periodStart: input.periodStart, periodEnd: input.periodEnd, picked: input.picked},
      (await auth())?.user?.email ?? null,
    );
    revalidateTag(glTags.uploads(ctx.companyId), {expire: 0});
    await logReadEvent({companyId: ctx.companyId, event: 'assign_store', status: 'ok', storeCode: store, detail: {uploadIds: ids, batchId, via: 'commit_all'}});
    return {ok: true, batchId};
  } catch (e) {
    const code = e instanceof Error ? e.message : '';
    if (!FILE_ERROR[code]) console.error('fileFormAction', e);
    return {ok: false, error: FILE_ERROR[code] ?? 'Couldn’t file this form. Try again, or open it from the board.'};
  }
}

/** Commit all (Nov 25): set pages aside that have no store to file them under. */
export async function setAsideAction(input: {company: string | null; uploadIds: string[]}): Promise<{ok: true; count: number} | {ok: false; error: string}> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized for this company.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role cannot change uploads.'};
  const ids = (Array.isArray(input.uploadIds) ? input.uploadIds : []).filter((x) => typeof x === 'string' && UUID.test(x));
  if (!ids.length) return {ok: false, error: 'No pages to set aside.'};
  try {
    const count = await setAsidePages(ctx.companyId, ids, 'Set aside in Commit all: no store to file it under.');
    revalidateTag(glTags.uploads(ctx.companyId), {expire: 0});
    revalidatePath('/uploads');
    return {ok: true, count};
  } catch (e) {
    console.error('setAsideAction', e);
    return {ok: false, error: 'Couldn’t set these pages aside. Try again.'};
  }
}

/** What "Commit all" would do, for its confirm. Read-only. */
export async function planCommitAllAction(input: {company: string | null; batchIds: string[]; dropId?: string | null}): Promise<{ok: true; forms: BulkCommitForm[]} | {ok: false; error: string}> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized for this company.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role cannot commit reviews.'};
  try {
    const plan = await planBulk(ctx.companyId, input.batchIds, input.dropId);
    return {ok: true, forms: plan.map(({consultant: _c, send: _s, ...f}) => f)};
  } catch (e) {
    console.error('planCommitAllAction', e);
    return {ok: false, error: 'Could not read these forms. Please try again.'};
  }
}

/**
 * Commit every ready form of a grouped upload, one form at a time, each through the same
 * commitBatchAction a single form uses (same access, scope and validation; one form
 * failing doesn't undo the others). The plan is re-read here, never trusted from the browser.
 */
export async function commitAllAction(input: {
  company: string | null;
  batchIds: string[];
  includeFlagged: boolean;
}): Promise<{ok: true; results: Array<{batchId: string; ok: boolean; committed: number; error?: string}>} | {ok: false; error: string}> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized for this company.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role cannot commit reviews.'};
  let plan: BulkPlan[];
  try {
    plan = await planBulk(ctx.companyId, input.batchIds);
  } catch (e) {
    console.error('commitAllAction plan', e);
    return {ok: false, error: 'Could not read these forms. Please try again.'};
  }
  const go = plan.filter((f) => f.verdict.state === 'ready' || (f.verdict.state === 'flagged' && input.includeFlagged));
  if (!go.length) return {ok: false, error: 'No form is ready to commit.'};
  const results: Array<{batchId: string; ok: boolean; committed: number; error?: string}> = [];
  for (const f of go) {
    const res = await commitBatchAction({
      company: input.company,
      batchId: f.batchId,
      storeCode: f.storeCode,
      periodStart: f.periodStart,
      periodEnd: f.periodEnd,
      consultant: f.consultant,
      pages: f.send,
    });
    results.push(res.ok ? {batchId: f.batchId, ok: true, committed: res.committed} : {batchId: f.batchId, ok: false, committed: 0, error: res.error});
  }
  return {ok: true, results};
}

/**
 * Many stores in one scan: once every page of the drop is read, split the batch into
 * one batch per form (a new form wherever the page number drops back, e.g. 5 to 1).
 */
export async function splitFormsAction(input: {company: string | null; batchId: string}): Promise<{ok: true; forms: SplitForm[]} | {ok: false; error: string}> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized for this company.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role cannot change uploads.'};
  if (!/^[0-9a-f-]{36}$/i.test(input.batchId ?? '')) return {ok: false, error: 'Upload batch not found.'};
  try {
    const session = await auth();
    const forms = await splitBatchIntoForms(ctx.companyId, input.batchId, session?.user?.email ?? null);
    revalidateTag(glTags.uploads(ctx.companyId), {expire: 0});
    revalidatePath('/uploads');
    return {ok: true, forms};
  } catch (e) {
    console.error('splitFormsAction', e);
    return {ok: false, error: 'Couldn’t split the scan into forms. Each page is saved; open Uploads to review them.'};
  }
}

/**
 * Server-driven upload (P2): the browser polls this for a batch's live page progress while
 * the pump reads it, so the uploader shows each page land in place without the in-memory
 * queue. Company-scoped + flag-gated (off = no server batches exist, so it returns empty).
 * Reads straight from the DB (not cached) so each poll is fresh. Inventory pages only.
 */
export async function serverBatchProgressAction(input: {
  company: string | null;
  batchId: string;
}): Promise<{ok: true; progress: ServerBatchProgress} | {ok: false; error: string}> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized for this company.'};
  if (!serverUploadEnabled(ctx.companyId)) return {ok: false, error: 'Server-driven upload is not enabled for this company.'};
  if (!/^[0-9a-f-]{36}$/i.test(input.batchId ?? '')) return {ok: false, error: 'Upload batch not found.'};
  try {
    const rows = await getBatchPages(ctx.companyId, input.batchId);
    const pages: ServerPageProgress[] = rows
      .filter((p) => p.upload.kind === 'inventory_pdf')
      .map((p) => {
        const rows = p.extraction?.data?.rows ?? null;
        return {
          uploadId: p.upload.id,
          filename: p.upload.filename,
          status: p.upload.status,
          page: p.extraction?.page ?? null,
          formVersion: p.upload.form_version ?? null,
          pageKind: p.upload.page_kind ?? null,
          flagged: rows ? flaggedRowIndexes(p.extraction?.data, LOW_BELOW).length : null,
          rows: rows ? rows.length : null,
        };
      });
    return {ok: true, progress: {batchId: input.batchId, pages, settled: pages.every((p) => isSettledStatus(p.status))}};
  } catch (e) {
    console.error('serverBatchProgressAction', e);
    return {ok: false, error: 'Couldn’t read the scan’s progress.'};
  }
}

/**
 * Server-driven upload: the company's most recent scan still being read, for the refresh-
 * surviving "reading" indicator (floating dock off Uploads, card on Uploads). Unlike
 * serverBatchProgressAction it needs no batchId from the client — it discovers the active
 * batch from DB state, so it works on any page and after a refresh. Company-scoped and
 * flag-gated (off ⇒ always null, so no polling cost for other tenants). Returns null when
 * nothing is in flight.
 */
export async function activeScanProgressAction(input: {
  company: string | null;
}): Promise<{ok: true; scan: ScanReadingSummary | null} | {ok: false; error: string}> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized for this company.'};
  if (!serverUploadEnabled(ctx.companyId)) return {ok: true, scan: null};
  try {
    const found = await latestActiveScan(ctx.companyId);
    if (!found) return {ok: true, scan: null};
    // uploadSource keys the scan the same way the /uploads/scan/[source] page does, so its
    // banner can match its own scan exactly.
    const source = uploadSource(found.filename ?? found.batchId);
    return {ok: true, scan: summarizeScanRows(found.statuses.map((status) => ({status})), found.batchId, source)};
  } catch (e) {
    console.error('activeScanProgressAction', e);
    return {ok: false, error: 'Couldn’t check scan progress.'};
  }
}

/** What deleting a whole scan drop would remove — for the confirmation before the user commits. */
export async function scanGroupSummaryAction(input: {company: string | null; source: string; batchId?: string | null}): Promise<{ok: true; summary: ScanGroupSummary} | {ok: false; error: string}> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized for this company.'};
  try {
    const batchId = (input.batchId ?? '').trim();
    const summary = batchId
      ? await scanBatchSummary(ctx.companyId, batchId)
      : await scanGroupSummary(ctx.companyId, (input.source ?? '').trim());
    return {ok: true, summary};
  } catch (e) {
    console.error('scanGroupSummaryAction', e);
    return {ok: false, error: 'Couldn’t read this scan.'};
  }
}

/** Delete a whole scan drop and everything it produced. Irreversible — the UI confirms first. */
export async function deleteScanGroupAction(input: {company: string | null; source: string; batchId?: string | null}): Promise<{ok: true; deleted: number} | {ok: false; error: string}> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized for this company.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role cannot delete uploads.'};
  const batchId = (input.batchId ?? '').trim();
  const source = (input.source ?? '').trim();
  if (!batchId && !source) return {ok: false, error: 'No scan to delete.'};
  try {
    const deleted = batchId
      ? await deleteBatch(ctx.companyId, batchId)
      : await deleteScanGroup(ctx.companyId, source);
    revalidateTag(glTags.uploads(ctx.companyId), {expire: 0});
    revalidatePath('/uploads');
    revalidatePath('/uploads/forms');
    return {ok: true, deleted};
  } catch (e) {
    console.error('deleteScanGroupAction', e);
    return {ok: false, error: 'Delete didn’t finish. Some files may remain, try again.'};
  }
}

/**
 * Guided "which store?" — assign a store to a form whose store the scan couldn't read.
 * Stamps the store onto the form's pages (so it leaves "needs a store"), then makes each
 * affected batch commit-ready under that store: re-splitting a multi-store batch, or
 * setting the store on a single-form batch. Only ever touches classification + the open
 * batch, never committed inventory.
 */
export async function assignFormStoreAction(input: {company: string | null; uploadIds: string[]; storeCode: string}): Promise<{ok: true} | {ok: false; error: string}> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized for this company.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role cannot change uploads.'};
  const store = (input.storeCode ?? '').trim();
  if (!store) return {ok: false, error: 'Pick a store first.'};
  if (outOfScopeStores(ctx.storeScope, [store]).length) return {ok: false, error: `Store ${store} is outside your access.`};
  const ids = (Array.isArray(input.uploadIds) ? input.uploadIds : []).filter((x) => typeof x === 'string').slice(0, 50);
  if (!ids.length) return {ok: false, error: 'No pages to assign.'};
  try {
    const name = (await listStores(ctx.companyId)).find((s) => s.code === store)?.name ?? null;
    const batches = await setUploadsStore(ctx.companyId, ids, store, name);
    // Make the form commit-ready under the store: a multi-form batch re-splits and each
    // form's batch is pre-filled; a single-form batch gets the store set directly.
    const by = (await auth())?.user?.email ?? null;
    for (const batchId of batches) {
      const forms = await splitBatchIntoForms(ctx.companyId, batchId, by);
      if (forms.length === 1) {
        const f = forms[0];
        await updateBatchInfo(ctx.companyId, batchId, {storeCode: f.storeCode, periodStart: f.periodStart, periodEnd: f.periodEnd});
      }
    }
    revalidateTag(glTags.uploads(ctx.companyId), {expire: 0});
    revalidatePath('/uploads/forms');
    revalidatePath('/uploads');
    await logReadEvent({companyId: ctx.companyId, event: 'assign_store', status: 'ok', storeCode: store, detail: {uploadIds: ids, batches}});
    return {ok: true};
  } catch (e) {
    console.error('assignFormStoreAction', e);
    const reason = e instanceof Error && e.message ? e.message : String(e);
    await logReadEvent({companyId: ctx.companyId, event: 'assign_store', status: 'failed', storeCode: store, error: reason, detail: {uploadIds: ids}});
    // Surface the real reason (the pages are still saved) so a staging failure is
    // diagnosable instead of a dead end; the raw detail is short and operator-facing.
    const detail = e instanceof Error && e.message ? ` (${e.message})` : '';
    return {ok: false, error: `Couldn’t assign the store${detail}. The pages are saved; try again or set it from the form.`};
  }
}

/** Point a form's pages at one BA (beauty advisor), so a scan read many ways regroups under
 *  the chosen person. Stamps the consultant on the pages; the forms board re-reads it. */
export async function assignFormBaAction(input: {company: string | null; uploadIds: string[]; baName: string}): Promise<{ok: true} | {ok: false; error: string}> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized for this company.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role cannot change uploads.'};
  const ba = (input.baName ?? '').trim();
  if (!ba) return {ok: false, error: 'Pick a BA first.'};
  const ids = (Array.isArray(input.uploadIds) ? input.uploadIds : []).filter((x) => typeof x === 'string').slice(0, 50);
  if (!ids.length) return {ok: false, error: 'No pages to assign.'};
  try {
    await setUploadsBa(ctx.companyId, ids, ba);
    revalidateTag(glTags.uploads(ctx.companyId), {expire: 0});
    revalidatePath('/uploads/forms');
    revalidatePath('/uploads');
    await logReadEvent({companyId: ctx.companyId, event: 'assign_ba', status: 'ok', detail: {ba, uploadIds: ids}});
    return {ok: true};
  } catch (e) {
    console.error('assignFormBaAction', e);
    const reason = e instanceof Error && e.message ? e.message : String(e);
    await logReadEvent({companyId: ctx.companyId, event: 'assign_ba', status: 'failed', error: reason, detail: {ba, uploadIds: ids}});
    const detail = e instanceof Error && e.message ? ` (${e.message})` : '';
    return {ok: false, error: `Couldn’t assign the BA${detail}. The pages are saved; try again or set it from the form.`};
  }
}

