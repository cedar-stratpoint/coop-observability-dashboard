import {auth} from '@/auth';
import {revalidateTag} from 'next/cache';
import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {glTags} from '@/src/goldline-ref-data';
import {goldlineConfigured, ingestScanPdf} from '@/src/goldline-data';
import {serverUploadEnabled} from '@/src/goldline-server-upload';

// Server-driven upload, step 2 (plan: knowledge/tasks/2026-11-09-server-driven-upload.md):
// the whole scan PDF is already in the bucket (via /upload/sign). The server splits it into
// one PDF per page and opens a `queued` uploads row per page under one batch; the pg_cron pump
// (P1) reads them. The browser then just polls the scan's progress, so a refresh / navigation /
// slow page can't interrupt anything. Company-scoped + flag-gated.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Splitting + storing N page PDFs runs server-side; 300s covers a 98-page scan with headroom.
export const maxDuration = 300;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
}

export async function POST(req: Request): Promise<Response> {
  if (!goldlineConfigured()) return json({error: 'Goldline is not configured.'}, 503);
  const company = new URL(req.url).searchParams.get('company');
  const ctx = await getDataContext(company);
  if (!ctx || !ctx.companyId) return json({error: 'Not authorized.'}, 401);
  if (!canEditData(ctx.role)) return json({error: 'Your role cannot upload.'}, 403);
  if (!serverUploadEnabled(ctx.companyId)) return json({error: 'Server-driven upload is not enabled for this company.'}, 404);

  const body = (await req.json().catch(() => null)) as {storagePath?: unknown; filename?: unknown; name?: unknown} | null;
  const storagePath = typeof body?.storagePath === 'string' ? body.storagePath : '';
  const filename = typeof body?.filename === 'string' ? body.filename : '';
  // Optional display name the user typed for this drop; trimmed + length-capped so a stray
  // paste can't bloat every page row. Null (no name) falls back to the filename everywhere.
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 120) || null : null;
  if (!storagePath || !filename) return json({error: 'storagePath and filename are required.'}, 400);
  // Tenant isolation: the signed path was minted under this company's prefix, so refuse any
  // path that isn't — a caller can never point ingest at another tenant's stored object.
  if (!storagePath.startsWith(`${ctx.companyId}/`)) return json({error: 'That upload is not yours.'}, 403);

  try {
    const session = await auth();
    const {batchId, pages} = await ingestScanPdf({companyId: ctx.companyId, storagePath, filename, uploadedBy: session?.user?.email ?? null, name});
    revalidateTag(glTags.uploads(ctx.companyId), {expire: 0});
    return json({batchId, pages});
  } catch (e) {
    console.error('ingest', e instanceof Error ? e.message : String(e));
    return json({error: 'Could not ingest the scan. Please try again.'}, 500);
  }
}
