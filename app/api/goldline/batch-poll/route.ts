import {goldlineConfigured} from '@/src/goldline-data';
import {extractionConfigured} from '@/src/goldline-extract-run';
import {pollQueuedBatches} from '@/src/goldline-batch-read';
import {pumpSecretOk} from '@/src/goldline-server-upload';

// L7 batch mode — the poll half of the deferred anchored read (plan:
// knowledge/tasks/2026-11-18-l7-batch-mode-scope.md). The goldline-batch-poll pg_cron job POSTs here
// on a short interval; this checks every 'queued_batch' page's Anthropic Message Batch and, when one
// has ended, ingests the result (saves + advances to needs_review) exactly like the sync path, with
// a sync-read fallback for failed/expired/stale batches. No user session: like the pump's read-page,
// a shared secret (GOLDLINE_PUMP_SECRET) guards it. Idempotent, so a duplicate poll is harmless.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A poll retrieves each pending batch and ingests the ended ones (no model inference — results are
// already computed), plus any sync fallback. 300s is ample headroom.
export const maxDuration = 300;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
}

export async function POST(req: Request): Promise<Response> {
  if (!pumpSecretOk(req.headers.get('x-goldline-pump-secret'), process.env.GOLDLINE_PUMP_SECRET)) {
    return json({error: 'Unauthorized.'}, 401);
  }
  if (!goldlineConfigured()) return json({error: 'Goldline is not configured.'}, 503);
  if (!extractionConfigured()) return json({error: 'The reader is not configured.'}, 503);

  const result = await pollQueuedBatches();
  return json(result);
}
