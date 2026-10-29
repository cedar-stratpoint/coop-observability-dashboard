// Lets the shipped import routes accept the sync worker's secret (sales_overview only, see src/shopee-import/api.ts) without knowing about workers.
// The secret is only good for the days of the job running now (running or importing); with no such job the days list is empty.
import {secretMatches} from './api';
import type {SyncStore} from './store';
import type {Job} from './types';

export interface WorkerGrant {
  /** Days of the job the worker is running or importing now. Empty: it may not plan or apply anything. */
  days: readonly string[];
  /** The job those days belong to; runs a worker plans are stamped `sync:<jobId>` and it may apply only those. */
  jobId: string | null;
}
const WORKING: readonly Job['status'][] = ['running', 'importing'];

/** The grant behind a bearer: null unless it is the shared worker secret (SHOPEE_SYNC_WORKER_TOKEN; unset means nobody). */
export const workerAuthFor = (store: SyncStore, workerToken: string | null | undefined) => async (bearer: string): Promise<WorkerGrant | null> => {
  if (!secretMatches(bearer, workerToken)) return null;
  const job = (await store.recentJobs(10)).find((j) => WORKING.includes(j.status));
  return {days: job?.days ?? [], jobId: job?.id ?? null};
};
