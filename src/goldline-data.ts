import 'server-only';
import {unstable_cache} from 'next/cache';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import type {PosSaleRow} from './goldline-csv';
import type {ExtractedPage} from './goldline-extract-run';
import {applyStoreRegistry, assignBlankFormRuns, reconcileYears, segmentBundle} from './goldline-segment';
import {consultantOf, toClassifiedPage, UPLOAD_CLS_COLS, type UploadClsRow} from './goldline-triage-data';
import {knownStoreCodes} from './goldline-store-registry';
import {uploadSource} from './goldline-upload-groups';
import {getGlCatalog, getGlStores, glTags} from './goldline-ref-data';

// Server-only writes/reads for the Goldline tables, in Goldline's own Nichido
// project (src/nichido-client.ts): service-role key, never exposed to the browser.
// Every row is stamped with company_id; callers pass the ACTIVE company from the
// scoping layer (src/active-context.ts) so one tenant can never write another's data.

export const GOLDLINE_BUCKET = 'goldline-uploads';

/** False when the Nichido env is absent — callers should refuse writes, not no-op silently. */
export function goldlineConfigured(): boolean {
  return nichidoConfigured();
}

const db = nichidoDb;

/**
 * Reduce an uploaded file name to a single safe Storage path segment: basename
 * only (drop any directory parts), `..` collapsed, and anything outside
 * [A-Za-z0-9._-] (including control chars and separators) replaced with `_`.
 * Defense-in-depth so a crafted `file.name` can never climb out of the
 * `${companyId}/` prefix or break the `company_id/rest` split of storage_path.
 */
export function safeObjectName(filename: string): string {
  const base = (filename || '').split(/[/\\]/).pop() ?? '';
  const cleaned = base
    .replace(/\.{2,}/g, '.') // collapse .. so no path traversal survives
    .replace(/[^A-Za-z0-9._-]/g, '_') // control chars, spaces, separators → _
    .replace(/^\.+/, ''); // no leading dots (hidden / relative)
  return cleaned.slice(0, 180) || 'upload';
}

export type UploadKind = 'pos_csv' | 'pos_xlsx' | 'inventory_pdf';

const SALES_CHUNK = 2000;
export type UploadStatus = 'processing' | 'needs_review' | 'committed' | 'failed' | 'rejected';
export type Period = {start: string; end: string}; // ISO dates

export type UploadRow = {
  id: string;
  company_id: string;
  kind: UploadKind;
  filename: string;
  status: UploadStatus;
  page_count: number | null;
  reject_reason: string | null;
  uploaded_by: string | null;
  created_at: string;
  storage_path: string | null;
  batch_id?: string | null; // set when uploaded as part of a store's form (multi-file upload)
  form_version?: string | null; // detected inventory-form layout (legacy/v1/v2), when classified
  page_kind?: string | null; // inventory | sales | blank | unknown, once classified
};

/**
 * Store the raw file, then open an uploads row. Returns the row id and whether an
 * existing row was reused.
 *
 * Idempotent within a batch: the uploader splits a scan into per-page files named
 * "(page N of M)", and a retry re-POSTs the identical file. When a page's first request
 * times out at the edge the server often still finishes and inserts the row, so the
 * naive insert produced a *second* row on retry (the 98-page scan that became 109 rows).
 * So when this upload belongs to a batch, reuse any existing non-failed row with the same
 * (company, batch, filename) instead of inserting again — and short-circuit before the
 * storage write so a reused page leaves no orphan object. A *failed* first attempt is
 * excluded, so a genuine retry-after-failure still creates the authoritative row.
 */
export async function createUpload(input: {
  companyId: string;
  kind: UploadKind;
  filename: string;
  bytes: ArrayBuffer;
  contentType: string;
  uploadedBy: string | null;
  batchId?: string | null;
}): Promise<{id: string; reused: boolean}> {
  const supa = db();
  if (input.batchId) {
    const existing = await supa
      .from('uploads')
      .select('id')
      .eq('company_id', input.companyId)
      .eq('batch_id', input.batchId)
      .eq('filename', input.filename)
      .neq('status', 'failed')
      .order('created_at', {ascending: true})
      .limit(1)
      .maybeSingle();
    if (existing.error) throw new Error(`uploads dedup check failed: ${existing.error.message}`);
    if (existing.data) return {id: (existing.data as {id: string}).id, reused: true};
  }
  // Original name kept for display in the row; the storage KEY uses the sanitized
  // basename so a crafted filename can't escape the company prefix.
  const path = `${input.companyId}/${Date.now()}-${safeObjectName(input.filename)}`;
  const up = await supa.storage
    .from(GOLDLINE_BUCKET)
    .upload(path, input.bytes, {contentType: input.contentType, upsert: false});
  if (up.error) throw new Error(`storage upload failed: ${up.error.message}`);

  const ins = await supa
    .from('uploads')
    .insert({
      company_id: input.companyId,
      kind: input.kind,
      filename: input.filename,
      storage_path: path,
      status: 'processing' satisfies UploadStatus,
      uploaded_by: input.uploadedBy,
      batch_id: input.batchId ?? null,
    })
    .select('id')
    .single();
  if (ins.error) throw new Error(`uploads insert failed: ${ins.error.message}`);
  return {id: (ins.data as {id: string}).id, reused: false};
}

export async function setUploadStatus(
  id: string,
  status: UploadStatus,
  extra?: {rejectReason?: string; pageCount?: number; errorDetail?: string | null},
): Promise<void> {
  const supa = db();
  const patch: Record<string, unknown> = {status};
  if (extra?.rejectReason !== undefined) patch.reject_reason = extra.rejectReason;
  if (extra?.pageCount !== undefined) patch.page_count = extra.pageCount;
  // Scrubbed technical detail for diagnosis (never shown prominently in the UI).
  if (extra?.errorDetail !== undefined) patch.error_detail = extra.errorDetail?.slice(0, 500) ?? null;
  const res = await supa.from('uploads').update(patch).eq('id', id);
  if (res.error) throw new Error(`uploads update failed: ${res.error.message}`);
}

/**
 * Phase 0 — persist a page's classifier output on its upload row (additive columns),
 * plus the semantic `page_key` used for duplicate / re-upload detection. Best-effort:
 * callers should not fail the upload if this write errors (classification is metadata,
 * not the extracted counts).
 */
/**
 * Stamp a confirmed store onto a form's pages — the guided "which store?" step for a
 * form the OCR couldn't read. Merges the store into each page's classification JSONB
 * (store_code + store_snap {code, status:'confirmed'}, keeping everything else) so the
 * forms view regroups it under the real store and it leaves "needs a store". Does not
 * touch committed inventory. Returns the distinct batch ids the pages belong to, so the
 * caller can make those batches commit-ready under the store.
 */
export async function setUploadsStore(companyId: string, uploadIds: string[], storeCode: string, storeName: string | null): Promise<string[]> {
  const ids = uploadIds.filter((x) => typeof x === 'string').slice(0, 50);
  if (!ids.length) return [];
  const supa = db();
  // Paginated so the read is never silently capped at PostgREST's db.max_rows (1000);
  // stable .order('id') keeps pages from overlapping or skipping.
  const rows = (await fetchAllRows('uploads', (from, to) =>
    supa.from('uploads').select('id,batch_id,classification').eq('company_id', companyId).in('id', ids).order('id').range(from, to),
  )) as Array<{id: string; batch_id: string | null; classification: Record<string, unknown> | null}>;
  const batches = new Set<string>();
  for (const row of rows) {
    if (row.batch_id) batches.add(row.batch_id);
    const c = {...(row.classification ?? {})};
    c.store_code = storeCode;
    if (storeName) c.store_name = storeName;
    c.store_snap = {code: storeCode, status: 'confirmed'};
    const up = await supa.from('uploads').update({classification: c}).eq('company_id', companyId).eq('id', row.id);
    if (up.error) throw new Error(`uploads store update failed: ${up.error.message}`);
  }
  return [...batches];
}

/** Stamp a BA (consultant) onto the given pages' classification, so a scan's forms regroup
 *  under the chosen person. Mirrors setUploadsStore: paginated read, writes the name plus a
 *  confirmed `ba_snap` marker. BA doesn't drive batch splitting, so no re-split is needed. */
export async function setUploadsBa(companyId: string, uploadIds: string[], baName: string): Promise<void> {
  const ids = uploadIds.filter((x) => typeof x === 'string').slice(0, 50);
  if (!ids.length) return;
  const name = baName.trim();
  if (!name) return;
  const supa = db();
  const rows = (await fetchAllRows('uploads', (from, to) =>
    supa.from('uploads').select('id,classification').eq('company_id', companyId).in('id', ids).order('id').range(from, to),
  )) as Array<{id: string; classification: Record<string, unknown> | null}>;
  for (const row of rows) {
    const c = {...(row.classification ?? {})};
    c.consultant = name;
    c.ba_snap = {name, status: 'confirmed'};
    const up = await supa.from('uploads').update({classification: c}).eq('company_id', companyId).eq('id', row.id);
    if (up.error) throw new Error(`uploads BA update failed: ${up.error.message}`);
  }
}

export async function saveClassification(input: {
  uploadId: string;
  pageNo: number;
  pageKind: string;
  orientation: 0 | 180;
  formVersion: string;
  pageKey: string | null;
  classification: unknown;
}): Promise<void> {
  const supa = db();
  const res = await supa
    .from('uploads')
    .update({
      page_no: input.pageNo,
      page_kind: input.pageKind,
      orientation: input.orientation,
      form_version: input.formVersion,
      page_key: input.pageKey,
      classification: input.classification,
      classified_at: new Date().toISOString(),
    })
    .eq('id', input.uploadId);
  if (res.error) throw new Error(`uploads classification update failed: ${res.error.message}`);
}

/**
 * Phase 0 — prior uploads for this company sharing the same semantic `page_key`
 * (a duplicate within the bundle or a re-upload of a page seen before). Newest first,
 * excluding the current upload. The caller FLAGS these; it never auto-drops.
 */
export async function findDuplicatePageKey(
  companyId: string,
  pageKey: string,
  excludeUploadId: string,
): Promise<Array<{id: string; status: string; created_at: string}>> {
  if (!pageKey) return [];
  const supa = db();
  const res = await supa
    .from('uploads')
    .select('id,status,created_at')
    .eq('company_id', companyId)
    .eq('page_key', pageKey)
    .neq('id', excludeUploadId)
    .order('created_at', {ascending: false})
    .limit(10);
  if (res.error) throw new Error(`uploads duplicate check failed: ${res.error.message}`);
  return (res.data ?? []) as Array<{id: string; status: string; created_at: string}>;
}

/** What deleting an upload will take with it — shown in the confirmation before the
 *  user commits to it. `inventoryRows` are the inventory counts this scan is still
 *  the source of (a later scan that overwrote a count owns it instead). */
export type DeleteImpact = {
  inventoryRows: number;
  salesRows: number;
  snapshots: Array<{store_code: string; store_name: string | null; period_start: string; period_end: string}>;
};

/** Every store an upload touches: the stores of the counts / sales rows it is the
 *  source of, plus the store read off a scan that isn't committed yet. Used to keep a
 *  store-scoped role inside its stores when deleting. */
export async function uploadStores(companyId: string, id: string): Promise<string[]> {
  if (!goldlineConfigured()) return [];
  const supa = db();
  // Paged: a sales export can hold far more than PostgREST's 1000-row cap. Only
  // called for store-scoped roles, so the full read is rare.
  const page = (table: 'inventory' | 'sales') =>
    fetchAllRows(table, (from, to) =>
      supa.from(table).select('store_code').eq('company_id', companyId).eq('source_upload_id', id).order('id').range(from, to),
    ) as unknown as Promise<Array<{store_code: string}>>;
  const [inv, sales, ext] = await Promise.all([page('inventory'), page('sales'), getExtraction(companyId, id)]);
  const codes = new Set<string>();
  for (const r of [...inv, ...sales]) if (r.store_code) codes.add(r.store_code);
  const header = ext?.data?.store_code?.trim();
  if (header) codes.add(header);
  return [...codes];
}

export async function deleteImpact(companyId: string, id: string): Promise<DeleteImpact | null> {
  if (!goldlineConfigured()) return null;
  const supa = db();
  const upload = await getUpload(companyId, id);
  if (!upload) return null;
  const [inv, sales] = await Promise.all([
    // pagination-ok: count-only head request, returns no rows.
    supa.from('inventory').select('id', {count: 'exact', head: true}).eq('company_id', companyId).eq('source_upload_id', id),
    // pagination-ok: count-only head request, returns no rows.
    supa.from('sales').select('id', {count: 'exact', head: true}).eq('company_id', companyId).eq('source_upload_id', id),
  ]);
  // Fail loud: an unknown impact must never be shown as "nothing changes".
  if (inv.error) throw new Error(`inventory count failed: ${inv.error.message}`);
  if (sales.error) throw new Error(`sales count failed: ${sales.error.message}`);
  let snapshots: DeleteImpact['snapshots'] = [];
  if ((inv.count ?? 0) > 0) {
    // pagination-ok: a scan feeds one store/period; limit guards the odd re-commit.
    const one = await supa
      .from('inventory')
      .select('store_code,period_start,period_end')
      .eq('company_id', companyId)
      .eq('source_upload_id', id)
      .limit(50);
    const seen = new Set<string>();
    const distinct = ((one.data ?? []) as Array<{store_code: string; period_start: string; period_end: string}>).filter((s) => {
      const k = `${s.store_code}|${s.period_start}|${s.period_end}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // pagination-ok: names for the handful of stores above.
    const names = await supa
      .from('stores')
      .select('store_code,name')
      .eq('company_id', companyId)
      .in('store_code', [...new Set(distinct.map((s) => s.store_code))]);
    const nameOf = new Map(((names.data ?? []) as Array<{store_code: string; name: string}>).map((n) => [n.store_code, n.name]));
    snapshots = distinct.map((s) => ({...s, store_name: nameOf.get(s.store_code) ?? null}));
  }
  return {inventoryRows: inv.count ?? 0, salesRows: sales.count ?? 0, snapshots};
}

/** Delete an upload, scoped to a company: the stored file, its staged extraction,
 *  the inventory counts / sales rows it is still the source of, then the row itself.
 *  Removing the committed data too keeps Inventory and Overview from showing numbers
 *  whose source scan no longer exists. */
export async function deleteUpload(companyId: string, id: string): Promise<boolean> {
  if (!goldlineConfigured()) return false;
  const supa = db();
  const upload = await getUpload(companyId, id); // company-scoped ownership check
  if (!upload) return false;
  // Committed data first (fail loud: we must not drop the upload but keep its data).
  const inv = await supa.from('inventory').delete().eq('company_id', companyId).eq('source_upload_id', id);
  if (inv.error) throw new Error(`inventory delete failed: ${inv.error.message}`);
  const sales = await supa.from('sales').delete().eq('company_id', companyId).eq('source_upload_id', id);
  if (sales.error) throw new Error(`sales delete failed: ${sales.error.message}`);
  const ext = await supa.from('extractions').delete().eq('company_id', companyId).eq('upload_id', id);
  if (ext.error) throw new Error(`extractions delete failed: ${ext.error.message}`);
  // The stored file is best-effort (an orphaned object is harmless and private);
  // the row goes last so a failure above leaves a visible, retryable upload.
  if (upload.storage_path) {
    const rm = await supa.storage.from(GOLDLINE_BUCKET).remove([upload.storage_path]);
    if (rm.error) console.error('deleteUpload: storage remove failed', rm.error.message);
  }
  const res = await supa.from('uploads').delete().eq('company_id', companyId).eq('id', id);
  if (res.error) throw new Error(`uploads delete failed: ${res.error.message}`);
  return true;
}

export type ScanGroupSummary = {files: number; committed: number; needsReview: number; issues: number; stores: string[]; bas: string[]};

/** What deleting a whole scan drop will take with it — shown in the confirmation before
 *  the user commits to it. A scan = every upload whose filename shares this source. */
export async function scanGroupSummary(companyId: string, source: string): Promise<ScanGroupSummary> {
  if (!goldlineConfigured()) return {files: 0, committed: 0, needsReview: 0, issues: 0, stores: [], bas: []};
  const rows = (await fetchAllRows('uploads', (from, to) =>
    db().from('uploads').select('id,filename,status,classification').eq('company_id', companyId).order('created_at', {ascending: false}).range(from, to),
  )) as unknown as Array<{id: string; filename: string; status: string; classification: Record<string, unknown> | null}>;
  const scoped = rows.filter((r) => uploadSource(r.filename) === source);
  const stores = new Set<string>();
  const bas = new Set<string>();
  let committed = 0;
  let needsReview = 0;
  let issues = 0;
  for (const r of scoped) {
    if (r.status === 'committed') committed++;
    else if (r.status === 'needs_review') needsReview++;
    else if (r.status === 'failed' || r.status === 'rejected') issues++;
    const c = (r.classification ?? {}) as Record<string, unknown>;
    const snap = (c.store_snap ?? {}) as Record<string, unknown>;
    const store = (typeof snap.code === 'string' ? snap.code : typeof c.store_code === 'string' ? c.store_code : null) || null;
    if (store) stores.add(store);
    if (typeof c.consultant === 'string' && c.consultant.trim()) bas.add(c.consultant.trim());
  }
  return {files: scoped.length, committed, needsReview, issues, stores: [...stores].sort(), bas: [...bas].sort()};
}

/** Delete a whole scan drop: every upload whose filename shares this source, with its
 *  committed counts, sales, extractions and stored files. Chunked so a 100-page drop
 *  deletes in a few bulk statements. Returns how many uploads were removed. */
export async function deleteScanGroup(companyId: string, source: string): Promise<number> {
  if (!goldlineConfigured()) return 0;
  const supa = db();
  const rows = (await fetchAllRows('uploads', (from, to) =>
    supa.from('uploads').select('id,filename,storage_path').eq('company_id', companyId).order('created_at', {ascending: false}).range(from, to),
  )) as unknown as Array<{id: string; filename: string; storage_path: string | null}>;
  const scoped = rows.filter((r) => uploadSource(r.filename) === source);
  if (!scoped.length) return 0;
  const pathById = new Map(scoped.map((r) => [r.id, r.storage_path]));
  for (let i = 0; i < scoped.length; i += 100) {
    const ids = scoped.slice(i, i + 100).map((r) => r.id);
    // Committed data first (fail loud), then extractions, then stored files, then rows.
    const inv = await supa.from('inventory').delete().eq('company_id', companyId).in('source_upload_id', ids);
    if (inv.error) throw new Error(`inventory delete failed: ${inv.error.message}`);
    const sales = await supa.from('sales').delete().eq('company_id', companyId).in('source_upload_id', ids);
    if (sales.error) throw new Error(`sales delete failed: ${sales.error.message}`);
    const ext = await supa.from('extractions').delete().eq('company_id', companyId).in('upload_id', ids);
    if (ext.error) throw new Error(`extractions delete failed: ${ext.error.message}`);
    const paths = ids.map((id) => pathById.get(id)).filter((p): p is string => typeof p === 'string');
    if (paths.length) {
      const rm = await supa.storage.from(GOLDLINE_BUCKET).remove(paths);
      if (rm.error) console.error('deleteScanGroup: storage remove failed', rm.error.message);
    }
    const del = await supa.from('uploads').delete().eq('company_id', companyId).in('id', ids);
    if (del.error) throw new Error(`uploads delete failed: ${del.error.message}`);
  }
  return scoped.length;
}

/** Idempotent upsert of POS sale rows for one company + period (keyed on the natural key).
 *  Goes through the upsert_sales RPC, which encrypts the peso figures and units into
 *  sales.amounts_enc with the Vault key (supabase/nichido/s1_sales_encryption.sql,
 *  s3_sales_units_encryption.sql); none of the three reach the table in plain. */
export async function upsertSales(
  companyId: string,
  rows: PosSaleRow[],
  period: Period,
  uploadId: string,
): Promise<number> {
  if (!rows.length) return 0;
  const supa = db();
  const payload = rows.map((r) => ({
    store_code: r.storeCode,
    sku_code: r.skuCode,
    period_start: period.start,
    period_end: period.end,
    gross_retail: r.grossRetail,
    units: r.units,
    net_of_vat: r.netOfVat,
    source_upload_id: uploadId,
  }));
  // A Watsons month is ~40k rows: send it in chunks so no single request is huge.
  for (let i = 0; i < payload.length; i += SALES_CHUNK) {
    const res = await supa.rpc('upsert_sales', {p_company: companyId, p_rows: payload.slice(i, i + SALES_CHUNK)});
    if (res.error) throw new Error(`sales upsert failed: ${res.error.message}`);
  }
  return payload.length;
}

/** Stage one extracted page for review (extractions). Idempotent on (upload, page).
 *  The full page (header + rows) is stored in the `rows` jsonb so the review screen
 *  and commit have the store code + period, not just the counts. */
export async function saveExtraction(input: {
  companyId: string;
  uploadId: string;
  page: number;
  extracted: ExtractedPage;
  docConfidence: number;
}): Promise<void> {
  const supa = db();
  const res = await supa.from('extractions').upsert(
    {
      company_id: input.companyId,
      upload_id: input.uploadId,
      page: input.page,
      rows: input.extracted,
      doc_confidence: input.docConfidence,
      status: 'pending_review',
    },
    {onConflict: 'upload_id,page'},
  );
  if (res.error) throw new Error(`extractions upsert failed: ${res.error.message}`);
}

/** One upload, scoped to a company (null if not found / not this company's). */
export async function getUpload(companyId: string, id: string): Promise<UploadRow | null> {
  if (!goldlineConfigured()) return null;
  const supa = db();
  const res = await supa
    .from('uploads')
    .select('id,company_id,kind,filename,status,page_count,reject_reason,uploaded_by,created_at,storage_path,batch_id')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle();
  if (res.error) throw new Error(`uploads read failed: ${res.error.message}`);
  return (res.data as UploadRow | null) ?? null;
}

/**
 * A short-lived signed URL to view the stored file for an upload, scoped to the
 * company (so one tenant can't fetch another's scan by guessing an id). The bucket
 * is private, so a signed URL is the only way the browser can load it. Returns null
 * if the upload isn't this company's, has no stored file, or signing fails.
 */
export async function signedUploadUrl(companyId: string, uploadId: string, expiresInSec = 600): Promise<string | null> {
  if (!goldlineConfigured()) return null;
  const upload = await getUpload(companyId, uploadId); // company-scoped ownership check
  if (!upload?.storage_path) return null;
  const supa = db();
  const res = await supa.storage.from(GOLDLINE_BUCKET).createSignedUrl(upload.storage_path, expiresInSec);
  if (res.error) {
    console.error('signedUploadUrl failed', res.error.message);
    return null;
  }
  return res.data?.signedUrl ?? null;
}

export type ExtractionRecord = {
  page: number;
  status: string;
  docConfidence: number | null;
  /** The full extracted page (header + rows) as staged. */
  data: ExtractedPage;
};

/** The staged extraction for an upload — one page per PDF (the auto-detected page). */
export async function getExtraction(companyId: string, uploadId: string): Promise<ExtractionRecord | null> {
  if (!goldlineConfigured()) return null;
  const supa = db();
  const res = await supa
    .from('extractions')
    .select('page,status,doc_confidence,rows')
    .eq('company_id', companyId)
    .eq('upload_id', uploadId)
    .order('page', {ascending: true})
    .limit(1)
    .maybeSingle();
  if (res.error) throw new Error(`extractions read failed: ${res.error.message}`);
  if (!res.data) return null;
  const row = res.data as {page: number; status: string; doc_confidence: number | null; rows: ExtractedPage};
  return {page: row.page, status: row.status, docConfidence: row.doc_confidence, data: row.rows};
}

/** One reviewed inventory line (the five counts), confirmed by a human. */
export type ReviewedInventoryRow = {
  item_code: string;
  stockroom: number | null;
  drawer: number | null;
  selling_area: number | null;
  delivery: number | null;
  ending_on_hand: number | null;
  // Phase 1 · Legacy-only sidecar (beginning / begin_plus_delivery / deducted_pcs),
  // carried verbatim into inventory.extra. Absent/null for v1/v2 rows.
  extra?: Record<string, number | null> | null;
};

/**
 * Commit a reviewed extraction into inventory and close out the upload.
 * Idempotent on the inventory natural key (re-committing a period overwrites it).
 * All three writes are company-scoped so a reviewer can only ever touch their own
 * tenant's rows. total_value is left null (derived downstream as ending × price).
 */
export async function commitInventory(input: {
  companyId: string;
  uploadId: string;
  storeCode: string;
  period: Period;
  consultant?: string | null;
  rows: ReviewedInventoryRow[];
}): Promise<number> {
  const supa = db();
  const payload = input.rows.map((r) => ({
    company_id: input.companyId,
    store_code: input.storeCode,
    item_code: r.item_code,
    period_start: input.period.start,
    period_end: input.period.end,
    consultant: input.consultant ?? null,
    stockroom: r.stockroom,
    drawer: r.drawer,
    selling_area: r.selling_area,
    delivery: r.delivery,
    ending_on_hand: r.ending_on_hand,
    source_upload_id: input.uploadId,
  }));
  if (payload.length) {
    const ins = await supa
      .from('inventory')
      .upsert(payload, {onConflict: 'company_id,store_code,item_code,period_start,period_end'});
    if (ins.error) throw new Error(`inventory upsert failed: ${ins.error.message}`);
  }
  const ext = await supa
    .from('extractions')
    .update({status: 'confirmed'})
    .eq('company_id', input.companyId)
    .eq('upload_id', input.uploadId);
  if (ext.error) throw new Error(`extractions update failed: ${ext.error.message}`);
  const up = await supa
    .from('uploads')
    .update({status: 'committed'})
    .eq('company_id', input.companyId)
    .eq('id', input.uploadId);
  if (up.error) throw new Error(`uploads update failed: ${up.error.message}`);
  return payload.length;
}

/** List a company's uploads, newest first (paginated — never silently capped). Cached
 *  across requests (the /uploads home re-reads the whole table on every load); the
 *  upload / commit / reject writes expire gl-uploads so a change shows on the next load. */
export function listUploads(companyId: string): Promise<UploadRow[]> {
  if (!goldlineConfigured()) return Promise.resolve([]);
  const supa = db();
  return unstable_cache(
    async () =>
      (await fetchAllRows('uploads', (from, to) =>
        supa
          .from('uploads')
          .select('id,company_id,kind,filename,status,page_count,reject_reason,uploaded_by,created_at,storage_path,form_version,page_kind')
          .eq('company_id', companyId)
          .order('created_at', {ascending: false})
          .order('id', {ascending: true})
          .range(from, to),
      )) as unknown as UploadRow[],
    ['gl-uploads', companyId],
    {tags: [glTags.uploads(companyId)], revalidate: 30},
  )();
}

/** Catalog line + printed price for the given item codes (the review page's family
 *  grouping and totals check). Served from the cached full catalog (gl-catalog) so the
 *  review page no longer queries products on every load. Company-scoped. */
export async function catalogForCodes(
  companyId: string,
  codes: string[],
): Promise<Record<string, {productLine: string | null; unitPrice: number | null}>> {
  if (!goldlineConfigured() || !codes.length) return {};
  const want = new Set(codes);
  const out: Record<string, {productLine: string | null; unitPrice: number | null}> = {};
  for (const p of await getGlCatalog(companyId)) {
    if (!want.has(p.item_code)) continue;
    out[p.item_code] = {productLine: p.product_line, unitPrice: p.unit_price == null ? null : Number(p.unit_price)};
  }
  return out;
}

export type FormPageCell = {page: number; uploadId: string | null; status: UploadStatus | null; flagged: number; current: boolean};
export type FormPageStrip = {
  /** count = the scans committed into the same store + period; batch = the scans
   *  uploaded together as one store's form (its upload batch); recent = legacy uploads
   *  with no batch: the same person's scans around the same time. */
  scope: 'count' | 'batch' | 'recent';
  batchId: string | null;
  cells: FormPageCell[];
};

const BATCH_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * The review page's "form pages 1–5" strip, limited to the SAME form so a link never
 * opens another store's page:
 *  • committed scan → the scans committed into the same store + period count;
 *  • pending scan in an upload batch → exactly the scans of that batch (pages that
 *    weren't uploaded show as empty — never someone's other uploads from that day);
 *  • pending scan with no batch (older uploads) → the uploader's scans within ±12 h.
 * For each page: this scan if it's that page, else the newest sibling of that page.
 * Company-scoped; every read is bounded.
 */
export async function formPageStrip(companyId: string, currentUploadId: string, flagBelow = 0.6): Promise<FormPageStrip | null> {
  if (!goldlineConfigured()) return null;
  const supa = db();
  const upload = await getUpload(companyId, currentUploadId);
  if (!upload) return null;

  let scope: FormPageStrip['scope'] = 'recent';
  let ids: string[] = [];
  if (upload.status === 'committed') {
    // pagination-ok: single row — where this scan landed.
    const at = await supa
      .from('inventory')
      .select('store_code,period_start,period_end')
      .eq('company_id', companyId)
      .eq('source_upload_id', currentUploadId)
      .limit(1)
      .maybeSingle();
    if (at.data) {
      scope = 'count';
      const snap = at.data as {store_code: string; period_start: string; period_end: string};
      const src = (await fetchAllRows('inventory', (from, to) =>
        supa
          .from('inventory')
          .select('source_upload_id')
          .eq('company_id', companyId)
          .eq('store_code', snap.store_code)
          .eq('period_start', snap.period_start)
          .eq('period_end', snap.period_end)
          .order('id')
          .range(from, to),
      )) as unknown as Array<{source_upload_id: string | null}>;
      ids = [...new Set(src.map((r) => r.source_upload_id).filter((x): x is string => Boolean(x)))];
    }
  }
  if (scope !== 'count' && upload.batch_id) {
    scope = 'batch';
    // pagination-ok: one upload batch (≤ 20 files).
    const inBatch = await supa
      .from('uploads')
      .select('id')
      .eq('company_id', companyId)
      .eq('batch_id', upload.batch_id)
      .eq('kind', 'inventory_pdf')
      .in('status', ['needs_review', 'committed'])
      .limit(50);
    if (inBatch.error) throw new Error(`uploads read failed: ${inBatch.error.message}`);
    ids = ((inBatch.data ?? []) as Array<{id: string}>).map((u) => u.id);
  }
  if (scope === 'recent') {
    const t = Date.parse(upload.created_at);
    let q = supa
      .from('uploads')
      .select('id')
      .eq('company_id', companyId)
      .eq('kind', 'inventory_pdf')
      .in('status', ['needs_review', 'committed'])
      .gte('created_at', new Date(t - BATCH_WINDOW_MS).toISOString())
      .lte('created_at', new Date(t + BATCH_WINDOW_MS).toISOString())
      .order('created_at', {ascending: false})
      .limit(50); // pagination-ok: one sitting's scans
    q = upload.uploaded_by ? q.eq('uploaded_by', upload.uploaded_by) : q.is('uploaded_by', null);
    const near = await q;
    if (near.error) throw new Error(`uploads read failed: ${near.error.message}`);
    ids = ((near.data ?? []) as Array<{id: string}>).map((u) => u.id);
  }
  if (!ids.includes(currentUploadId)) ids.push(currentUploadId);

  const [ext, ups] = await Promise.all([
    // pagination-ok: one extraction per scan in this form (bounded by ids).
    supa.from('extractions').select('upload_id,page,rows,created_at').eq('company_id', companyId).in('upload_id', ids.slice(0, 60)),
    // pagination-ok: same bound.
    supa.from('uploads').select('id,status,created_at').eq('company_id', companyId).in('id', ids.slice(0, 60)),
  ]);
  if (ext.error) throw new Error(`extractions read failed: ${ext.error.message}`);
  if (ups.error) throw new Error(`uploads read failed: ${ups.error.message}`);
  const meta = new Map(((ups.data ?? []) as Array<{id: string; status: UploadStatus; created_at: string}>).map((u) => [u.id, u]));
  const list = ((ext.data ?? []) as Array<{upload_id: string; page: number; rows: {rows?: Array<{confidence?: unknown}>} | null}>)
    .filter((e) => meta.has(e.upload_id))
    .sort((a, b) => (meta.get(b.upload_id)?.created_at ?? '').localeCompare(meta.get(a.upload_id)?.created_at ?? ''));
  const flaggedOf = (e: (typeof list)[number]) =>
    (e.rows?.rows ?? []).filter((r) => {
      const c = typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? r.confidence : 1;
      return c < flagBelow;
    }).length;

  const current = list.find((e) => e.upload_id === currentUploadId);
  const cells = [1, 2, 3, 4, 5].map((page) => {
    const pick = current && current.page === page ? current : list.find((e) => e.page === page && e.upload_id !== currentUploadId);
    return {
      page,
      uploadId: pick?.upload_id ?? null,
      status: pick ? (meta.get(pick.upload_id)?.status ?? null) : null,
      flagged: pick ? flaggedOf(pick) : 0,
      current: Boolean(current && current.page === page),
    };
  });
  return {scope, batchId: upload.batch_id ?? null, cells};
}


// ── Upload batches (one store's form for one period, uploaded together) ─────────

export type BatchRow = {
  id: string;
  company_id: string;
  store_code: string | null;
  period_start: string | null;
  period_end: string | null;
  status: 'open' | 'committed';
  created_by: string | null;
  created_at: string;
  committed_at: string | null;
};

const BATCH_COLS = 'id,company_id,store_code,period_start,period_end,status,created_by,created_at,committed_at';

export async function createBatch(companyId: string, createdBy: string | null): Promise<string> {
  const res = await db().from('upload_batches').insert({company_id: companyId, created_by: createdBy}).select('id').single();
  if (res.error) throw new Error(`upload_batches insert failed: ${res.error.message}`);
  return (res.data as {id: string}).id;
}

/** A batch, scoped to the company (null when it isn't theirs or doesn't exist). */
export async function getBatch(companyId: string, id: string): Promise<BatchRow | null> {
  if (!goldlineConfigured()) return null;
  // pagination-ok: single row by primary key.
  const res = await db().from('upload_batches').select(BATCH_COLS).eq('company_id', companyId).eq('id', id).maybeSingle();
  if (res.error) throw new Error(`upload_batches read failed: ${res.error.message}`);
  return (res.data as BatchRow | null) ?? null;
}

export async function updateBatchInfo(
  companyId: string,
  id: string,
  info: {storeCode: string | null; periodStart: string | null; periodEnd: string | null},
): Promise<void> {
  const res = await db()
    .from('upload_batches')
    .update({store_code: info.storeCode, period_start: info.periodStart, period_end: info.periodEnd})
    .eq('company_id', companyId)
    .eq('id', id)
    .eq('status', 'open');
  if (res.error) throw new Error(`upload_batches update failed: ${res.error.message}`);
}

/** One form found in a scan, after splitting (see splitBatchIntoForms). */
export type SplitForm = {
  batchId: string;
  pages: number[]; // page numbers read, in scan order (null = not numbered)
  files: number;
  storeCode: string | null; // from page 1's header, when written
  periodStart: string | null;
  periodEnd: string | null;
  consultant: string | null;
};

/**
 * Many stores in one scan (Q25): after every page of a drop is read, split the batch
 * into one batch per FORM. Grouping uses the Phase 0 classification (store · period ·
 * version, with the store code snapped to the registry and the year reconciled) via
 * the same `segmentBundle` the triage board uses — so a shuffled multi-store scan is
 * separated correctly, where the old page-number heuristic lumped it into one pile.
 * The first form keeps this batch; each other form gets a new open batch. Each form's
 * batch is pre-filled with its detected store and period so review opens ready. Pages
 * with no form (sales / blank / unplaceable) stay in the original batch. Returns every
 * form; one (or none) means nothing moved.
 */
export async function splitBatchIntoForms(companyId: string, batchId: string, createdBy: string | null): Promise<SplitForm[]> {
  const batch = await getBatch(companyId, batchId);
  if (!batch || batch.status !== 'open') return [];
  const supa = db();
  const uploads = (await fetchAllRows('uploads', (from, to) =>
    supa.from('uploads').select(UPLOAD_CLS_COLS).eq('company_id', companyId).eq('batch_id', batchId).eq('kind', 'inventory_pdf').order('created_at').order('id').range(from, to),
  )) as unknown as UploadClsRow[];
  if (!uploads.length) return [];

  const byId = new Map(uploads.map((u) => [u.id, u]));
  // Re-snap store codes against the current registry before grouping, so drift the
  // classifier left raw ("DS 5300", "5360", a misread "472") collapses into the real
  // store's form instead of each variant spinning off its own. snapStoreCode trusts a
  // code that is itself a registered store, so genuinely different stores stay apart.
  // Then cut store-less pages into per-scan runs (uploads already read oldest-first) so a
  // blank-store form stays one physical form instead of merging several unreadable stores.
  const known = await knownStoreCodes(companyId);
  const {forms} = segmentBundle(reconcileYears(assignBlankFormRuns(applyStoreRegistry(uploads.map(toClassifiedPage), known))));
  if (forms.length === 0) return []; // no inventory pages to group (all parked)
  const split = forms.length > 1; // a genuine multi-store / multi-period scan

  const out: SplitForm[] = [];
  for (let f = 0; f < forms.length; f++) {
    const g = forms[f];
    const ids = g.slots.flatMap((s) => s.ids);
    let id = batchId;
    if (f > 0) {
      id = await createBatch(companyId, createdBy);
      const moved = await supa.from('uploads').update({batch_id: id}).eq('company_id', companyId).eq('batch_id', batchId).in('id', ids);
      if (moved.error) throw new Error(`move pages failed: ${moved.error.message}`);
    }
    // When a scan really held several forms, pre-fill each one's batch with its grouped
    // store + period (the reviewer can still edit; an unmatched store stays blank for
    // them to pick). A single-form batch is left as the uploader set it.
    if (split) {
      await updateBatchInfo(companyId, id, {storeCode: g.store_code ?? null, periodStart: g.period_start ?? null, periodEnd: g.period_end ?? null});
    }
    out.push({
      batchId: id,
      pages: g.present,
      files: ids.length,
      storeCode: g.store_code,
      periodStart: g.period_start,
      periodEnd: g.period_end,
      consultant: consultantOf(byId.get(ids[0]) ?? uploads[0]),
    });
  }
  return out;
}

export type BatchPage = {
  upload: UploadRow;
  extraction: ExtractionRecord | null;
  /** Phase 0 detected/snapped store for this page, for the store-change guard. */
  detectedStore: string | null;
};

/** The batch's uploads with their staged readings, oldest first. Company-scoped. */
export async function getBatchPages(companyId: string, batchId: string): Promise<BatchPage[]> {
  if (!goldlineConfigured()) return [];
  const supa = db();
  const ups = await supa
    .from('uploads')
    .select('id,company_id,kind,filename,status,page_count,reject_reason,uploaded_by,created_at,storage_path,classification')
    .eq('company_id', companyId)
    .eq('batch_id', batchId)
    .order('created_at', {ascending: true})
    .limit(50); // pagination-ok: a batch is capped at 20 files (UI) — 50 is a hard ceiling
  if (ups.error) throw new Error(`uploads read failed: ${ups.error.message}`);
  const rawUploads = (ups.data ?? []) as Array<UploadRow & {classification?: Record<string, unknown> | null}>;
  if (!rawUploads.length) return [];
  // Phase 0 store the page's detected/snapped store in classification; carry it so the
  // review can flag a batch whose pages read different stores (store-change guard).
  const detectedStore = new Map<string, string | null>();
  for (const u of rawUploads) {
    const c = u.classification ?? {};
    const snap = (c.store_snap ?? {}) as Record<string, unknown>;
    const code = (typeof snap.code === 'string' ? snap.code : typeof c.store_code === 'string' ? c.store_code : null) || null;
    detectedStore.set(u.id, code);
  }
  const uploads = rawUploads.map(({classification: _c, ...u}) => u) as UploadRow[];
  const ext = await supa
    .from('extractions')
    .select('upload_id,page,status,doc_confidence,rows')
    .eq('company_id', companyId)
    .in('upload_id', uploads.map((u) => u.id)); // pagination-ok: ≤ 50 ids, one row each
  if (ext.error) throw new Error(`extractions read failed: ${ext.error.message}`);
  const byUpload = new Map(
    ((ext.data ?? []) as Array<{upload_id: string; page: number; status: string; doc_confidence: number | null; rows: ExtractedPage}>).map((e) => [
      e.upload_id,
      {page: e.page, status: e.status, docConfidence: e.doc_confidence, data: e.rows} as ExtractionRecord,
    ]),
  );
  return uploads.map((upload) => ({upload, extraction: byUpload.get(upload.id) ?? null, detectedStore: detectedStore.get(upload.id) ?? null}));
}

/**
 * Commit every page of a batch into inventory in ONE upsert (all-or-nothing for the
 * counts), then close the pages and the batch. Refuses when two pages carry the same
 * item code — e.g. page 3 scanned twice — since one upsert can't write a key twice and
 * the counts would be ambiguous anyway.
 */
export async function commitBatch(input: {
  companyId: string;
  batchId: string;
  storeCode: string;
  period: Period;
  consultant: string | null;
  pages: Array<{uploadId: string; rows: ReviewedInventoryRow[]}>;
}): Promise<{committed: number}> {
  // One code per count. Checked here for a friendly message; commit_batch re-checks
  // inside its transaction (it also locks the batch and requires exactly the batch's
  // pages awaiting review, so a concurrent or partial commit is refused, not half-applied).
  const seen = new Set<string>();
  for (const p of input.pages) {
    for (const r of p.rows) {
      if (seen.has(r.item_code)) throw new BatchConflictError(r.item_code);
      seen.add(r.item_code);
    }
  }
  const {data, error} = await db().rpc('commit_batch', {
    p_company: input.companyId,
    p_batch: input.batchId,
    p_store: input.storeCode,
    p_start: input.period.start,
    p_end: input.period.end,
    p_consultant: input.consultant,
    p_pages: input.pages.map((p) => ({
      upload_id: p.uploadId,
      rows: p.rows.map((r) => ({
        item_code: r.item_code,
        stockroom: r.stockroom,
        drawer: r.drawer,
        selling_area: r.selling_area,
        delivery: r.delivery,
        ending_on_hand: r.ending_on_hand,
        // Legacy sidecar (null for v1/v2); commit_batch writes it to inventory.extra.
        extra: r.extra ?? null,
      })),
    })),
  });
  if (error) {
    const msg = error.message ?? '';
    const dup = /duplicate_item:(.+)$/.exec(msg);
    if (dup) throw new BatchConflictError(dup[1].trim());
    if (msg.includes('batch_not_open')) throw new BatchStateError('closed');
    if (msg.includes('pages_mismatch')) throw new BatchStateError('pages');
    throw new Error(`commit_batch failed: ${msg}`);
  }
  return {committed: typeof data === 'number' ? data : 0};
}

/** The batch changed under the reviewer: already committed, or its page set moved. */
export class BatchStateError extends Error {
  constructor(public reason: 'closed' | 'pages') {
    super(`batch state: ${reason}`);
  }
}

export class BatchConflictError extends Error {
  constructor(public itemCode: string) {
    super(`item ${itemCode} appears more than once`);
  }
}

export type StoreOption = {code: string; name: string};

/** The company's stores (for the store-code pickers), by code. Served from the cached
 *  store list (gl-stores) so the pickers don't re-read the stores table every load.
 *  Company-scoped. */
export async function listStores(companyId: string): Promise<StoreOption[]> {
  if (!goldlineConfigured()) return [];
  const rows = await getGlStores(companyId);
  return rows
    .filter((r) => r.status !== 'closed')
    .map((r) => ({code: r.store_code, name: r.name}))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, {numeric: true}));
}
