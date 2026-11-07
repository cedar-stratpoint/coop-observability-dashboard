import {auth} from '@/auth';
import {getDataContext} from '@/src/active-context';
import {canEditData, outOfScopeStores} from '@/src/company';
import {classifyUpload} from '@/src/goldline-upload';
import {parseGoldlinePos} from '@/src/goldline-csv';
import {readWatsonsWorkbook} from '@/src/goldline-pos-xlsx';
import {applyWatsonsMonth} from '@/src/goldline-watsons-data';
import {runChecks} from '@/src/goldline-checks-data';
import {expireSalesTotals, glTags} from '@/src/goldline-ref-data';
import {revalidateTag} from 'next/cache';
import {PDFDocument} from 'pdf-lib';
import {
  createUpload,
  getBatch,
  getUpload,
  goldlineConfigured,
  setUploadStatus,
  upsertSales,
} from '@/src/goldline-data';
import {extractionConfigured} from '@/src/goldline-extract-run';
import {runInventoryRead, type Emit} from '@/src/goldline-read-pipeline';

// Goldline upload endpoint. Accepts ONE file (multipart/form-data, field `file`)
// scoped to the active company (?company=<slug>):
//   • .csv  → parse → idempotent upsert into sales (needs period_start/_end)
//   • .xlsx → Watsons POS Sales Data: one month, every store. The month comes from the
//             file; stores and Watsons SKUs are added, then the month's sales replaced
//   • .pdf  → store → Claude Vision CLASSIFIES the page (number, kind, orientation,
//             form version, handwritten header) → snaps the store code to the registry,
//             records a page_key + duplicate flag → rotates if upside-down → extracts
//             that page's items → staged in extractions for review (page 6 / blank /
//             non-form → set aside, out of scope)
// Tenant isolation is enforced here (getDataContext + canEditData); the data-blind
// Coop Admin and read-only analysts are refused. File-type gating is the first check.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// PDF path runs two sequential Vision calls (classify 20s + extract 150s = 170s). The
// densest pages (page 4, the accessories list) measured ~85s+ to read and were timing
// out at the old 85s cap, so the extract budget is 150s; 300s maxDuration keeps headroom
// so a slow call throws in-code (catch → failed) rather than a hard platform kill.
export const maxDuration = 300;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

// Progress events for the Uploads screen (the NDJSON stream re-emits them). The stage
// union + Emit live with the shared read pipeline that produces them.
type Outcome = {body: Record<string, unknown>; status: number};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Accept only a full ISO date (YYYY-MM-DD) for the sales period. */
function isoDate(v: FormDataEntryValue | null): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export async function POST(req: Request): Promise<Response> {
  const wantsStream = (req.headers.get('accept') ?? '').includes('application/x-ndjson');
  if (!wantsStream) {
    const out = await safeHandle(req, () => {});
    return json(out.body, out.status);
  }
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // The browser may go away mid-upload (closed tab): enqueue/close then throw.
      // Swallow that — the server-side work still finishes and records its status.
      let open = true;
      const send = (obj: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(`${JSON.stringify(obj)}\n`));
        } catch {
          open = false;
        }
      };
      const out = await safeHandle(req, send);
      send({type: 'result', httpStatus: out.status, ...out.body});
      try {
        controller.close();
      } catch {
        /* already closed by a disconnect */
      }
    },
    cancel() {
      /* client disconnected; handle() keeps running to completion */
    },
  });
  return new Response(stream, {
    headers: {'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no'},
  });
}

/** handle() plus a last-resort net: an unexpected throw AFTER the file is stored marks
 *  that upload failed (instead of leaving it stuck in "processing") and returns a 500. */
async function safeHandle(req: Request, emit: Emit): Promise<Outcome> {
  const track: {uploadId?: string} = {};
  try {
    return await handle(req, emit, track);
  } catch (e) {
    console.error('goldline upload: unexpected failure', msg(e));
    if (track.uploadId) {
      await setUploadStatus(track.uploadId, 'failed', {
        rejectReason: 'Something went wrong while processing this file. Please try again.',
        errorDetail: msg(e),
      }).catch(() => {});
    }
    return {body: {uploadId: track.uploadId, status: 'failed', error: 'Upload failed. Please try again.'}, status: 500};
  }
}

async function handle(req: Request, emit: Emit, track: {uploadId?: string} = {}): Promise<Outcome> {
  const json = (body: Record<string, unknown>, status = 200): Outcome => ({body, status});
  const requested = new URL(req.url).searchParams.get('company');

  // Scope first: null means not signed in, no membership, or a data-blind Coop Admin.
  const ctx = await getDataContext(requested);
  if (!ctx || !ctx.companyId) return json({error: 'Not authorized to upload for this company.'}, 403);
  if (!canEditData(ctx.role)) return json({error: 'Your role cannot upload data.'}, 403);
  if (!goldlineConfigured()) return json({error: 'Uploads are not configured (archive env missing).'}, 503);

  const session = await auth();
  const uploadedBy = session?.user?.email ?? null;
  const companyId = ctx.companyId;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({error: 'Expected multipart/form-data.'}, 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) return json({error: 'No file provided (field "file").'}, 400);

  // Gate: only .csv / .pdf, within the size cap. Rejected files never get stored.
  const cls = classifyUpload(file.name, file.type, file.size);
  if (!cls.ok) return json({error: cls.reason, status: 'rejected'}, 415);

  const bytes = await file.arrayBuffer();

  // Optional batch: one store's form uploaded together. Must be this company's and open.
  const batchRaw = form.get('batch_id');
  const batchId = typeof batchRaw === 'string' && /^[0-9a-f-]{36}$/i.test(batchRaw) ? batchRaw : null;
  if (batchRaw && !batchId) return json({error: 'Invalid upload batch.'}, 400);
  let batchStore: string | null = null; // lets the reader prefer this store's reference page
  // Batches hold one store's inventory form; a CSV never joins one.
  if (batchId && cls.kind === 'inventory_pdf') {
    const batch = await getBatch(companyId, batchId);
    if (!batch) return json({error: 'Upload batch not found.'}, 404);
    if (batch.status !== 'open') return json({error: 'This upload batch is already committed.'}, 409);
    batchStore = batch.store_code ?? null;
    if (batch.store_code && outOfScopeStores(ctx.storeScope, [batch.store_code]).length) {
      return json({error: `Store ${batch.store_code} is outside your access.`}, 403);
    }
  }

  // One page per PDF upload. The uploader splits multi-page PDFs in the browser; any
  // other caller gets a clear refusal instead of pages 2+ being silently skipped.
  if (cls.kind === 'inventory_pdf') {
    let pages = 1;
    try {
      const doc = await PDFDocument.load(bytes, {ignoreEncryption: true, updateMetadata: false});
      if (doc.isEncrypted) {
        return json({error: 'This PDF is password-protected. Save an unlocked copy and upload that.', status: 'rejected'}, 415);
      }
      pages = doc.getPageCount();
    } catch {
      return json({error: 'This PDF couldn’t be opened. It may be damaged, so please re-scan it.', status: 'rejected'}, 415);
    }
    if (pages > 1) {
      return json(
        {error: `This PDF has ${pages} pages. Upload it from the Uploads page, which splits it into pages automatically.`, status: 'rejected'},
        422,
      );
    }
  }

  let uploadId: string;
  let reused = false;
  try {
    const created = await createUpload({
      companyId,
      kind: cls.kind,
      filename: file.name,
      bytes,
      contentType: cls.contentType,
      uploadedBy,
      batchId: cls.kind === 'inventory_pdf' ? batchId : null,
    });
    uploadId = created.id;
    reused = created.reused;
  } catch (e) {
    console.error('goldline upload: store failed', e);
    return json({error: 'Could not store the file. Please try again.'}, 500);
  }
  track.uploadId = uploadId;
  // This page is already in the batch — a retry of one the server had already saved.
  // Don't insert a second row or re-run OCR; return the existing page's current state so
  // the uploader marks it done instead of adding a duplicate.
  if (reused) {
    const existing = await getUpload(companyId, uploadId);
    return json({uploadId, status: existing?.status ?? 'processing', reused: true});
  }
  revalidateTag(glTags.uploads(companyId), {expire: 0}); // a new upload: refresh the cached /uploads list
  // The batch may have been committed while this page was uploading; a page added
  // after that could never be committed, so stop here with a clear reason.
  if (batchId && cls.kind === 'inventory_pdf') {
    const now = await getBatch(companyId, batchId);
    if (!now || now.status !== 'open') {
      const reason = 'This store’s form was committed while this page was uploading. Start a new batch to add it.';
      await setUploadStatus(uploadId, 'failed', {rejectReason: reason}).catch(() => {});
      return json({uploadId, status: 'failed', error: reason}, 409);
    }
  }
  emit({type: 'stage', stage: 'stored'});

  // --- POS sales CSV -------------------------------------------------------
  if (cls.kind === 'pos_csv') {
    const start = isoDate(form.get('period_start'));
    const end = isoDate(form.get('period_end'));
    if (!start || !end) {
      await setUploadStatus(uploadId, 'failed', {rejectReason: 'Missing period_start / period_end (YYYY-MM-DD).'});
      return json({uploadId, status: 'failed', error: 'A POS upload needs period_start and period_end (YYYY-MM-DD).'}, 422);
    }
    emit({type: 'stage', stage: 'parsing'});
    const {rows, errors} = parseGoldlinePos(new TextDecoder().decode(bytes));
    if (!rows.length) {
      await setUploadStatus(uploadId, 'failed', {rejectReason: errors[0] ?? 'No rows parsed.'});
      return json({uploadId, status: 'failed', errors}, 422);
    }
    // Intra-tenant fence: a store_manager may only upload rows for their stores.
    // company_id already matches; the DB can't see store scope, so enforce it here.
    const outCsv = outOfScopeStores(ctx.storeScope, rows.map((r) => r.storeCode));
    if (outCsv.length) {
      const reason = `Upload includes stores outside your access: ${outCsv.slice(0, 10).join(', ')}.`;
      await setUploadStatus(uploadId, 'rejected', {rejectReason: reason});
      return json({uploadId, status: 'rejected', error: reason}, 403);
    }
    try {
      emit({type: 'stage', stage: 'saving'});
      const committed = await upsertSales(companyId, rows, {start, end}, uploadId);
      await setUploadStatus(uploadId, 'committed');
      expireSalesTotals(companyId); // sales totals changed
      await runChecks(companyId).catch((e) => console.error('runChecks after CSV upload', msg(e)));
      return json({uploadId, status: 'committed', rowsCommitted: committed, warnings: errors});
    } catch (e) {
      console.error('goldline upload: sales commit failed', e);
      expireSalesTotals(companyId); // some rows may be in already
      await setUploadStatus(uploadId, 'failed', {rejectReason: 'Could not save sales rows.'});
      return json({uploadId, status: 'failed', error: 'Could not save sales rows. Please try again.'}, 500);
    }
  }

  // --- Watsons POS Sales Data (.xlsx) ------------------------------------------
  if (cls.kind === 'pos_xlsx') {
    emit({type: 'stage', stage: 'parsing'});
    const wb = await readWatsonsWorkbook(bytes);
    // A file we can't date, or whose rows don't add up to its own TOTAL, is refused whole.
    if (!wb.month || !wb.rows.length || wb.checksumOk === false) {
      const reason = wb.errors[0] ?? 'No sales rows were found in this file.';
      await setUploadStatus(uploadId, 'failed', {rejectReason: reason});
      return json({uploadId, status: 'failed', error: reason, errors: wb.errors}, 422);
    }
    // A chain-wide file adds stores and changes SKU links for the whole company, so only
    // a role that sees every store may load it (same rule as SKU linking).
    if (Array.isArray(ctx.storeScope)) {
      const reason = 'Only someone who sees every store can load POS Sales Data for the whole chain.';
      await setUploadStatus(uploadId, 'rejected', {rejectReason: reason});
      return json({uploadId, status: 'rejected', error: reason}, 403);
    }
    try {
      emit({type: 'stage', stage: 'saving'});
      const summary = await applyWatsonsMonth(companyId, wb, uploadId);
      await setUploadStatus(uploadId, 'committed');
      // A new month of POS data can open or clear form vs. sales flags (counted stores only).
      await runChecks(companyId).catch((e) => console.error('runChecks after Watsons upload', msg(e)));
      revalidateTag(glTags.stores(companyId), {expire: 0});
      revalidateTag(glTags.catalog(companyId), {expire: 0});
      expireSalesTotals(companyId); // sales totals changed
      return json({uploadId, status: 'committed', rowsCommitted: summary.salesRows, watsons: summary, warnings: wb.errors});
    } catch (e) {
      console.error('goldline upload: Watsons month failed', msg(e));
      expireSalesTotals(companyId); // some rows may have changed already
      await setUploadStatus(uploadId, 'failed', {rejectReason: 'Could not save this month of sales. Please try again.', errorDetail: msg(e)});
      return json({uploadId, status: 'failed', error: 'Could not save this month of sales. Please try again.'}, 500);
    }
  }

  // --- Inventory PDF -------------------------------------------------------
  // Without a key the file is kept for manual review rather than silently dropped.
  if (!extractionConfigured()) {
    await setUploadStatus(uploadId, 'needs_review', {pageCount: 1});
    return json({
      uploadId,
      status: 'needs_review',
      note: 'Stored. Extraction is not configured (GOLDLINE_ANTHROPIC_API_KEY missing), so review it manually.',
    });
  }

  // Read the page through the shared pipeline (classify → snap → rotate → extract → save),
  // the same one the re-read action uses, so a re-read can never diverge from a fresh read.
  const result = await runInventoryRead({
    companyId,
    uploadId,
    bytes,
    filename: file.name,
    fileSize: file.size,
    storeScope: ctx.storeScope,
    batchStore,
    emit,
  });
  return json(result.body, result.http);
}
