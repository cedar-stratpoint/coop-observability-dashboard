import {beforeEach, describe, expect, it} from 'vitest';
import {planFile} from '../src/shopee-import/pipeline';
import {confirmReview, type SyncDeps} from '../src/shopee-sync/service';
import type {Job} from '../src/shopee-sync/types';
import {salesOverviewFile, week} from './support/shopee-fixture';
import {FakeStore} from './support/shopee-fake-store';
import {FakeSyncStore} from './support/shopee-sync-fake-store';
import {exactReports} from './support/shopee-sync-reports';

const now = new Date('2026-10-27T06:00:00Z');
let sync: FakeSyncStore;
let imports: FakeStore;
let jobId: string;
// Changed deliberately (SYN-12): confirmReview now runs the completeness check after applying, so loadedDays follows what the fake archive holds.
const deps = (): SyncDeps => ({store: sync, now: () => now, loadLoadedDays: () => imports.loadLoadedDays(), loadReportPeriods: async () => exactReports(await imports.loadLoadedDays())});

beforeEach(async () => {
  sync = new FakeSyncStore();
  imports = new FakeStore();
  await sync.touchHeartbeat({login: {state: 'ready', checkedAt: now.toISOString()}}, now);
  const job = (await sync.createJob({requestedBy: 'a@x.com', days: ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']}, now)) as Job;
  await sync.claimJob(job.id, now);
  const o = await planFile({store: imports, bytes: new Uint8Array(await salesOverviewFile(week('2026-10-19', [100, 200, 300, 400, 500, 600, 700]))), filename: 'sales_overview_20261019-20261025.xlsx', today: '2026-10-27', importedBy: `sync:${job.id}`});
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

describe('confirmReview: mixed set and completeness (SYN-09, SYN-12)', () => {
  const who = {email: 'a@x.com', isAdmin: false};
  it('applies a mixed set of sales and a daily snapshot run planned for issued windows', async () => {
    const id = await imports.createRun({reportType: 'traffic', channel: 'shopee', periodFrom: '2026-10-19', periodTo: '2026-10-25', sourceFilename: 't.xlsx', sha256: 't', rowCount: 1, status: 'staged', checks: {}, plan: null, importedBy: `sync:${jobId}`});
    await sync.transitionJob(jobId, ['review'], {importIds: [imports.runs[0].importId, id]});
    expect(await confirmReview(deps(), imports, who, jobId)).toEqual({ok: true});
    expect(imports.runs.find((r) => r.importId === id)?.status).toBe('accepted');
    expect((await sync.getJob(jobId))?.status).toBe('done');
  });
  it('a day still missing after applying ends the job failed with "Still missing", and says so', async () => {
    const r = await confirmReview({...deps(), loadLoadedDays: async () => ['2026-10-19']}, imports, who, jobId);
    expect(r.ok).toBe(false);
    expect(imports.runs[0].status).toBe('accepted'); // the figures were applied
    expect(await sync.getJob(jobId)).toMatchObject({status: 'failed'});
    expect((await sync.getJob(jobId))?.error).toMatch(/^Still missing: 2026-10-20, /);
  });
});

describe('confirmReview only applies what belongs to the job', () => {
  const who = {email: 'a@x.com', isAdmin: false};
  const refuses = async () => {
    const r = await confirmReview(deps(), imports, who, jobId);
    expect(r.ok).toBe(false);
    expect(imports.runs[0].status).toBe('staged');
    expect((await sync.getJob(jobId))?.status).toBe('review');
  };
  it('refuses a restated run', async () => {
    imports.runs[0].restated = true;
    await refuses();
  });
  // Changed deliberately (SYN-09): a non-sales run is no longer refused by type; it is refused when its window does not carry that type (ads is not a day-window file).
  it('refuses a run whose type the window does not carry', async () => {
    sync.jobs[0].days = ['2026-10-19', '2026-10-20']; // two day windows, which carry sales_overview only
    imports.runs[0].reportType = 'ads';
    imports.runs[0].periodFrom = '2026-10-19';
    imports.runs[0].periodTo = '2026-10-19';
    await refuses();
  });
  it('refuses a run whose period is outside the job days', async () => {
    imports.runs[0].periodTo = '2026-10-26'; // the job ends 25 Oct
    await refuses();
  });
  it('refuses a run planned by someone else or another job', async () => {
    imports.runs[0].importedBy = 'api';
    await refuses();
  });
  it('applies none when any run is not eligible', async () => {
    const o = await planFile({store: imports, bytes: new Uint8Array(await salesOverviewFile(week('2026-10-19', [1, 2, 3, 4, 5, 6, 7]))), filename: 'sales_overview_20261019-20261025.xlsx', today: '2026-10-27', importedBy: 'api'});
    if (o.status !== 'staged') throw new Error('fixture should stage');
    await sync.transitionJob(jobId, ['review'], {importIds: [imports.runs[0].importId, o.importId]});
    const r = await confirmReview(deps(), imports, who, jobId);
    expect(r.ok).toBe(false);
    expect(imports.runs.every((x) => x.status !== 'accepted')).toBe(true);
  });
});
