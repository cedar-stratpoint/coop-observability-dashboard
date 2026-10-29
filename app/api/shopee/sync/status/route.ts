import {getShopeeSyncStatus} from '@/src/shopee-sync-data';

// The Overview card polls this while a sync is active. A GET route rather than a server action: actions run one at a time and are for changes,
// and a poll must not queue behind a Sync press. The reader authorizes itself (signed in + ALLOWED_EMAILS); the route sits outside the page gate
// like the other API routes, so an expired session gets 401 JSON, not a sign-in redirect.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status: number): Response => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});

export async function GET(): Promise<Response> {
  try {
    const status = await getShopeeSyncStatus();
    return status ? json(status, 200) : json({error: 'Not authorized.'}, 401);
  } catch (e) {
    console.error('shopee sync status failed', e);
    return json({error: 'Could not read the sync status.'}, 500);
  }
}
