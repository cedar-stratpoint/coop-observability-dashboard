import {beforeEach, describe, expect, it} from 'vitest';
import {planFile} from '../src/shopee-import/pipeline';
import {confirmReview, type SyncDeps} from '../src/shopee-sync/service';
import type {Job} from '../src/shopee-sync/types';
import {salesOverviewFile, week} from './support/shopee-fixture';
import {FakeStore} from './support/shopee-fake-store';
import {FakeSyncStore} from './support/shopee-sync-fake-store';

const now = new Date('2026-10-27T06:00:00Z');
let sync: FakeSyncStore;
let imports: FakeStore;
let jobId: string;
const deps = (): SyncDeps => ({store: sync, now: () => now, loadLoadedDays: async () => []});

beforeEach(async () => {
  sync = new FakeSyncStore();
  imports = new FakeStore();
  const w = await sync.createWorker({ownerEmail: 'a@x.com', name: 'm', tokenHash: 'h'}, now);
  await sync.touchWorker(w.id, 'ready', now);
  const job = (await sync.createJob({requestedBy: 'a@x.com', days: ['2026-10-19']}, now)) as Job;
  await sync.claimJob(job.id, w.id, now);
  const o = await planFile({store: imports, bytes: new Uint8Array(await salesOverviewFile(week('2026-10-19', [100, 200, 300, 400, 500, 600, 700]))), filename: 'sales_overview_20261019-20261025.xlsx', today: '2026-10-27', importedBy: 'worker'});
  if (o.status !== 'staged') throw new Error('fixture should stage');
  await sync.transitionJob(job.id, ['running'], {status: 'review', importIds: [o.importId], finishedAt: now.toISOString()});
  jobId = job.id;
});

describe('confirmReview', () => {
  it('applies the staged runs of a review job and ends the job as done', async () => {
    const r = await confirmReview(deps(), imports, {email: 'a@x.com', isAdmin: false}, jobId);
    expect(r).toEqual({ok: true});
    expect(imports.runs.map((x) => x.status)).toEqual(['accepted']);
    expect((await sync.getJob(jobId))?.status).toBe('done');
  });
  it('only the requester or an admin may confirm', async () => {
    const r = await confirmReview(deps(), imports, {email: 'b@x.com', isAdmin: false}, jobId);
    expect(r.ok).toBe(false);
    expect(imports.runs[0].status).toBe('staged');
    expect((await confirmReview(deps(), imports, {email: 'b@x.com', isAdmin: true}, jobId)).ok).toBe(true);
  });
  it('refuses a job that is not waiting for review, and a second confirm', async () => {
    expect((await confirmReview(deps(), imports, {email: 'a@x.com', isAdmin: false}, jobId)).ok).toBe(true);
    expect((await confirmReview(deps(), imports, {email: 'a@x.com', isAdmin: false}, jobId)).ok).toBe(false);
  });
  it('keeps the job in review and says why when a run can no longer be applied', async () => {
    imports.runs[0].status = 'superseded';
    const r = await confirmReview(deps(), imports, {email: 'a@x.com', isAdmin: false}, jobId);
    expect(r.ok).toBe(false);
    expect((await sync.getJob(jobId))?.status).toBe('review');
  });
});
