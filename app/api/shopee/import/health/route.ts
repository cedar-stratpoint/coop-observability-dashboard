import {auth} from '@/auth';
import {devAuthEnabled, DEV_SESSION} from '@/src/dev-auth';
import {posClient, usingPosMock} from '@/src/pos-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/shopee/import/health: for a signed-in person, what this deployment sees for the Shopee import (booleans and counts, never
// values) so a 503 from the import API has a visible reason. Reads only; writes nothing. Like /api/chat/health.
export async function GET() {
  const session = devAuthEnabled() ? DEV_SESSION : await auth();
  if (!session?.user) return new Response('Please sign in.', {status: 401});

  const archiveConfigured = !usingPosMock();
  let db: {ok: true; acceptedImports: number; days: number} | {ok: false; reason: string} | null = null;
  if (archiveConfigured) {
    try {
      const sb = posClient();
      const [runs, days] = await Promise.all([
        sb.from('import_runs').select('import_id', {count: 'exact', head: true}).eq('status', 'accepted'),
        sb.from('marketplace_daily_sales').select('day', {count: 'exact', head: true}),
      ]);
      const err = runs.error ?? days.error;
      db = err ? {ok: false, reason: err.message} : {ok: true, acceptedImports: runs.count ?? 0, days: days.count ?? 0};
    } catch (e) {
      db = {ok: false, reason: e instanceof Error ? e.message : String(e)};
    }
  }
  return Response.json({tokenSet: Boolean(process.env.SHOPEE_IMPORT_TOKEN), archiveConfigured, db}, {headers: {'cache-control': 'no-store'}});
}
