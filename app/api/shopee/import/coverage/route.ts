import {handleCoverage} from '@/src/shopee-import/api';
import {shopeeImportDeps} from '@/src/shopee-import/server';

// Shopee export import API (bearer token only; see src/shopee-import/api.ts and docs/shopee-import.md). Outside the page auth gate on purpose:
// the handler authorizes itself, so a script gets a 401 or 503 JSON, never a sign-in redirect.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  const deps = shopeeImportDeps();
  return deps ? handleCoverage(req, deps) : new Response(JSON.stringify({error: 'The archive database is not configured on this deployment (mock mode).'}), {status: 503, headers: {'content-type': 'application/json'}});
}
