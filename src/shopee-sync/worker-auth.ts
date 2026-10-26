// Lets the shipped import routes accept a worker token (sales_overview only, see src/shopee-import/api.ts) without knowing about workers.
// A token is only good for the days of the job its Mac is running right now (running or importing); with no such job the days list is empty.
import {workerForToken} from './api';
import type {SyncStore} from './store';
import type {Job} from './types';

export interface WorkerGrant {
  /** Days of the job this worker is running or importing now. Empty: it may not plan or apply anything. */
  days: readonly string[];
  /** The job those days belong to; runs a worker plans are stamped `sync:<jobId>` and it may apply only those. */
  jobId: string | null;
}
const WORKING: readonly Job['status'][] = ['running', 'importing'];

/** The grant behind a bearer token: null when it is not an enrolled, non-revoked worker. */
export const workerAuthFor = (store: SyncStore) => async (bearer: string): Promise<WorkerGrant | null> => {
  const w = await workerForToken(store, bearer);
  if (!w) return null;
  const jobs = await store.recentJobs(10);
  const job = jobs.find((j) => j.claimedBy === w.id && WORKING.includes(j.status));
  return {days: job?.days ?? [], jobId: job?.id ?? null};
};
