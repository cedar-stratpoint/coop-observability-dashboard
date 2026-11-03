import {handleWake} from '@/src/shopee-sync/api';
import {shopeeSyncApiDeps} from '@/src/shopee-sync/server';

// Called by the AWS Lambda that starts the cloud worker (Bearer SHOPEE_SYNC_WAKE_TOKEN, env only; Vercel holds no AWS keys). Answers
// {wake, jobId?}: wake is true only when a job is queued and no worker was seen in the last 2 minutes. Outside the page auth gate on purpose:
// the handler authorizes itself and answers 401 JSON.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const deps = shopeeSyncApiDeps();
  if (!deps) return new Response(JSON.stringify({error: 'The archive database is not configured on this deployment (mock mode).'}), {status: 503, headers: {'content-type': 'application/json'}});
  return handleWake(req, deps);
}
