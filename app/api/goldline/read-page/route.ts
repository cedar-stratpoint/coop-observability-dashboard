import {revalidateTag} from 'next/cache';
import {glTags} from '@/src/goldline-ref-data';
import {downloadUpload, getBatch, getUpload, goldlineConfigured, setUploadStatus} from '@/src/goldline-data';
import {extractionConfigured} from '@/src/goldline-extract-run';
import {runInventoryRead} from '@/src/goldline-read-pipeline';
import {pumpSecretOk, serverUploadEnabled} from '@/src/goldline-server-upload';

// Server-driven upload, step 3 (plan: knowledge/tasks/2026-11-09-server-driven-upload.md).
// The pg_cron + pg_net pump CLAIMS a queued page (flips it queued -> processing + stamps
// claimed_at, atomically, so no page is ever dispatched twice) and POSTs {uploadId, company}
// here. This reads that one already-claimed page through the SAME runInventoryRead pipeline a
// fresh upload / a re-read uses, then sets its final status. No user session: the pump is the
// only caller, so a shared secret (GOLDLINE_PUMP_SECRET) guards it. Idempotent: it only reads a
// row still in the claimed 'processing' state, so a duplicate dispatch can't double-count stock.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// One classify (~20s) + one extract (~85-150s) Vision call. 600s gives the densest forms room
// to finish instead of being killed at 300s. Requires the host to be on Vercel Pro + Fluid
// Compute (which allows >300s); paired with the DB reaper/backstop windows widened to match
// (reaper 12m, STALE_READ_MIN 15m) so a legitimately-long read is never re-queued mid-flight.
// See supabase/nichido/server_upload_read_window.sql.
export const maxDuration = 600;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
}

export async function POST(req: Request): Promise<Response> {
  // Secret gate first, before touching any state: the pump is the sole caller.
  if (!pumpSecretOk(req.headers.get('x-goldline-pump-secret'), process.env.GOLDLINE_PUMP_SECRET)) {
    return json({error: 'Unauthorized.'}, 401);
  }
  if (!goldlineConfigured()) return json({error: 'Goldline is not configured.'}, 503);
  if (!extractionConfigured()) return json({error: 'The reader is not configured.'}, 503);

  const body = (await req.json().catch(() => null)) as {uploadId?: unknown; company?: unknown} | null;
  const uploadId = typeof body?.uploadId === 'string' ? body.uploadId : '';
  const companyId = typeof body?.company === 'string' ? body.company : '';
  if (!uploadId || !companyId) return json({error: 'uploadId and company are required.'}, 400);
  // The pump should only ever claim rows for a flagged company, but check anyway so a stray
  // call can't drive a read for a tenant that isn't on the server-driven path.
  if (!serverUploadEnabled(companyId)) return json({error: 'Server-driven upload is not enabled for this company.'}, 404);

  // Idempotency: the pump already claimed this row (queued -> processing). Only read a row
  // still in that claimed state. Anything else (committed, needs_review, rejected, failed, or
  // a queued row this call somehow raced ahead of) is already handled, so return without
  // re-reading — a second dispatch of the same page can never add its stock twice.
  const current = await getUpload(companyId, uploadId);
  if (!current) return json({uploadId, status: 'missing'}, 404);
  if (current.status !== 'processing') return json({uploadId, status: current.status, skipped: true});

  const stored = await downloadUpload(companyId, uploadId);
  if (!stored) {
    await setUploadStatus(uploadId, 'failed', {
      rejectReason: 'Could not load this page’s file to read. Please re-upload the scan.',
    }).catch(() => {});
    revalidateTag(glTags.uploads(companyId), {expire: 0});
    return json({uploadId, status: 'failed', error: 'file missing'}, 404);
  }
  // Prefer the batch's store as the reference page, exactly like the re-read path.
  const batchStore = stored.batchId ? (await getBatch(companyId, stored.batchId))?.store_code ?? null : null;

  const result = await runInventoryRead({
    companyId,
    uploadId,
    bytes: stored.bytes,
    filename: stored.filename,
    fileSize: stored.fileSize,
    // Server-internal read of a row this tenant already owns (ingest validated the path
    // prefix); no per-user store fence applies here.
    storeScope: null,
    batchStore,
    // No emit: this isn't a streamed response, so the heartbeat is a no-op.
  });
  revalidateTag(glTags.uploads(companyId), {expire: 0});
  return json(result.body, result.http);
}
