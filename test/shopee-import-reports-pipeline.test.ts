import {describe, expect, it} from 'vitest';
import {applyRun, planFile, sha256Of, undoRun} from '../src/shopee-import/pipeline';
import {salesOverviewFile, week} from './support/shopee-fixture';
import {FakeStore} from './support/shopee-fake-store';
import {adsCsv, funnelWeek, productOverviewFile, skuDetailFile, trafficFile} from './support/shopee-reports-fixture';

const TODAY = '2026-10-27';
const FROM = '2026-09-21';
const plan = (store: FakeStore, filename: string, bytes: Uint8Array) => planFile({store, bytes, filename, today: TODAY, importedBy: 'test'});
const stagedReport = (o: Awaited<ReturnType<typeof plan>>) => {
  if (o.status !== 'staged_report') throw new Error(`expected staged_report, got ${o.status}`);
  return o;
};

const CASES = [
  {type: 'ads', filename: 'Shopee-Ads-Overall-Data-21_09_2026-27_09_2026.csv', ext: 'csv', rows: 2, bytes: async () => adsCsv([{name: 'Shop GMV Max', gmv: 7386, expense: 3350.68}, {name: 'Product ad', gmv: 100, expense: 50}]), summary: {campaigns: 2, spend: 3400.68, adRevenue: 7486}, bad: async () => ({name: 'Shopee-Ads-Overall-Data-14_09_2026-20_09_2026.csv', bytes: adsCsv([{name: 'a', gmv: 1, expense: 1}]), code: 'FILENAME_MISMATCH'})},
  {type: 'sku_detail', filename: 'parentskudetail.20260921_20260927.xlsx', ext: 'xlsx', rows: 3, bytes: () => skuDetailFile([{itemId: '1', title: 'A', salesPlaced: 700, salesConfirmed: 600, variations: [{id: 'v1', name: 'x', salesPlaced: 700, salesConfirmed: 600}]}, {itemId: '2', title: 'B', salesPlaced: 300, salesConfirmed: 300}]), summary: {products: 2, variations: 1, confirmedSales: 900}, bad: async () => ({name: 'parentskudetail.20260921_20260927.xlsx', bytes: await skuDetailFile([]), code: 'EMPTY'})},
  {type: 'traffic', filename: 'traffic_overview_20260921_20260927.xlsx', ext: 'xlsx', rows: 21, bytes: () => trafficFile(FROM), summary: {days: 7, pageViews: 560}, bad: async () => ({name: 'traffic_overview_20260921_20260927.xlsx', bytes: await trafficFile(FROM, {summaryPageViews: 1}), code: 'SUM_PAGE_VIEWS'})},
  {type: 'product_overview', filename: 'productoverview20260921-20260927.xlsx', ext: 'xlsx', rows: 7, bytes: () => productOverviewFile(funnelWeek(FROM, [100, 200, 300, 400, 500, 600, 700])), summary: {days: 7, salesPlaced: 2870, salesConfirmed: 2800}, bad: async () => ({name: 'productoverview20260921-20260927.xlsx', bytes: await productOverviewFile(funnelWeek(FROM, [1, 2, 3, 4, 5, 6, 7]).filter((d) => d.day !== '2026-09-24')), code: 'GAP'})},
] as const;

describe.each(CASES)('$type: plan, apply, undo', (c) => {
  it('stages as a report, applies with a receipt, and the same file again is "already loaded"', async () => {
    const store = new FakeStore();
    const bytes = await c.bytes();
    const s = stagedReport(await plan(store, c.filename, bytes));
    expect(s).toMatchObject({reportType: c.type, periodFrom: FROM, periodTo: '2026-09-27', rows: c.rows, openSkipped: []});
    expect(s.summary).toMatchObject(c.summary);
    expect(store.runs.find((r) => r.importId === s.importId)).toMatchObject({status: 'staged', reportType: c.type, rowCount: c.rows});
    expect(store.snapshotRows.get(s.importId)?.records).toHaveLength(c.rows);
    expect(await store.loadReportPeriods()).toEqual([]); // staged is inert

    const done = await applyRun(store, s.importId);
    expect(done.ok && done.receipt).toMatchObject({importId: s.importId, reportType: c.type, periodFrom: FROM, periodTo: '2026-09-27', newDays: 0, changedDays: 0, reconciled: true, matchesFileTotal: null});
    expect(done.ok && done.receipt.summary).toMatchObject(c.summary);
    expect(store.runs.find((r) => r.importId === s.importId)?.status).toBe('accepted');
    expect(await store.loadReportPeriods()).toEqual([{reportType: c.type, periodFrom: FROM, periodTo: '2026-09-27'}]);

    expect(await plan(store, c.filename, bytes)).toEqual({status: 'already_loaded', filename: c.filename, importId: s.importId});
  });

  it('undo flips an accepted import to superseded and the period is no longer covered', async () => {
    const store = new FakeStore();
    const s = stagedReport(await plan(store, c.filename, await c.bytes()));
    await applyRun(store, s.importId);
    expect((await undoRun(store, s.importId, '')).ok).toBe(false); // a reason is required
    expect(await undoRun(store, s.importId, 'wrong week exported')).toMatchObject({ok: true});
    expect(store.runs.find((r) => r.importId === s.importId)).toMatchObject({status: 'superseded', note: 'wrong week exported'});
    expect(await store.loadReportPeriods()).toEqual([]);
    expect((await applyRun(store, s.importId)).ok).toBe(false); // superseded cannot be applied again
  });

  it('keeps the original file under <type>/<sha256>.<ext>, and still stages when it cannot be kept', async () => {
    const store = new FakeStore();
    const bytes = await c.bytes();
    const s = stagedReport(await plan(store, c.filename, bytes));
    expect(s.rawStored).toBe(true);
    expect(store.raw.get(s.importId)?.path).toBe(`${c.type}/${sha256Of(bytes)}.${c.ext}`);
    expect(Buffer.from(store.raw.get(s.importId)!.bytes).equals(Buffer.from(bytes))).toBe(true);

    const offline = new FakeStore();
    offline.rawWorks = false;
    const o = stagedReport(await plan(offline, c.filename, bytes));
    expect(o.rawStored).toBe(false);
    expect(offline.runs.find((r) => r.importId === o.importId)?.status).toBe('staged');
    expect((await applyRun(offline, o.importId)).ok).toBe(true);
  });

  it('a file that fails a gate is rejected whole and recorded, with no rows written', async () => {
    const store = new FakeStore();
    const bad = await c.bad();
    const o = await plan(store, bad.name, bad.bytes);
    expect(o).toMatchObject({status: 'rejected'});
    expect(o.status === 'rejected' && o.failures.map((f) => f.code)).toContain(bad.code);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({status: 'rejected', reportType: c.type});
    expect(store.snapshotRows.size).toBe(0);
    const garbage = await plan(new FakeStore(), c.filename, Buffer.from('garbage'));
    expect(garbage).toMatchObject({status: 'rejected', failures: [{code: 'PARSE'}]});
  });
});

describe('re-planning', () => {
  it('planning the same unloaded file again replaces the earlier staged run', async () => {
    const store = new FakeStore();
    const bytes = await trafficFile(FROM);
    const first = stagedReport(await plan(store, 'traffic_overview_20260921_20260927.xlsx', bytes));
    const second = stagedReport(await plan(store, 'traffic_overview_20260921_20260927.xlsx', bytes));
    expect(store.runs.find((r) => r.importId === first.importId)?.status).toBe('superseded');
    expect(store.runs.find((r) => r.importId === second.importId)?.status).toBe('staged');
  });

  it('open days are left out of a daily report and named', async () => {
    const store = new FakeStore();
    const o = stagedReport(await planFile({store, bytes: await trafficFile(FROM), filename: 'traffic_overview_20260921_20260927.xlsx', today: '2026-09-24'}));
    expect(o.openSkipped).toEqual(['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']);
    expect(o.rows).toBe(9);
  });
});

describe('SKU coverage of the shop sales', () => {
  const sku = () => skuDetailFile([{itemId: '1', title: 'A', salesPlaced: 700, salesConfirmed: 600}, {itemId: '2', title: 'B', salesPlaced: 300, salesConfirmed: 300}]);
  const SKU_NAME = 'parentskudetail.20260921_20260927.xlsx';

  it('is the share of the week\'s confirmed shop sales the product list accounts for, once the week\'s sales are loaded', async () => {
    const store = new FakeStore();
    const sales = await plan(store, 'sales_overview_20260921-20260927.xlsx', await salesOverviewFile(week(FROM, [100, 100, 100, 100, 200, 200, 200])));
    if (sales.status !== 'staged') throw new Error(`expected staged, got ${sales.status}`);
    await applyRun(store, sales.importId);
    expect(stagedReport(await plan(store, SKU_NAME, await sku())).coveragePct).toBe(90); // 900 of 1,000
  });

  it('is unknown when the week\'s sales are not loaded, or only some of its days are', async () => {
    expect(stagedReport(await plan(new FakeStore(), SKU_NAME, await sku())).coveragePct).toBeNull();
    const store = new FakeStore();
    const partial = await plan(store, 'sales_overview_20260921-20260924.xlsx', await salesOverviewFile(week(FROM, [100, 100, 100, 100])));
    if (partial.status !== 'staged') throw new Error(`expected staged, got ${partial.status}`);
    await applyRun(store, partial.importId);
    expect(stagedReport(await plan(store, SKU_NAME, await sku())).coveragePct).toBeNull();
  });

  it('is stored with the run so apply can report it', async () => {
    const store = new FakeStore();
    const s = stagedReport(await plan(store, SKU_NAME, await sku()));
    expect(store.runs.find((r) => r.importId === s.importId)?.checks).toMatchObject({passed: true, coveragePct: null, summary: {confirmedSales: 900}});
  });
});

describe('the Sales Overview path is unchanged', () => {
  it('a sales file still stages as "staged" with a plan, keeps its original, and applies with the sales receipt', async () => {
    const store = new FakeStore();
    const bytes = await salesOverviewFile(week(FROM, [100, 200, 300, 400, 500, 600, 700]));
    const o = await plan(store, 'sales_overview_20260921-20260927.xlsx', bytes);
    if (o.status !== 'staged') throw new Error(`expected staged, got ${o.status}`);
    expect(o.rawStored).toBe(true);
    expect(store.raw.get(o.importId)?.path).toBe(`sales_overview/${sha256Of(bytes)}.xlsx`);
    const done = await applyRun(store, o.importId);
    expect(done.ok && done.receipt).toMatchObject({reportType: 'sales_overview', newDays: 7, loadedConfirmed: 2800, matchesFileTotal: true});
  });

  it('an unknown file name is still unsupported', async () => {
    expect(await plan(new FakeStore(), 'notes.txt', Buffer.from('hi'))).toMatchObject({status: 'unsupported'});
  });
});
