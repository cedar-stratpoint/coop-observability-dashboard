import 'server-only';
import {revalidateTag} from 'next/cache';
import {posClient, usingPosMock} from '../pos-data';
import {supabaseImportStore} from '../shopee-import/store-supabase';
import type {SyncApiDeps} from './api';
import {parseAdmins} from './admins';
import {parseHosts} from './remote';
import type {SyncDeps} from './service';
import {supabaseSyncStore} from './store-supabase';

/** The worker routes' dependencies, or null when the archive database is not configured (mock mode): the routes then answer 503. */
export function shopeeSyncApiDeps(): SyncApiDeps | null {
  return usingPosMock() ? null : {store: supabaseSyncStore(posClient()), now: () => new Date(), admins: parseAdmins(process.env.SHOPEE_SYNC_ADMINS), wakeToken: process.env.SHOPEE_SYNC_WAKE_TOKEN?.trim() || null};
}

/** The server actions' dependencies. The loaded days are the same list the import coverage reads. */
export function shopeeSyncDeps(): SyncDeps | null {
  if (usingPosMock()) return null;
  const sb = posClient();
  return {store: supabaseSyncStore(sb), now: () => new Date(), loadLoadedDays: () => supabaseImportStore(sb).loadLoadedDays(), admins: parseAdmins(process.env.SHOPEE_SYNC_ADMINS), remoteHosts: parseHosts(process.env.SHOPEE_SYNC_REMOTE_HOSTS)};
}

/** The Overview and Sales readers cache under 'digest-archive'; a finished sync should show without waiting out the cache. Never fails the response. */
export function revalidateDigestArchive(): void {
  try {
    revalidateTag('digest-archive', 'max');
  } catch {
    // ignore
  }
}
