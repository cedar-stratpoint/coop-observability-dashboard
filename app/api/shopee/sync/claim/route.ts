import {handleClaim} from '@/src/shopee-sync/api';
import {shopeeSyncApiDeps} from '@/src/shopee-sync/server';

// Shopee sync worker API (the worker's own bearer token; see src/shopee-sync/api.ts). Outside the page auth gate on purpose: the handler
// authorizes itself, so a worker gets a 401 or 503 JSON, never a sign-in redirect.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const deps = shopeeSyncApiDeps();
  if (!deps) return new Response(JSON.stringify({error: 'The archive database is not configured on this deployment (mock mode).'}), {status: 503, headers: {'content-type': 'application/json'}});
  return handleClaim(req, deps);
}
