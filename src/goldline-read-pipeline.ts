import 'server-only';
import {outOfScopeStores} from './company';
import {findDuplicatePageKey, saveClassification, saveExtraction, setUploadStatus} from './goldline-data';
import {classifyPage, extractInventoryPage, type ExtractedPage} from './goldline-extract-run';
import {applyOrientation} from './goldline-orient';
import {knownStoreCodes} from './goldline-store-registry';
import {isInventoryPage, pageKey as buildPageKey, snapStoreCode} from './goldline-segment';
import {getWriterProfile} from './goldline-writer-data';
import {humanizeExtractError, MANIFESTS} from './goldline-extract';
import {uploadSource} from './goldline-upload-groups';
import {logReadEvent, type ReadLogInput} from './goldline-read-log';

// The per-page inventory read, shared by the upload route (a fresh scan) and the
// re-read action (a stored page read again). ONE pipeline so the two can never drift:
// classify → snap the store to the registry → flag duplicates → rotate if upside-down →
// extract against the detected version → save + mark needs_review, with sales/blank/
// non-form pages set aside and any failure surfaced with a human reason. The caller owns
// storing the file and checking the key; this owns everything from the bytes onward.

export type UploadStage =
  | {type: 'stage'; stage: 'stored'}
  | {type: 'stage'; stage: 'parsing'}
  | {type: 'stage'; stage: 'detecting'}
  | {type: 'stage'; stage: 'reading'; page: number; items: number}
  | {type: 'stage'; stage: 'saving'};
export type Emit = (e: UploadStage) => void;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Page-level confidence = mean of the per-row confidences (0 when empty). */
export function avgConfidence(page: ExtractedPage): number {
  const cs = page.rows.map((r) => r.confidence).filter((c) => typeof c === 'number');
  if (!cs.length) return 0;
  return cs.reduce((a, b) => a + b, 0) / cs.length;
}

// The classify (~20s) and read (~60-85s) calls run silently. On a streamed upload a
// proxy's idle-read timeout can cut the NDJSON connection during that silence, before
// the final result line — the client then sees a bare 200 and "couldn't finish reading".
// Re-emit the current stage on a 12s heartbeat so bytes keep flowing and the stream
// stays open until the real result (success or a clean failure) is written. The re-read
// action passes no emit (it doesn't stream), so the heartbeat is a no-op there.
export async function withHeartbeat<T>(emit: Emit | undefined, beat: UploadStage, work: () => Promise<T>): Promise<T> {
  const iv = setInterval(() => emit?.(beat), 12_000);
  try {
    return await work();
  } finally {
    clearInterval(iv);
  }
}

export type ReadResult = {http: number; body: Record<string, unknown>};

/**
 * Read ONE stored inventory page (already saved to the uploads row + bucket). Returns the
 * HTTP status + body the route sends to the uploader; the re-read action reads `body.status`.
 */
export async function runInventoryRead(args: {
  companyId: string;
  uploadId: string;
  bytes: ArrayBuffer | Uint8Array;
  filename: string;
  fileSize: number;
  storeScope: string[] | null | undefined;
  batchStore: string | null;
  emit?: Emit;
}): Promise<ReadResult> {
  const {companyId, uploadId, filename, fileSize, storeScope, batchStore, emit} = args;
  const bytes = args.bytes instanceof Uint8Array ? args.bytes : new Uint8Array(args.bytes);
  const pdfBase64 = Buffer.from(bytes).toString('base64');
  // Accumulates what we learn about this page so the read_logs row is complete no matter
  // which branch (set aside / read / failed) the page takes — including the catch below.
  const rec: ReadLogInput = {companyId, uploadId, filename, fileSize, source: uploadSource(filename)};
  try {
    // Phase 0: classify the page (number, kind, orientation, form version, handwritten
    // header) so a shuffled/rotated/multi-store bundle can be sorted. Then snap the
    // read store code to the known registry, persist the classification + a semantic
    // page_key, and flag any duplicate / re-upload — all before extraction.
    emit?.({type: 'stage', stage: 'detecting'});
    const classifyStart = Date.now();
    const cls = await withHeartbeat(emit, {type: 'stage', stage: 'detecting'}, () => classifyPage(pdfBase64));
    rec.classifyMs = Date.now() - classifyStart;
    const page = cls.page;
    rec.page = page;
    rec.pageKind = cls.kind;
    rec.formVersion = cls.version;
    rec.orientation = cls.orientation;
    rec.storeFrom = cls.store_code;

    // Reconcile the store code against the registry (best-effort: no registry = raw).
    let registry: string[] = [];
    try {
      registry = await knownStoreCodes(companyId);
    } catch (e) {
      console.error('goldline read: store registry read failed', msg(e));
    }
    const snap = snapStoreCode(cls.store_code, registry);
    rec.storeCode = snap.code;
    rec.detail = {classify: cls, snap};
    const inv = isInventoryPage(cls);
    const pk = inv
      ? buildPageKey({store_code: snap.code, period_start: cls.period_start, period_end: cls.period_end, version: cls.version, page})
      : null;

    // Duplicate / re-upload: same semantic page_key seen before. Flag, never drop.
    let duplicateOf: Array<{id: string; status: string; created_at: string}> = [];
    if (pk) {
      try {
        duplicateOf = await findDuplicatePageKey(companyId, pk, uploadId);
      } catch (e) {
        console.error('goldline read: duplicate check failed', msg(e));
      }
    }

    // Persist the classifier output on the upload row (metadata; best-effort).
    await saveClassification({
      uploadId,
      pageNo: page,
      pageKind: cls.kind,
      orientation: cls.orientation,
      formVersion: cls.version,
      pageKey: pk,
      classification: {...cls, store_snap: snap, duplicate_of: duplicateOf.map((d) => d.id)},
    }).catch((e) => console.error('goldline read: saveClassification failed', msg(e)));

    // Page-6 sales report and blanks/unrecognized pages are a clean, out-of-scope stop.
    if (cls.kind === 'sales' || page === 6) {
      const reason = 'This is the page 6 Sales Report, not an inventory page. It has been set aside (out of scope for now).';
      await setUploadStatus(uploadId, 'rejected', {rejectReason: reason, pageCount: page});
      await logReadEvent({...rec, status: 'rejected', stage: 'classified', pageKind: 'sales'});
      return {http: 422, body: {uploadId, status: 'rejected', error: reason, pageKind: cls.kind}};
    }
    if (!inv) {
      // A blank back-side is a normal, expected part of a scan — set it aside quietly,
      // like the sales report, rather than showing it as a failure.
      if (cls.kind === 'blank') {
        const reason = 'This looks like a blank page (a back side with no form). It has been set aside.';
        await setUploadStatus(uploadId, 'rejected', {rejectReason: reason, pageCount: page});
        await logReadEvent({...rec, status: 'rejected', stage: 'classified', pageKind: 'blank'});
        return {http: 422, body: {uploadId, status: 'rejected', error: reason, pageKind: 'blank'}};
      }
      const reason = 'This doesn’t look like a Nichido inventory form page. Please upload a clear scan of an inventory page (pages 1 to 5).';
      await setUploadStatus(uploadId, 'rejected', {rejectReason: reason, pageCount: page});
      await logReadEvent({...rec, status: 'rejected', stage: 'classified'});
      return {http: 422, body: {uploadId, status: 'rejected', error: reason, pageKind: cls.kind}};
    }

    // Upright copy for extraction: rotate 180° pages before reading (no-op if upright).
    const extractB64 = cls.orientation === 180
      ? Buffer.from(await applyOrientation(bytes, 180)).toString('base64')
      : pdfBase64;

    const reading: UploadStage = {type: 'stage', stage: 'reading', page, items: MANIFESTS[page]?.length ?? 0};
    emit?.(reading);
    // The writer profile: an earlier reviewed copy of this page + notes from past
    // corrections, learned from this database's committed scans (empty on any error).
    const profile = await getWriterProfile(companyId, page, batchStore, storeScope);
    // Phase 1: extract against the detected form version (legacy uses the 7-column
    // deducted schema; v1/v2 the three-location one). Unknown falls back to v1. The read
    // is the long, silent call, so keep the stream alive with a heartbeat while it runs.
    const readStart = Date.now();
    const extracted = await withHeartbeat(emit, reading, () => extractInventoryPage(extractB64, page, profile, cls.version));
    rec.readMs = Date.now() - readStart;
    // Same store-scope fence for the scanned form's store.
    const outPdf = outOfScopeStores(storeScope, [extracted.store_code]);
    if (outPdf.length) {
      const reason = `Scanned form is for store ${extracted.store_code}, outside your access.`;
      await setUploadStatus(uploadId, 'rejected', {rejectReason: reason});
      await logReadEvent({...rec, status: 'rejected', stage: 'read', storeCode: extracted.store_code, rowCount: extracted.rows.length});
      return {http: 403, body: {uploadId, status: 'rejected', error: reason}};
    }
    emit?.({type: 'stage', stage: 'saving'});
    await saveExtraction({companyId, uploadId, page, extracted, docConfidence: avgConfidence(extracted)});
    await setUploadStatus(uploadId, 'needs_review', {pageCount: page});
    await logReadEvent({
      ...rec,
      status: 'needs_review',
      stage: 'read',
      rowCount: extracted.rows.length,
      docConfidence: avgConfidence(extracted),
      flagged: extracted.rows.filter((r) => (typeof r.confidence === 'number' ? r.confidence : 1) < 0.6).length,
      offManifest: extracted.rows.filter((r) => r.off_manifest).length,
    });
    return {
      http: 200,
      body: {
        uploadId,
        status: 'needs_review',
        page,
        rows: extracted.rows.length,
        docConfidence: avgConfidence(extracted),
        flagged: extracted.rows.filter((r) => (typeof r.confidence === 'number' ? r.confidence : 1) < 0.6).length,
        // Phase 0 classification: the form version detected, whether the page was rotated
        // upright, the store-code snap, and any duplicate / re-upload of this same page.
        formVersion: cls.version,
        rotated: cls.orientation === 180,
        store: {code: snap.code, status: snap.status, from: snap.from ?? null, candidates: snap.candidates ?? null},
        duplicateOf: duplicateOf.map((d) => ({uploadId: d.id, status: d.status, at: d.created_at})),
        // The handwritten header (now read on every page) — lets a batch prefill store/period.
        header: {
          storeCode: extracted.store_code || snap.code || null,
          storeName: extracted.store_name || null,
          periodStart: extracted.period_start ?? cls.period_start ?? null,
          periodEnd: extracted.period_end ?? cls.period_end ?? null,
          consultant: extracted.consultant ?? cls.consultant ?? null,
        },
      },
    };
  } catch (e) {
    // Log the raw error server-side; show the reviewer a human-readable reason; keep a
    // scrubbed copy in error_detail for diagnosis (never shown prominently in the UI).
    console.error('goldline read: extraction failed', msg(e));
    const friendly = humanizeExtractError(e);
    await setUploadStatus(uploadId, 'failed', {rejectReason: friendly, errorDetail: msg(e)});
    await logReadEvent({...rec, status: 'failed', stage: rec.readMs != null ? 'read' : 'classified', error: msg(e), detail: {...(rec.detail as object | null), error: msg(e)}});
    return {http: 422, body: {uploadId, status: 'failed', error: friendly}};
  }
}
