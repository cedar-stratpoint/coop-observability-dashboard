import {createClient} from '@supabase/supabase-js';
import {dbRefOf, resolveEnv} from '@/src/coop-env';

export const dynamic = 'force-dynamic';

// Public health probe for the Manage Environments page (it calls each environment's
// /api/health server-to-server). Returns only: which environment this is (from its
// database), the deployed branch + short commit, a MASKED database ref, and whether the
// database answers. No data, no secrets. The database check is reused for 20s so
// repeated hits can't load the database.

const TTL_MS = 20_000;
let last: {at: number; dbOk: boolean} | null = null;

const mask = (ref: string) => (ref.length > 8 ? `${ref.slice(0, 4)}…${ref.slice(-4)}` : '••••');

async function dbReachable(url: string | undefined, key: string | undefined): Promise<boolean> {
  if (last && Date.now() - last.at < TTL_MS) return last.dbOk;
  let dbOk = false;
  if (url && key) {
    try {
      // pagination-ok: count-only head request, returns no rows.
      const res = await createClient(url, key, {auth: {persistSession: false}}).from('companies').select('id', {count: 'exact', head: true});
      dbOk = !res.error;
    } catch {
      dbOk = false;
    }
  }
  last = {at: Date.now(), dbOk};
  return dbOk;
}

export async function GET(req: Request) {
  const url = process.env.SUPABASE_URL_ARCHIVE;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY_ARCHIVE;
  const ref = dbRefOf(url);
  const dbOk = await dbReachable(url, key);
  return Response.json(
    {
      ok: dbOk,
      env: resolveEnv(url, req.headers.get('x-forwarded-host') ?? req.headers.get('host')).key,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      db: ref ? mask(ref) : null,
      dbOk,
      checkedAt: new Date().toISOString(),
    },
    {headers: {'cache-control': 'no-store'}},
  );
}
