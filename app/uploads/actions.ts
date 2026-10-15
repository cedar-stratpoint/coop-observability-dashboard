'use server';

import {revalidatePath} from 'next/cache';
import {getDataContext} from '@/src/active-context';
import {canEditData, outOfScopeStores} from '@/src/company';
import {auth} from '@/auth';
import {
  BatchConflictError,
  BatchStateError,
  commitBatch,
  commitInventory,
  createBatch,
  deleteImpact,
  deleteUpload,
  getBatch,
  getBatchPages,
  getUpload,
  updateBatchInfo,
  uploadStores,
  type DeleteImpact,
  type ReviewedInventoryRow,
} from '@/src/goldline-data';

// Server action behind the review screen's "Commit" button. Re-derives the tenant
// context server-side (never trusts a company id from the client beyond the switcher
// hint), re-checks write capability + store scope, coerces the submitted rows, then
// writes gl_inventory and closes the upload. All the authorization that the upload
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
    const ok = await deleteUpload(ctx.companyId, input.uploadId);
    if (!ok) return {ok: false, error: 'Upload not found.'};
    revalidatePath('/uploads');
    revalidatePath('/stock');
    revalidatePath('/overview');
    return {ok: true, committed: 0};
  } catch (e) {
    console.error('deleteUploadAction', e);
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
  // another's upload (the gl_inventory insert stamps our company_id but would
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

  const rows = (Array.isArray(input.rows) ? input.rows : [])
    .map(coerceRow)
    .filter((r): r is ReviewedInventoryRow => r !== null)
    .slice(0, MAX_ROWS);
  if (!rows.length) return {ok: false, error: 'No valid rows to commit.'};

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
    const committed = await commitInventory({
      companyId: ctx.companyId,
      uploadId: input.uploadId,
      storeCode: store,
      period: {start: input.periodStart, end: input.periodEnd},
      consultant: input.consultant ?? null,
      rows,
    });
    revalidatePath('/uploads');
    revalidatePath(`/uploads/${input.uploadId}`);
    return {ok: true, committed};
  } catch (e) {
    // Don't leak Postgres/schema detail to the browser; log it server-side.
    console.error('commitReview failed', e);
    return {ok: false, error: 'Could not commit the review. Please try again.'};
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
    pages.push({uploadId: p.uploadId, rows: clean.rows});
  }
  // Every page awaiting review commits together — none left behind in an emptied batch.
  if (awaiting.length !== sent.size || awaiting.some((p) => !sent.has(p.upload.id))) {
    return {ok: false, error: 'The pages in this batch changed. Reload the page to see them all, then commit.'};
  }
  if (!pages.some((p) => p.rows.length)) return {ok: false, error: 'No valid rows to commit.'};

  try {
    const {committed} = await commitBatch({
      companyId: ctx.companyId,
      batchId: input.batchId,
      storeCode: store,
      period: {start: input.periodStart, end: input.periodEnd},
      consultant: input.consultant ?? null,
      pages,
    });
    revalidatePath('/uploads');
    revalidatePath(`/uploads/batch/${input.batchId}`);
    revalidatePath('/stock');
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
