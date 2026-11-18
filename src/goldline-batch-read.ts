import 'server-only';
import {revalidateTag} from 'next/cache';
import {
  downloadUpload,
  getBatch,
  listQueuedBatchUploads,
  saveExtraction,
  setUploadStatus,
  type QueuedBatchUpload,
} from './goldline-data';
import {fetchAnchoredBatch} from './goldline-extract-run';
import {getFormTemplate} from './goldline-form-template-data';
import {mapAnchoredToExtractedPage} from './goldline-anchored-extract';
import {avgConfidence, runInventoryRead} from './goldline-read-pipeline';
import {logReadEvent} from './goldline-read-log';
import {uploadSource} from './goldline-upload-groups';
import {glTags} from './goldline-ref-data';

// L7 batch mode — the ingest half of the deferred anchored read (plan:
// knowledge/tasks/2026-11-18-l7-batch-mode-scope.md). The pump's read-page ran classify + locate
// inline and submitted each page's anchored read to the Anthropic Message Batches API, leaving the
// page 'queued_batch'. This poller (driven by the goldline-batch-poll cron -> /api/goldline/batch-poll)
// checks those batches and, when one has ended, maps the numbers-only output back through the same
// template and saves + advances the page exactly like the synchronous path. A slot that errored or
// expired, or a batch stuck past the SLA, falls back to a normal synchronous read so no page strands.

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type BatchPollResult = {
  scanned: number;
  ingested: number;
  pending: number;
  fellBack: number;
  failed: number;
};

/** True when a batch was submitted longer than `staleHours` ago — past the Batches API 24h SLA, so
 *  waiting further is pointless and we read the page synchronously instead. */
function isStale(submittedAt: string | null, staleHours: number): boolean {
  if (!submittedAt) return false;
  const t = Date.parse(submittedAt);
  return Number.isFinite(t) && Date.now() - t > staleHours * 3_600_000;
}

/** Re-read ONE page synchronously (classify + locate + anchored, forceSync so it is not re-batched)
 *  and save it, the fallback when a batch slot failed/expired. Best-effort: a failure here flips the
 *  page to 'failed' via runInventoryRead's own catch, so it never stays stuck in 'queued_batch'. */
async function fallbackSync(p: QueuedBatchUpload): Promise<'done' | 'missing'> {
  const stored = await downloadUpload(p.companyId, p.uploadId);
  if (!stored) {
    await setUploadStatus(p.uploadId, 'failed', {
      rejectReason: 'Could not load this page’s file to read. Please re-upload the scan.',
      anthropicBatchId: null,
    }).catch(() => {});
    return 'missing';
  }
  const batchStore = stored.batchId ? (await getBatch(p.companyId, stored.batchId))?.store_code ?? null : null;
  await runInventoryRead({
    companyId: p.companyId,
    uploadId: p.uploadId,
    bytes: stored.bytes,
    filename: stored.filename,
    fileSize: stored.fileSize,
    storeScope: null,
    batchStore,
    forceSync: true,
  });
  return 'done';
}

/**
 * One poll cycle: ingest every 'queued_batch' page whose batch has ended, fall back to a sync read
 * for failed/expired slots and stale batches, and leave still-processing ones for the next cycle.
 * Bounded by `limit`. Idempotent: re-ingesting an already-saved page is a harmless upsert.
 */
export async function pollQueuedBatches(opts?: {limit?: number; staleHours?: number}): Promise<BatchPollResult> {
  const staleHours = opts?.staleHours ?? 25;
  const pages = await listQueuedBatchUploads(opts?.limit ?? 200);
  const out: BatchPollResult = {scanned: pages.length, ingested: 0, pending: 0, fellBack: 0, failed: 0};
  // One retrieve per distinct batch id (our submission is one page per batch, but de-dupe anyway).
  const batchCache = new Map<string, Awaited<ReturnType<typeof fetchAnchoredBatch>>>();

  for (const p of pages) {
    try {
      let batch = batchCache.get(p.anthropicBatchId);
      if (!batch) {
        batch = await fetchAnchoredBatch(p.anthropicBatchId);
        batchCache.set(p.anthropicBatchId, batch);
      }
      if (batch.status !== 'ended') {
        if (isStale(p.submittedAt, staleHours)) {
          await fallbackSync(p);
          out.fellBack++;
        } else {
          out.pending++;
        }
        continue;
      }
      const r = batch.results.find((x) => x.custom_id === p.uploadId) ?? batch.results[0];
      if (!r || r.error || !r.output || p.version == null || p.page == null) {
        await fallbackSync(p);
        out.fellBack++;
        continue;
      }
      const template = await getFormTemplate(p.companyId, p.version, p.page);
      if (!template) {
        await fallbackSync(p);
        out.fellBack++;
        continue;
      }
      const mapped = mapAnchoredToExtractedPage(template, r.output);
      const extracted = mapped.page;
      const docConfidence = avgConfidence(extracted);
      await saveExtraction({companyId: p.companyId, uploadId: p.uploadId, page: p.page, extracted, docConfidence});
      await setUploadStatus(p.uploadId, 'needs_review', {pageCount: p.page, anthropicBatchId: null});
      await logReadEvent({
        companyId: p.companyId,
        uploadId: p.uploadId,
        filename: p.filename,
        source: uploadSource(p.filename),
        stage: 'read',
        status: 'needs_review',
        rowCount: extracted.rows.length,
        docConfidence,
        detail: {
          batch: true,
          anchored: {
            version: p.version,
            filledBlanks: mapped.filledBlanks,
            extras: mapped.extras,
            priceNotes: mapped.priceNotes,
            versionMismatch: mapped.versionMismatch,
          },
        },
        // The anchored read's Claude usage, now billed at the 50% batch rate — recorded so a run's
        // cost is still summable from the DB (classify + locate were logged at submit time).
        usage: {input: r.usage?.input ?? 0, output: r.usage?.output ?? 0, cacheRead: 0, cacheCreate: 0, calls: 1},
      }).catch((e) => console.error('goldline batch-poll: logReadEvent failed', msg(e)));
      out.ingested++;
    } catch (e) {
      console.error('goldline batch-poll: page failed, falling back to sync', p.uploadId, msg(e));
      try {
        await fallbackSync(p);
        out.fellBack++;
      } catch (e2) {
        console.error('goldline batch-poll: fallback sync also failed', p.uploadId, msg(e2));
        out.failed++;
      }
    }
  }

  if (out.ingested > 0 || out.fellBack > 0) {
    // Refresh the uploads/triage views for every company we touched so the pages leave "Processing".
    for (const company of new Set(pages.map((p) => p.companyId))) {
      revalidateTag(glTags.uploads(company), {expire: 0});
    }
  }
  return out;
}
