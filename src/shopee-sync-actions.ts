'use server';

import {posClient, usingPosMock} from './pos-data';
import {supabaseImportStore} from './shopee-import/store-supabase';
import {cancelSync, confirmReview, requestSync, type Actor, type SyncDeps} from './shopee-sync/service';
import {revalidateDigestArchive, shopeeSyncDeps} from './shopee-sync/server';
import {syncViewer} from './shopee-sync/viewer';

// Server actions for the Shopee same-day sync. Every one re-derives the signed-in person on the server (auth() + ALLOWED_EMAILS); the client sends
// no days and no email. The rules live in src/shopee-sync/service.ts. Nothing here takes or stores a Shopee password or code.
export type ActionResult = {ok: true} | {ok: false; error: string};
const MOCK = 'Running in mock mode: set the Supabase archive env to use Shopee sync.';

type Ctx = {ok: false; error: string} | {ok: true; viewer: Actor; deps: SyncDeps};
async function ctx(): Promise<Ctx> {
  if (usingPosMock()) return {ok: false, error: MOCK};
  const viewer = await syncViewer();
  if (!viewer) return {ok: false, error: 'Not authorized.'};
  const deps = shopeeSyncDeps();
  return deps ? {ok: true, viewer, deps} : {ok: false, error: MOCK};
}

/** Press "Sync Shopee": one job for every missing closed day, or a plain reason why not. */
export async function createSyncJob(): Promise<{ok: true; jobId: string; days: number} | {ok: false; error: string}> {
  const c = await ctx();
  if (!c.ok) return c;
  try {
    const r = await requestSync(c.deps, c.viewer.email);
    if (!r.ok) return r;
    revalidateDigestArchive();
    return {ok: true, jobId: r.job.id, days: r.job.days.length};
  } catch (e) {
    console.error('createSyncJob failed', e);
    return {ok: false, error: 'Could not start the sync. Try again in a moment.'};
  }
}

export async function cancelSyncJob(jobId: string): Promise<ActionResult> {
  const c = await ctx();
  if (!c.ok) return c;
  try {
    const r = await cancelSync(c.deps, c.viewer, String(jobId));
    if (r.ok) revalidateDigestArchive();
    return r;
  } catch (e) {
    console.error('cancelSyncJob failed', e);
    return {ok: false, error: 'Could not cancel the sync. Try again in a moment.'};
  }
}

/** Confirm a sync that ended in review: apply its staged imports (the requester or an admin). */
export async function confirmSyncReview(jobId: string): Promise<ActionResult> {
  const c = await ctx();
  if (!c.ok) return c;
  try {
    const r = await confirmReview(c.deps, supabaseImportStore(posClient()), c.viewer, String(jobId));
    if (r.ok) revalidateDigestArchive();
    return r;
  } catch (e) {
    console.error('confirmSyncReview failed', e);
    return {ok: false, error: 'Could not confirm the sync. Try again in a moment.'};
  }
}
