import 'server-only';
import {revalidateTag} from 'next/cache';
import {posClient, usingPosMock} from '../pos-data';
import type {ApiDeps} from './api';
import {supabaseSyncStore} from '../shopee-sync/store-supabase';
import {workerAuthFor} from '../shopee-sync/worker-auth';
import {supabaseImportStore} from './store-supabase';

/** The API's dependencies, or null when the archive database is not configured (mock mode): the routes then answer 503. */
export function shopeeImportDeps(): ApiDeps | null {
  if (usingPosMock()) return null;
  return {store: supabaseImportStore(posClient()), token: process.env.SHOPEE_IMPORT_TOKEN, now: () => new Date(), workerAuth: workerAuthFor(supabaseSyncStore(posClient()), process.env.SHOPEE_SYNC_WORKER_TOKEN?.trim())};
}

/**
 * The Sales page readers cache under the 'digest-archive' tag; an applied or undone import should show without waiting out the cache.
 * Runs after the response is built and never fails it (the change already happened; the cache just expires on its own).
 */
export async function revalidateAfter(res: Response, okKey: 'results' | 'ok'): Promise<void> {
  try {
    const body = (await res.clone().json()) as {results?: {ok?: boolean}[]; ok?: boolean};
    const changed = okKey === 'results' ? body.results?.some((r) => r.ok) : body.ok;
    if (changed) revalidateTag('digest-archive', 'max');
  } catch {
    // ignore
  }
}
