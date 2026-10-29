import 'server-only';
import {usingPosMock} from './pos-data';
import {sweepJobs} from './shopee-sync/service';
import {shopeeSyncDeps} from './shopee-sync/server';
import {buildSyncStatus, type ShopeeSyncStatus} from './shopee-sync/status';
import {syncViewer} from './shopee-sync/viewer';

// Read seam for the Shopee same-day sync (the Overview card). Server-only, service role, deliberately NOT cached: the card shows a
// live status and a worker's last-seen time. Mock mode (no archive env) returns an empty, refusing status, like the other readers.
export type {LoginView, ShopeeSyncStatus, SyncJobView} from './shopee-sync/status';

const MOCK_REASON = 'Running in mock mode: set the Supabase archive env to use Shopee sync.';

/** The signed-in person's view of the sync, or null when not signed in or not allowed.  */
export async function getShopeeSyncStatus(): Promise<ShopeeSyncStatus | null> {
  const viewer = await syncViewer();
  if (!viewer) return null;
  const d = usingPosMock() ? null : shopeeSyncDeps();
  if (!d) {
    return {signedInAs: viewer.email, isAdmin: viewer.isAdmin, mock: true, worker: null, login: {state: 'unknown', checkedAt: null, ageSeconds: null, stale: false}, workerOnline: false, remoteReady: false, remoteUrl: null, currentJob: null, lastJob: null, missingDays: [], moreMissing: 0, canSync: {ok: false, reason: MOCK_REASON}};
  }
  const now = d.now();
  const [jobs, heartbeat, loadedDays] = await Promise.all([sweepJobs(d.store, now), d.store.getHeartbeat(), d.loadLoadedDays()]);
  return buildSyncStatus({viewer, now, heartbeat, remoteUrl: d.remoteUrl ?? null, jobs, loadedDays});
}
