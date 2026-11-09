import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {createScanUploadUrl, goldlineConfigured} from '@/src/goldline-data';
import {serverUploadEnabled} from '@/src/goldline-server-upload';

// Server-driven upload, step 1 (plan: knowledge/tasks/2026-11-09-server-driven-upload.md):
// hand the browser a one-time signed URL to PUT the WHOLE scan PDF straight to the private
// bucket, bypassing the Next.js request-body limit. Company-scoped + flag-gated (per-company
// pilot); CSV / single-file uploads never come here. The browser then calls /ingest with the
// returned path. Behind the flag this route is simply not reachable for a company.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

  const body = (await req.json().catch(() => null)) as {filename?: unknown} | null;
  const filename = typeof body?.filename === 'string' ? body.filename : '';
  if (!filename || !/\.pdf$/i.test(filename)) return json({error: 'A PDF filename is required.'}, 400);

  const signed = await createScanUploadUrl(ctx.companyId, filename);
  if (!signed) return json({error: 'Could not create an upload URL. Please try again.'}, 500);
  return json(signed); // { path, token, signedUrl }
}
