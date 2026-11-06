import 'server-only';
import {nichidoConfigured, nichidoDb} from './nichido-client';

// Observability for the scan-read pipeline (o1_read_logs). One row per page the uploader
// reads, and per store-assign attempt — the inputs, the classifier/extract summary,
// timings, and the final outcome (incl. the real error on a failure). Durable so a failed
// or mis-read page can be debugged after the fact and the reader hardened. Written
// best-effort: a logging failure must NEVER break an upload, so every path swallows.

export type ReadLogEvent = 'page_read' | 'assign_store' | 'assign_ba';

export type ReadLogInput = {
  companyId: string;
  event?: ReadLogEvent;
  uploadId?: string | null;
  batchId?: string | null;
  source?: string | null;
  filename?: string | null;
  page?: number | null;
  fileSize?: number | null;
  stage?: string | null;
  status?: string | null;
  pageKind?: string | null;
  formVersion?: string | null;
  orientation?: number | null;
  storeCode?: string | null;
  storeFrom?: string | null;
  rowCount?: number | null;
  docConfidence?: number | null;
  flagged?: number | null;
  offManifest?: number | null;
  classifyMs?: number | null;
  readMs?: number | null;
  error?: string | null;
  detail?: unknown;
};

/** Write one read-pipeline log row. Best-effort — never throws; returns quietly if the
 *  Nichido env isn't configured (mock mode) or the insert errors. */
export async function logReadEvent(input: ReadLogInput): Promise<void> {
  if (!nichidoConfigured()) return;
  try {
    await nichidoDb()
      .from('read_logs')
      .insert({
        company_id: input.companyId,
        event: input.event ?? 'page_read',
        upload_id: input.uploadId ?? null,
        batch_id: input.batchId ?? null,
        source: input.source ?? null,
        filename: input.filename ?? null,
        page: input.page ?? null,
        file_size: input.fileSize ?? null,
        stage: input.stage ?? null,
        status: input.status ?? null,
        page_kind: input.pageKind ?? null,
        form_version: input.formVersion ?? null,
        orientation: input.orientation ?? null,
        store_code: input.storeCode ?? null,
        store_from: input.storeFrom ?? null,
        row_count: input.rowCount ?? null,
        doc_confidence: input.docConfidence ?? null,
        flagged: input.flagged ?? null,
        off_manifest: input.offManifest ?? null,
        classify_ms: input.classifyMs ?? null,
        read_ms: input.readMs ?? null,
        error: input.error ?? null,
        detail: (input.detail ?? null) as never,
      });
  } catch {
    /* logging is best-effort — swallow so an upload is never blocked by its own log */
  }
}
