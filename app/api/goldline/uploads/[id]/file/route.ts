import {getDataContext} from '@/src/active-context';
import {signedUploadUrl} from '@/src/goldline-data';

// Serves a stored upload to the review page's <iframe> (the app CSP sets object-src
// 'none', so <object> is out; frame-src is open). We do the company-scoped ownership
// check here (getDataContext → signedUploadUrl re-checks the upload belongs to the
// active company), then REDIRECT to the short-lived signed URL. Supabase Storage
// serves the PDF with Range support, which browsers' in-iframe PDF viewers need —
// buffering the bytes ourselves (200-only, no Range) rendered as a broken box in Chrome.
// The signed URL is short-lived (10 min) and only issued for the caller's own file.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, {params}: {params: Promise<{id: string}>}): Promise<Response> {
  const {id} = await params;
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) return new Response('Not authorized.', {status: 403});

  const url = await signedUploadUrl(ctx.companyId, id);
  if (!url) return new Response('Not found.', {status: 404});

  return Response.redirect(url, 307);
}
