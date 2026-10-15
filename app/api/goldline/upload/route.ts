import {auth} from '@/auth';
import {getDataContext} from '@/src/active-context';
import {canEditData, outOfScopeStores} from '@/src/company';
import {classifyUpload} from '@/src/goldline-upload';
import {parseGoldlinePos} from '@/src/goldline-csv';
import {PDFDocument} from 'pdf-lib';
import {
  createUpload,
  getBatch,
  goldlineConfigured,
  saveExtraction,
  setUploadStatus,
  upsertSales,
} from '@/src/goldline-data';
import {detectPage, extractInventoryPage, extractionConfigured, type ExtractedPage} from '@/src/goldline-extract-run';
import {getWriterProfile} from '@/src/goldline-writer-data';
import {humanizeExtractError, INVENTORY_PAGES, MANIFESTS} from '@/src/goldline-extract';

// Goldline upload endpoint. Accepts ONE file (multipart/form-data, field `file`)
// scoped to the active company (?company=<slug>):
//   • .csv  → parse → idempotent upsert into gl_sales (needs period_start/_end)
//   • .pdf  → store → Claude Vision detects the page → extracts that page's items →
//             staged in gl_extractions for review (page 6 / non-form → out of scope)
// Tenant isolation is enforced here (getDataContext + canEditData); the data-blind
// Coop Admin and read-only analysts are refused. File-type gating is the first check.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// PDF path runs two sequential Vision calls (detect 20s + extract 85s = 105s); 160s
// gives headroom so a slow call throws in-code (catch → failed) rather than a hard kill.
export const maxDuration = 160;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

// Progress events for the Uploads screen. Only REAL milestones are sent (stored,
// page found, reading, saving) — the client draws its bar from these, never from a
// fake timer alone. Opt-in: a request with `Accept: application/x-ndjson` gets one
// JSON object per line and a final {type:'result'}; any other caller gets the
// unchanged single JSON response.
export type UploadStage =
  | {type: 'stage'; stage: 'stored'}
  | {type: 'stage'; stage: 'parsing'}
  | {type: 'stage'; stage: 'detecting'}
  | {type: 'stage'; stage: 'reading'; page: number; items: number}
  | {type: 'stage'; stage: 'saving'};
type Emit = (e: UploadStage) => void;
type Outcome = {body: Record<string, unknown>; status: number};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Page-level confidence = mean of the per-row confidences (0 when empty). */
function avgConfidence(page: ExtractedPage): number {
  const cs = page.rows.map((r) => r.confidence).filter((c) => typeof c === 'number');
  if (!cs.length) return 0;
  return cs.reduce((a, b) => a + b, 0) / cs.length;
}

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
  try {
    uploadId = await createUpload({
      companyId,
      kind: cls.kind,
      filename: file.name,
      bytes,
      contentType: cls.contentType,
      uploadedBy,
      batchId: cls.kind === 'inventory_pdf' ? batchId : null,
    });
  } catch (e) {
    console.error('goldline upload: store failed', e);
    return json({error: 'Could not store the file. Please try again.'}, 500);
  }
  track.uploadId = uploadId;
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
      return json({uploadId, status: 'committed', rowsCommitted: committed, warnings: errors});
    } catch (e) {
      console.error('goldline upload: gl_sales commit failed', e);
      await setUploadStatus(uploadId, 'failed', {rejectReason: 'Could not save sales rows.'});
      return json({uploadId, status: 'failed', error: 'Could not save sales rows. Please try again.'}, 500);
    }
  }

  // --- Inventory PDF -------------------------------------------------------
  // Without a key the file is kept for manual review rather than silently dropped.
  if (!extractionConfigured()) {
    await setUploadStatus(uploadId, 'needs_review', {pageCount: 1});
    return json({
      uploadId,
      status: 'needs_review',
      note: 'Stored. Extraction is not configured (ANTHROPIC_API_KEY missing), so review it manually.',
    });
  }

  const pdfBase64 = Buffer.from(bytes).toString('base64');
  try {
    // Auto-detect which page this scan is (from the footer), then extract with that
    // page's manifest. Page 6 is the daily Sales Report (not inventory); 0 = not a
    // recognizable form page. Both are a clean, out-of-scope stop, not a failure.
    emit({type: 'stage', stage: 'detecting'});
    const page = await detectPage(pdfBase64);
    if (page === 0) {
      const reason = 'This doesn’t look like a Nichido inventory form page. Please upload a clear scan of an inventory page (pages 1 to 5).';
      await setUploadStatus(uploadId, 'failed', {rejectReason: reason});
      return json({uploadId, status: 'failed', error: reason}, 422);
    }
    if (!INVENTORY_PAGES.includes(page)) {
      const reason = 'This is page 6, the daily Sales Report, not an inventory page. Only inventory pages (1 to 5) are read here.';
      await setUploadStatus(uploadId, 'rejected', {rejectReason: reason, pageCount: page});
      return json({uploadId, status: 'rejected', error: reason}, 422);
    }

    emit({type: 'stage', stage: 'reading', page, items: MANIFESTS[page]?.length ?? 0});
    // The writer profile: an earlier reviewed copy of this page + notes from past
    // corrections, learned from this database's committed scans (empty on any error).
    const profile = await getWriterProfile(companyId, page, batchStore, ctx.storeScope);
    const extracted = await extractInventoryPage(pdfBase64, page, profile);
    // Same store-scope fence for the scanned form's store.
    const outPdf = outOfScopeStores(ctx.storeScope, [extracted.store_code]);
    if (outPdf.length) {
      const reason = `Scanned form is for store ${extracted.store_code}, outside your access.`;
      await setUploadStatus(uploadId, 'rejected', {rejectReason: reason});
      return json({uploadId, status: 'rejected', error: reason}, 403);
    }
    emit({type: 'stage', stage: 'saving'});
    await saveExtraction({companyId, uploadId, page, extracted, docConfidence: avgConfidence(extracted)});
    await setUploadStatus(uploadId, 'needs_review', {pageCount: page});
    return json({
      uploadId,
      status: 'needs_review',
      page,
      rows: extracted.rows.length,
      docConfidence: avgConfidence(extracted),
      flagged: extracted.rows.filter((r) => (typeof r.confidence === 'number' ? r.confidence : 1) < 0.6).length,
      // The printed header (page 1 only carries it) — lets a batch prefill store/period.
      header: {
        storeCode: extracted.store_code || null,
        storeName: extracted.store_name || null,
        periodStart: extracted.period_start ?? null,
        periodEnd: extracted.period_end ?? null,
        consultant: extracted.consultant ?? null,
      },
    });
  } catch (e) {
    // Log the raw error server-side; show the reviewer a human-readable reason; keep a
    // scrubbed copy in error_detail for diagnosis (never shown prominently in the UI).
    console.error('goldline upload: extraction failed', msg(e));
    const friendly = humanizeExtractError(e);
    await setUploadStatus(uploadId, 'failed', {rejectReason: friendly, errorDetail: msg(e)});
    return json({uploadId, status: 'failed', error: friendly}, 422);
  }
}
