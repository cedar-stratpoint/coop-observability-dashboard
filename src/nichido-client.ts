import 'server-only';
import {createClient, type SupabaseClient} from '@supabase/supabase-js';
import {nichidoPairOk} from './coop-env';

// The one Supabase client for Goldline's tables (stores, products, sales, inventory, …;
// the archive's old copy calls them gl_*) and the goldline-uploads bucket.
// Goldline data lives in its own Nichido project (NICHIDO_URL), not the shared Coop
// archive; sign-in, memberships and the company registry stay in the archive
// (src/company.ts). Service-role key, server-only, never exposed to the browser.
//
// No fallback to the archive: with the Nichido env unset, or pointing at another
// environment's project than the archive (see nichidoPairOk), Goldline reads return
// empty and writes refuse, so its data can never be split across two databases.

const url = process.env.NICHIDO_URL;
const key = process.env.NICHIDO_SERVICE_ROLE_KEY;
const paired = nichidoPairOk(process.env.SUPABASE_URL_ARCHIVE, url);
if (url && key && !paired) {
  console.error('[nichido] NICHIDO_URL is not the Nichido project for this environment; Goldline data is disabled.');
}

/** True when Goldline's database is set up for this environment. */
export function nichidoConfigured(): boolean {
  return Boolean(url && key && paired);
}

let client: SupabaseClient | null = null;
export function nichidoDb(): SupabaseClient {
  if (!nichidoConfigured()) throw new Error('Goldline storage is not configured (NICHIDO_URL).');
  client ??= createClient(url as string, key as string, {auth: {persistSession: false}});
  return client;
}
