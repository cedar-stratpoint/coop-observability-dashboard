// Lets the shipped import routes accept the sync worker's secret (plan and apply of the files of the windows issued for its job, see src/shopee-import/api.ts)
// without knowing about workers. The secret is only good for the job running now (running or importing); with no such job there are no windows.
import {secretMatches} from './api';
import type {SyncStore} from './store';
import type {Job} from './types';
import {issuedWindows, type SyncWindow} from './windows';

export interface WorkerGrant {
  /** The windows issued for the job the worker is running or importing now (the union of the anchors at creation and at call time). Empty: it may not plan or apply anything. */
  windows: readonly SyncWindow[];
  /** The job those windows belong to; runs a worker plans are stamped `sync:<jobId>` and it may apply only those. */
  jobId: string | null;
  /** The job's only day when it has exactly one (a Refresh press), else null. Decides whether a sales plan is `only_new`. */
  singleDay: string | null;
}
const WORKING: readonly Job['status'][] = ['running', 'importing'];

/** The grant behind a bearer: null unless it is the shared worker secret (SHOPEE_SYNC_WORKER_TOKEN; unset means nobody). */
export const workerAuthFor = (store: SyncStore, workerToken: string | null | undefined, now: () => Date = () => new Date()) => async (bearer: string): Promise<WorkerGrant | null> => {
  if (!secretMatches(bearer, workerToken)) return null;
  const job = (await store.recentJobs(10)).find((j) => WORKING.includes(j.status));
  if (!job) return {windows: [], jobId: null, singleDay: null};
  return {windows: issuedWindows(job.days, job.createdAt, now()), jobId: job.id, singleDay: job.days.length === 1 ? job.days[0] : null};
};
