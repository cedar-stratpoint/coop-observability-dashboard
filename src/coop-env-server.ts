import 'server-only';
import {headers} from 'next/headers';
import {guardEnvKey, resolveEnv, type CoopEnv, type CoopEnvKey} from './coop-env';

/** The environment this deployment is, from the database it's connected to (falls back
 *  to the request host only if the database is neither known one). For labels. */
export async function currentEnv(): Promise<CoopEnv> {
  const h = await headers();
  return resolveEnv(process.env.SUPABASE_URL_ARCHIVE, h.get('x-forwarded-host') ?? h.get('host'));
}

/** For safety checks: 'staging' only when connected to the Staging database; anything
 *  else counts as production, so risky changes still need confirming. No request needed. */
export function guardEnv(): CoopEnvKey {
  return guardEnvKey(process.env.SUPABASE_URL_ARCHIVE);
}
