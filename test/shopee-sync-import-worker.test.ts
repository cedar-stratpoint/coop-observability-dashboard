import {describe, expect, it} from 'vitest';
import {handleApply, handleCoverage, handlePlan, handleUndo} from '../src/shopee-import/api';
import {markLoadedProgress} from '../src/shopee-sync/service';
import {workerAuthFor} from '../src/shopee-sync/worker-auth';
import type {Job} from '../src/shopee-sync/types';
import {salesOverviewFile, week} from './support/shopee-fixture';
import {FakeStore} from './support/shopee-fake-store';
import {FakeSyncStore} from './support/shopee-sync-fake-store';

const IMPORT_TOKEN = 'import-token-0123456789';
const WORKER_TOKEN = 'worker-secret-0123456789';
const NOW = new Date('2026-10-27T03:00:00Z');
const bearer = (t: string) => ({authorization: `Bearer ${t}`});

const WEEK = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];
/** A worker running a job for `days` (default: the week of the fixture file): the only time its secret may plan or apply. */
async function setup(opts: {days?: string[] | null; status?: Job['status']} = {}) {
  const sync = new FakeSyncStore();
  const token = WORKER_TOKEN;
  const store = new FakeStore();
  const days = opts.days === undefined ? WEEK : opts.days;
  if (days) {
    await sync.touchHeartbeat({login: {state: 'ready', checkedAt: NOW.toISOString()}}, NOW);
    const job = (await sync.createJob({requestedBy: 'a@x.com', days}, NOW)) as Job;
    await sync.claimJob(job.id, NOW);
    if (opts.status && opts.status !== 'running') await sync.transitionJob(job.id, ['running'], {status: opts.status});
  }
  const deps = {store, token: IMPORT_TOKEN as string | undefined, now: () => NOW, workerAuth: workerAuthFor(sync, WORKER_TOKEN, () => NOW), afterWorkerApply: async (jobId: string) => markLoadedProgress(sync, jobId, await store.loadLoadedDays())};
  return {sync, token, store, deps};
}
async function planReq(token: string, files: {name: string; bytes: Buffer}[], fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const f of files) form.append('files', new File([new Uint8Array(f.bytes)], f.name));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new Request('https://coop.example/p', {method: 'POST', body: form, headers: bearer(token)});
}
const json = (token: string, body: unknown) => new Request('https://coop.example/x', {method: 'POST', body: JSON.stringify(body), headers: {'content-type': 'application/json', ...bearer(token)}});
const daily = async () => ({name: 'sales_overview_20261012-20261018.xlsx', bytes: await salesOverviewFile(week('2026-10-12', [100, 200, 300, 400, 500, 600, 700]))});

describe('the worker secret is only good for its own running job', () => {
  it('refuses plan and apply with no active job, writing nothing', async () => {
    const {token, deps, store} = await setup({days: null});
    const res = await handlePlan(await planReq(token, [await daily()]), deps);
    expect(res.status).toBe(403);
    expect(store.runs).toHaveLength(0);
    const planned = await (await handlePlan(await planReq(IMPORT_TOKEN, [await daily()]), deps)).json();
    const id = planned.results[0].importId;
    expect((await handleApply(json(token, {importIds: [id]}), deps)).status).toBe(403);
    expect(store.runs.find((r) => r.importId === id)?.status).toBe('staged');
  });
  // Changed deliberately (SYN-09): the old check was "every day is a job day". A file whose period is not an issued window is refused; the week of the fixture is now
  // an issued window for a job holding 18 Oct, so this test asks for a different period (19-25 Oct, not a window of that job).
  it('refuses a file whose period is not an issued window (plan and apply), writing nothing', async () => {
    const {token, deps, store} = await setup({days: ['2026-10-18']});
    const other = {name: 'sales_overview_20261019-20261025.xlsx', bytes: await salesOverviewFile(week('2026-10-19', [1, 2, 3, 4, 5, 6, 7]))};
    const res = await handlePlan(await planReq(token, [other]), deps);
    expect(res.status).toBe(403);
    expect(store.runs).toHaveLength(0);
    const planned = await (await handlePlan(await planReq(IMPORT_TOKEN, [other]), deps)).json();
    const id = planned.results[0].importId;
    expect((await handleApply(json(token, {importIds: [id]}), deps)).status).toBe(403);
    expect(store.runs.find((r) => r.importId === id)?.status).toBe('staged');
  });
  it('refuses a file whose period cannot be read from its name', async () => {
    const {token, deps, store} = await setup();
    const res = await handlePlan(await planReq(token, [{name: 'sales_overview.xlsx', bytes: Buffer.from('x')}]), deps);
    expect(res.status).toBe(403);
    expect(store.runs).toHaveLength(0);
  });
  it('refuses once the job has ended, and refuses while it waits for the password; importing is allowed', async () => {
    const done = await setup({status: 'done'});
    expect((await handlePlan(await planReq(done.token, [await daily()]), done.deps)).status).toBe(403);
    const waiting = await setup({status: 'awaiting_verification'});
    expect((await handlePlan(await planReq(waiting.token, [await daily()]), waiting.deps)).status).toBe(403);
    const importing = await setup({status: 'importing'});
    expect((await handlePlan(await planReq(importing.token, [await daily()]), importing.deps)).status).toBe(200);
  });
  it('a wrong secret is refused even while a job is running', async () => {
    const {deps} = await setup();
    expect((await handlePlan(await planReq('some-other-secret', [await daily()]), deps)).status).toBe(401);
  });
});

describe('the import API with the worker secret', () => {
  it('plans and applies a sales_overview file', async () => {
    const {token, deps} = await setup();
    const planned = await (await handlePlan(await planReq(token, [await daily()]), deps)).json();
    expect(planned.results[0]).toMatchObject({status: 'staged', newDays: 7});
    const applied = await (await handleApply(json(token, {importIds: [planned.results[0].importId]}), deps)).json();
    expect(applied.results[0].ok).toBe(true);
  });
  it('refuses restate, with nothing written', async () => {
    const {token, deps, store} = await setup();
    const res = await handlePlan(await planReq(token, [await daily()], {restate: 'because'}), deps);
    expect(res.status).toBe(403);
    expect(store.runs).toHaveLength(0);
  });
  // Changed deliberately (SYN-09): other report types are no longer refused outright; they are allowed when the window carries them (see 'the five files' below).
  // What stays refused: an unknown file name, and the whole request if any one file is refused, with nothing written.
  it('refuses an unknown file name, and the whole request if any file is refused, with nothing written', async () => {
    const {token, deps, store} = await setup();
    const other = {name: 'orders_20261012-20261018.xlsx', bytes: Buffer.from('x')};
    const res = await handlePlan(await planReq(token, [await daily(), other]), deps);
    expect(res.status).toBe(403);
    expect(store.runs).toHaveLength(0);
  });
  it('refuses to apply a restated run or a run outside an issued window, before applying any', async () => {
    const {token, deps, store} = await setup();
    const planned = await (await handlePlan(await planReq(IMPORT_TOKEN, [await daily()]), deps)).json();
    const id = planned.results[0].importId;
    store.runs.find((r) => r.importId === id)!.restated = true;
    const res = await handleApply(json(token, {importIds: [id]}), deps);
    expect(res.status).toBe(403);
    expect(store.runs.find((r) => r.importId === id)?.status).toBe('staged');
    store.runs.find((r) => r.importId === id)!.restated = false;
    store.runs.find((r) => r.importId === id)!.periodTo = '2026-10-17'; // no longer equal to an issued window
    expect((await handleApply(json(token, {importIds: [id]}), deps)).status).toBe(403);
  });
  it('refuses to apply a run its own job did not plan (an admin-planned or another job\'s run), writing nothing', async () => {
    const {token, deps, store} = await setup();
    const planned = await (await handlePlan(await planReq(IMPORT_TOKEN, [await daily()]), deps)).json();
    const id = planned.results[0].importId;
    expect(store.runs.find((r) => r.importId === id)?.importedBy).toBe('api');
    expect((await handleApply(json(token, {importIds: [id]}), deps)).status).toBe(403);
    store.runs.find((r) => r.importId === id)!.importedBy = 'sync:some-other-job';
    expect((await handleApply(json(token, {importIds: [id]}), deps)).status).toBe(403);
    expect(store.runs.find((r) => r.importId === id)?.status).toBe('staged');
  });
  it('refuses to apply its own run when the plan carries flags (a person reviews those)', async () => {
    const {token, deps, store} = await setup();
    const planned = await (await handlePlan(await planReq(token, [await daily()]), deps)).json();
    const id = planned.results[0].importId;
    expect(store.runs.find((r) => r.importId === id)?.importedBy).toMatch(/^sync:/);
    store.runs.find((r) => r.importId === id)!.plan!.flags.push({code: 'BIG_SWING'} as never);
    expect((await handleApply(json(token, {importIds: [id]}), deps)).status).toBe(403);
    expect(store.runs.find((r) => r.importId === id)?.status).toBe('staged');
  });
  it('refuses undo and coverage with 403', async () => {
    const {token, deps} = await setup();
    expect((await handleUndo(json(token, {importId: 'x', reason: 'r'}), deps)).status).toBe(403);
    expect((await handleCoverage(new Request('https://x', {headers: bearer(token)}), deps)).status).toBe(403);
  });
  it('401 for an unknown secret, and for the worker secret when it is not configured', async () => {
    const {token, deps, sync} = await setup();
    expect((await handlePlan(await planReq('unknown-secret', [await daily()]), deps)).status).toBe(401);
    const unset = {...deps, workerAuth: workerAuthFor(sync, undefined)};
    expect((await handlePlan(await planReq(token, [await daily()]), unset)).status).toBe(401);
    expect((await handleApply(json(token, {importIds: ['x']}), unset)).status).toBe(401);
  });
  it('401 (not 503) for a bad token on a deployment with no import token but worker auth', async () => {
    const {deps} = await setup();
    expect((await handlePlan(await planReq('unknown-secret', [await daily()]), {...deps, token: undefined})).status).toBe(401);
  });
  it('the import token keeps doing everything it did, including undo', async () => {
    const {deps} = await setup();
    const planned = await (await handlePlan(await planReq(IMPORT_TOKEN, [await daily()]), deps)).json();
    const id = planned.results[0].importId;
    await handleApply(json(IMPORT_TOKEN, {importIds: [id]}), deps);
    expect((await handleUndo(json(IMPORT_TOKEN, {importId: id, reason: 'r'}), deps)).status).toBe(200);
  });
});

// ── SYN-09: windows ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// NOW is Tue 27 Oct 11:00 PH, so yesterday is 26 Oct.
const FILES = {
  sales_overview: (p: string) => `sales_overview_${p}.xlsx`,
  traffic: (p: string) => `traffic_overview_${p}.xlsx`,
  product_overview: (p: string) => `productoverview_${p}.xlsx`,
  sku_detail: (p: string) => `parentskudetail_${p}.xlsx`,
  ads: (p: string) => `Shopee-Ads-Overall-Data-Report-${p.slice(6, 8)}_${p.slice(4, 6)}_${p.slice(0, 4)}-${p.slice(15, 17)}_${p.slice(13, 15)}_${p.slice(9, 13)}.csv`,
} as const;
const junk = (name: string) => ({name, bytes: Buffer.from('not a real export')});
const WEEK_P = '20261012-20261018';
const DAY_P = '20261021-20261021';
const mixedDays = [...WEEK, '2026-10-21']; // a week window (12-18 Oct) plus a day window (21 Oct)

describe('the five files per issued window', () => {
  it('a week window accepts all five types in one request (each file is planned, not refused)', async () => {
    const {token, deps} = await setup();
    const files = [FILES.sales_overview, FILES.traffic, FILES.product_overview, FILES.ads, FILES.sku_detail].map((f) => junk(f(WEEK_P)));
    const res = await handlePlan(await planReq(token, files), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).results).toHaveLength(5);
  });
  it('a day window accepts sales_overview, and the week window the other files', async () => {
    const {token, deps} = await setup({days: mixedDays});
    expect((await handlePlan(await planReq(token, [junk(FILES.sales_overview(DAY_P))]), deps)).status).toBe(200);
    for (const f of [FILES.traffic, FILES.product_overview, FILES.ads, FILES.sku_detail]) expect((await handlePlan(await planReq(token, [junk(f(WEEK_P))]), deps)).status).toBe(200);
  });
  it('refuses traffic, product, ads or sku_detail for a day window (the wrong type for that window), writing nothing', async () => {
    const {token, deps, store} = await setup({days: mixedDays});
    for (const f of [FILES.traffic, FILES.product_overview, FILES.ads, FILES.sku_detail]) expect((await handlePlan(await planReq(token, [junk(f(DAY_P))]), deps)).status).toBe(403);
    expect(store.runs).toHaveLength(0);
  });
  it('refuses a window the server did not issue for this job', async () => {
    const {token, deps, store} = await setup();
    expect((await handlePlan(await planReq(token, [junk(FILES.traffic('20261005-20261011'))]), deps)).status).toBe(403);
    expect((await handlePlan(await planReq(token, [junk(FILES.sales_overview(DAY_P))]), deps)).status).toBe(403); // no 21 Oct in this job, so no day window
    expect(store.runs).toHaveLength(0);
  });
  it('a restate is refused for every type, and a null period is refused', async () => {
    const {token, deps, store} = await setup();
    expect((await handlePlan(await planReq(token, [junk(FILES.traffic(WEEK_P))], {restate: 'because'}), deps)).status).toBe(403);
    expect((await handlePlan(await planReq(token, [junk('traffic_overview.xlsx')]), deps)).status).toBe(403);
    expect(store.runs).toHaveLength(0);
  });
  it('a sixth file fails the request, and so does a second file of one type', async () => {
    const {token, deps, store} = await setup({days: mixedDays});
    const five = [FILES.sales_overview, FILES.traffic, FILES.product_overview, FILES.ads, FILES.sku_detail].map((f) => junk(f(WEEK_P)));
    expect((await handlePlan(await planReq(token, [...five, junk(FILES.sales_overview(DAY_P))]), deps)).status).toBe(403);
    expect((await handlePlan(await planReq(token, [junk(FILES.traffic(WEEK_P)), junk(FILES.traffic(WEEK_P))]), deps)).status).toBe(403);
    expect(store.runs).toHaveLength(0);
  });
  it('apply: refuses a run of a type the window does not carry, and one stamped by another job; nothing is applied', async () => {
    const {token, deps, store} = await setup({days: mixedDays});
    const mk = async (name: string, by: string) => {
      const id = await store.createRun({reportType: 'ads', channel: 'shopee', periodFrom: '2026-10-21', periodTo: '2026-10-21', sourceFilename: name, sha256: name, rowCount: 1, status: 'staged', checks: {}, plan: null, importedBy: by});
      return id;
    };
    const jobId = (await sync_jobId(deps));
    const wrongType = await mk('a.csv', `sync:${jobId}`);
    expect((await handleApply(json(token, {importIds: [wrongType]}), deps)).status).toBe(403);
    store.runs.find((r) => r.importId === wrongType)!.periodFrom = '2026-10-12';
    store.runs.find((r) => r.importId === wrongType)!.periodTo = '2026-10-18';
    store.runs.find((r) => r.importId === wrongType)!.importedBy = 'sync:another-job';
    expect((await handleApply(json(token, {importIds: [wrongType]}), deps)).status).toBe(403);
    expect(store.runs.find((r) => r.importId === wrongType)?.status).toBe('staged');
    store.runs.find((r) => r.importId === wrongType)!.importedBy = `sync:${jobId}`;
    expect((await handleApply(json(token, {importIds: [wrongType]}), deps)).status).toBe(200);
  });
  it('apply: more than five ids is refused', async () => {
    const {token, deps} = await setup();
    expect((await handleApply(json(token, {importIds: ['1', '2', '3', '4', '5', '6']}), deps)).status).toBe(403);
  });
});
async function sync_jobId(deps: {workerAuth: (b: string) => Promise<{jobId: string | null} | null>}): Promise<string> {
  const g = await deps.workerAuth(WORKER_TOKEN);
  return g?.jobId as string;
}

describe('only_new and refresh', () => {
  const full = async (vals: number[]) => ({name: `sales_overview_${WEEK_P}.xlsx`, bytes: await salesOverviewFile(week('2026-10-12', vals))});
  const oneDay = async (v: number) => ({name: 'sales_overview_20261026-20261026.xlsx', bytes: await salesOverviewFile(week('2026-10-26', [v]))});
  it('a worker sales plan is forced to only_new: a loaded day with different figures is left alone', async () => {
    const {token, deps, store} = await setup();
    const first = await (await handlePlan(await planReq(IMPORT_TOKEN, [await full([1, 2, 3, 4, 5, 6, 7])]), deps)).json();
    await handleApply(json(IMPORT_TOKEN, {importIds: [first.results[0].importId]}), deps);
    const again = await (await handlePlan(await planReq(token, [await full([10, 20, 30, 40, 50, 60, 70])], {only_new: 'false'}), deps)).json();
    expect(again.results[0].status).toBe('nothing_to_do');
    expect(store.runs.filter((r) => r.status === 'staged')).toHaveLength(0);
  });
  it('a refresh job (one day, already loaded) plans normally, so a changed day can update', async () => {
    const {token, deps} = await setup({days: ['2026-10-26']});
    const first = await (await handlePlan(await planReq(IMPORT_TOKEN, [await oneDay(7)]), deps)).json();
    await handleApply(json(IMPORT_TOKEN, {importIds: [first.results[0].importId]}), deps);
    const again = await (await handlePlan(await planReq(token, [await oneDay(8)]), deps)).json();
    expect(again.results[0].status).toBe('staged');
    expect(again.results[0].changed.length + again.results[0].flags.length).toBeGreaterThan(0);
  });
  it('a refresh-shaped job whose day is NOT loaded is an ordinary job: only_new stays on', async () => {
    const {token, deps} = await setup({days: ['2026-10-26']});
    const r = await (await handlePlan(await planReq(token, [await oneDay(7)]), deps)).json();
    expect(r.results[0]).toMatchObject({status: 'staged', newDays: 1});
  });
});

describe('after an apply the job days that now exist are marked loaded', () => {
  it('stamps progress[day] = loaded for job days present in the archive', async () => {
    const {token, deps, sync} = await setup();
    const planned = await (await handlePlan(await planReq(token, [await daily()]), deps)).json();
    await handleApply(json(token, {importIds: [planned.results[0].importId]}), deps);
    const job = (await sync.recentJobs(1))[0];
    for (const d of WEEK) expect(job.progress[d]?.state).toBe('loaded');
  });
});
