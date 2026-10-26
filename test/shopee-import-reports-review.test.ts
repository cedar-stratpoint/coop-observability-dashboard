// Fixes from the independent review of the weekly report importers: an unfinished week is refused, a backwards SKU name is refused,
// a database failing part way never leaves a run that looks whole, a lost accept race answers "false", parse errors quote little.
import {describe, expect, it} from 'vitest';
import {supabaseImportStore} from '../src/shopee-import/store-supabase';
import {applyRun, planFile} from '../src/shopee-import/pipeline';
import {parseProductOverview} from '../src/shopee-import/product-overview';
import {parseTraffic} from '../src/shopee-import/traffic';
import {FakeStore} from './support/shopee-fake-store';
import {adsCsv, productOverviewFile, skuDetailFile} from './support/shopee-reports-fixture';
import ExcelJS from 'exceljs';

const ADS = 'Shopee-Ads-Overall-Data-21_09_2026-27_09_2026.csv';
const SKU = 'parentskudetail.20260921_20260927.xlsx';
const ads = () => adsCsv([{name: 'Shop GMV Max', gmv: 100, expense: 40}]);
const sku = () => skuDetailFile([{itemId: '1', title: 'A', salesPlaced: 10, salesConfirmed: 10}]);
const plan = (store: FakeStore, filename: string, bytes: Uint8Array, today: string) => planFile({store, bytes, filename, today, importedBy: 'test'});

describe('a weekly report must be for a closed week', () => {
  it.each([
    ['ads', ADS, ads],
    ['SKU', SKU, sku],
  ])('%s: a period ending today or later is rejected PERIOD_OPEN, one that ended before today is staged', async (_n, name, bytes) => {
    for (const today of ['2026-09-27', '2026-09-24']) {
      const o = await plan(new FakeStore(), name, await bytes(), today);
      expect(o.status).toBe('rejected');
      expect(o.status === 'rejected' && o.failures.map((f) => f.code)).toContain('PERIOD_OPEN');
    }
    const ok = await plan(new FakeStore(), name, await bytes(), '2026-09-28');
    expect(ok.status).toBe('staged_report');
  });
});

describe('SKU file name', () => {
  it('with dates running backwards is rejected PERIOD_MISMATCH', async () => {
    const o = await plan(new FakeStore(), 'parentskudetail.20260927_20260921.xlsx', await sku(), '2026-10-27');
    expect(o.status).toBe('rejected');
    expect(o.status === 'rejected' && o.failures.map((f) => f.code)).toContain('PERIOD_MISMATCH');
  });
});

describe('the database failing part way through the rows', () => {
  it('rethrows, flips the staged run to rejected, and the run can no longer be applied', async () => {
    const store = new FakeStore();
    store.failSnapshotRows = true;
    await expect(plan(store, ADS, await ads(), '2026-10-27')).rejects.toThrow('connection lost');
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({status: 'rejected'});
    const r = await applyRun(store, store.runs[0].importId);
    expect(r).toMatchObject({ok: false, code: 'NOT_STAGED'});
    expect(await store.loadReportPeriods()).toEqual([]);
  });
});

describe('store-supabase transition', () => {
  // The call chain the store makes: from('import_runs').update(change).eq(id).eq(status).select('import_id') resolves {data, error}.
  const clientWith = (result: {data: unknown; error: {code?: string; message: string} | null}) => {
    const chain: Record<string, unknown> = {};
    chain.update = () => chain;
    chain.eq = () => chain;
    chain.select = () => Promise.resolve(result);
    return {from: () => chain} as never;
  };
  it('answers false (a lost race) when another process accepted the same file first (23505)', async () => {
    const store = supabaseImportStore(clientWith({data: null, error: {code: '23505', message: 'duplicate key value violates unique constraint "import_runs_accepted_file_uq"'}}));
    expect(await store.transition('id', 'staged', 'accepted')).toBe(false);
  });
  it('still throws on any other database error, and answers true when exactly one row changed', async () => {
    await expect(supabaseImportStore(clientWith({data: null, error: {code: '42501', message: 'permission denied'}})).transition('id', 'staged', 'accepted')).rejects.toThrow('permission denied');
    expect(await supabaseImportStore(clientWith({data: [{import_id: 'id'}], error: null})).transition('id', 'staged', 'accepted')).toBe(true);
  });
});

describe('parse errors do not echo a whole cell', () => {
  const LONG = 'Buyer Name Surname Address 123 Some Street';
  it('traffic quotes at most 12 characters of a non-date cell', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('All');
    const head = ['Date', 'Page Views', 'Avg. Page Views', 'Avg. Time Spent', 'Bounce Rate', 'Visitors'];
    ws.addRow(head);
    ws.addRow(['21/09/2026-27/09/2026', '5', '1', '00:00:10', '1%', '2']);
    ws.addRow([]);
    ws.addRow(head);
    ws.addRow([LONG, '5', '1', '00:00:10', '1%', '2']);
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());
    const err = await parseTraffic(bytes).then(() => null, (e: Error) => e.message);
    expect(err).toContain(LONG.slice(0, 12));
    expect(err).not.toContain(LONG.slice(0, 13));
  });
  it('product overview quotes at most 12 characters of a non-date cell', async () => {
    const good = await productOverviewFile([{day: '2026-09-21', salesPlaced: 1, salesConfirmed: 1}]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(good as unknown as ExcelJS.Buffer);
    wb.worksheets[0].getRow(2).getCell(1).value = LONG;
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());
    const err = await parseProductOverview(bytes).then(() => null, (e: Error) => e.message);
    expect(err).toContain(LONG.slice(0, 12));
    expect(err).not.toContain(LONG.slice(0, 13));
  });
});
