import {revalidateTag} from 'next/cache';
import {handleApply} from '@/src/shopee-import/api';
import {shopeeImportDeps} from '@/src/shopee-import/server';

// Shopee export import API (bearer token only; see src/shopee-import/api.ts and docs/shopee-import.md). Outside the page auth gate on purpose:
// the handler authorizes itself, so a script gets a 401 or 503 JSON, never a sign-in redirect.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const deps = shopeeImportDeps();
  if (!deps) return new Response(JSON.stringify({error: 'The archive database is not configured on this deployment (mock mode).'}), {status: 503, headers: {'content-type': 'application/json'}});
  const res = await handleApply(req, deps);
  // The Sales page readers cache under this tag; an applied import should show without waiting out the cache. Never fails the apply.
  try {
    const body = (await res.clone().json()) as {results?: {ok?: boolean}[]};
    if (body.results?.some((r) => r.ok)) revalidateTag('digest-archive', 'max');
  } catch {
    // the apply already happened; the cache just expires on its own
  }
  return res;
}
