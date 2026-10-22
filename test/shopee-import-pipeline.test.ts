import {describe, expect, it} from 'vitest';
import {applyRun, planFile, undoRun} from '../src/shopee-import/pipeline';
import {salesOverviewFile, week} from './support/shopee-fixture';
import {FakeStore} from './support/shopee-fake-store';

const TODAY = '2026-10-27'; // a Tuesday: 26 Oct and earlier are closed days
const file = (from: string, sales: number[], opts = {}) => salesOverviewFile(week(from, sales), opts);
const plan = async (store: FakeStore, name: string, bytes: Buffer, extra = {}) => planFile({store, bytes, filename: name, today: TODAY, importedBy: 'test', ...extra});
const staged = (o: Awaited<ReturnType<typeof plan>>) => {
  if (o.status !== 'staged') throw new Error(`expected staged, got ${o.status}`);
  return o;
};

describe('plan, apply, undo', () => {
  it('stages a new week, applies it, and a second plan of the same file is "already loaded"', async () => {
    const store = new FakeStore();
    const bytes = await file('2026-10-12', [100, 200, 300, 400, 500, 600, 700]);
    const s = staged(await plan(store, 'sales_overview_20261012-20261018.xlsx', bytes));
    expect(s.plan.newDays).toHaveLength(7);
    expect((await store.loadCurrent('2026-10-12', '2026-10-18')).size).toBe(0); // staged is inert: the app sees nothing yet
    const done = await applyRun(store, s.importId);
    expect(done.ok && done.receipt).toMatchObject({newDays: 7, loadedConfirmed: 2800, reconciled: true, matchesFileTotal: true});
    expect((await store.loadCurrent('2026-10-12', '2026-10-18')).size).toBe(7);
    expect((await plan(store, 'sales_overview_20261012-20261018.xlsx', bytes)).status).toBe('already_loaded');
  });

  it('a file that fails a gate is rejected whole, recorded, and writes no figures', async () => {
    const store = new FakeStore();
    const bad = await file('2026-10-12', [100, 200, 300], {summaryConf: 999});
    const o = await plan(store, 'sales_overview_20261012-20261014.xlsx', bad);
    expect(o.status).toBe('rejected');
    expect(store.runs[0]).toMatchObject({status: 'rejected'});
    expect(store.obs.size).toBe(0);
    expect((await plan(store, 'sales_overview_20261012-20261014.xlsx', Buffer.from('garbage'))).status).toBe('rejected');
  });

  it('the 19 to 24 Oct example: loaded to 22 Oct, the next file adds 23 and 24, updates a changed recent day, leaves older weeks alone', async () => {
    const store = new FakeStore();
    const first = staged(await plan(store, 'sales_overview_20261019-20261022.xlsx', await file('2026-10-19', [1000, 2000, 3070, 500])));
    await applyRun(store, first.importId);
    const older = staged(await plan(store, 'sales_overview_20261005-20261011.xlsx', await file('2026-10-05', [10, 20, 30, 40, 50, 60, 70])));
    await applyRun(store, older.importId);

    const next = staged(await plan(store, 'sales_overview_20261019-20261024.xlsx', await file('2026-10-19', [1000, 2000, 2980, 500, 800, 900])));
    expect(next.plan.newDays).toEqual(['2026-10-23', '2026-10-24']);
    expect(next.plan.changed.map((c) => [c.day, c.before, c.after])).toEqual([['2026-10-21', 3070, 2980]]);
    await applyRun(store, next.importId);
    const cur = await store.loadCurrent('2026-10-05', '2026-10-24');
    expect(cur.get('2026-10-21')?.salesConfirmed).toBe(2980);
    expect(cur.get('2026-10-24')?.salesConfirmed).toBe(900);
    expect(cur.get('2026-10-07')?.salesConfirmed).toBe(30); // the older week is untouched
  });

  it('undo restores the previous figures by itself and needs a written reason', async () => {
    const store = new FakeStore();
    const a = staged(await plan(store, 'sales_overview_20261019-20261020.xlsx', await file('2026-10-19', [1000, 2000])));
    await applyRun(store, a.importId);
    const b = staged(await plan(store, 'sales_overview_20261019-20261020.xlsx', await file('2026-10-19', [1000, 1500])));
    await applyRun(store, b.importId);
    expect((await store.loadCurrent('2026-10-19', '2026-10-20')).get('2026-10-20')?.salesConfirmed).toBe(1500);
    expect((await undoRun(store, b.importId, '  ')).ok).toBe(false);
    expect((await undoRun(store, b.importId, 'wrong export')).ok).toBe(true);
    expect((await store.loadCurrent('2026-10-19', '2026-10-20')).get('2026-10-20')?.salesConfirmed).toBe(2000);
  });

  it('refuses to apply a stale plan: the figures it was made against moved in the meantime', async () => {
    const store = new FakeStore();
    const base = staged(await plan(store, 'sales_overview_20261019-20261020.xlsx', await file('2026-10-19', [1000, 2000])));
    await applyRun(store, base.importId);
    const p1 = staged(await plan(store, 'sales_overview_20261019-20261020.xlsx', await file('2026-10-19', [1000, 1800])));
    const p2 = staged(await plan(store, 'sales_overview_20261019-20261020.xlsx', await file('2026-10-19', [1000, 1700])));
    expect((await applyRun(store, p2.importId)).ok).toBe(true);
    const late = await applyRun(store, p1.importId);
    expect(late).toMatchObject({ok: false, code: 'STALE_PLAN'});
  });

  it('a day older than 28 days that differs is frozen; restating with a reason changes it', async () => {
    const store = new FakeStore();
    const a = staged(await plan(store, 'sales_overview_20260810-20260811.xlsx', await file('2026-08-10', [1000, 2000])));
    await applyRun(store, a.importId);
    const changed = await file('2026-08-10', [1000, 2500]);
    const blocked = await plan(store, 'sales_overview_20260810-20260811.xlsx', changed);
    expect(blocked.status).toBe('nothing_to_do'); // the changed day is frozen, the other equal
    const restated = staged(await plan(store, 'sales_overview_20260810-20260811.xlsx', changed, {restate: 'Shopee corrected August'}));
    expect(restated.plan.changed.map((c) => c.day)).toEqual(['2026-08-11']);
  });

  it('leaves today out and records only the closed days', async () => {
    const store = new FakeStore();
    const s = staged(await planFile({store, bytes: await file('2026-10-21', [1, 2, 3, 4, 5, 6, 7]), filename: 'sales_overview_20261021-20261027.xlsx', today: '2026-10-25'}));
    expect(s.openSkipped).toEqual(['2026-10-25', '2026-10-26', '2026-10-27']);
    expect(s.periodTo).toBe('2026-10-24');
  });

  it('says what it cannot import instead of failing', async () => {
    const store = new FakeStore();
    expect((await plan(store, 'parentskudetail.20261012_20261018.xlsx', Buffer.from('x'))).status).toBe('unsupported');
    expect((await plan(store, 'Order.all.20260901_20260930.xlsx', Buffer.from('x'))).status).toBe('unsupported');
  });
});
