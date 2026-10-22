import {describe, expect, it} from 'vitest';
import {authorize, handleApply, handleCoverage, handlePlan, handleUndo} from '../src/shopee-import/api';
import {salesOverviewFile, week} from './support/shopee-fixture';
import {FakeStore} from './support/shopee-fake-store';

const TOKEN = 'test-token-0123456789';
const NOW = new Date('2026-10-27T03:00:00Z'); // PH: Tuesday 27 Oct, 11:00
const deps = (store = new FakeStore(), token: string | undefined = TOKEN) => ({store, token, now: () => NOW});
const authed = (extra: Record<string, string> = {}) => ({authorization: `Bearer ${TOKEN}`, ...extra});

async function planRequest(files: {name: string; bytes: Buffer}[], fields: Record<string, string> = {}, headers = authed()): Promise<Request> {
  const form = new FormData();
  for (const f of files) form.append('files', new File([new Uint8Array(f.bytes)], f.name));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new Request('https://coop.example/api/shopee/import/plan', {method: 'POST', body: form, headers});
}
const json = (body: unknown, headers = authed()): Request => new Request('https://coop.example/x', {method: 'POST', body: JSON.stringify(body), headers: {'content-type': 'application/json', ...headers}});
const weekFile = async (from: string, sales: number[]) => ({name: `sales_overview_${from.replaceAll('-', '')}-${week(from, sales).slice(-1)[0].day.replaceAll('-', '')}.xlsx`, bytes: await salesOverviewFile(week(from, sales))});

describe('authorize', () => {
  it('needs the exact bearer token; with no token configured it refuses everyone', () => {
    expect(authorize(new Request('https://x', {headers: authed()}), TOKEN)).toBe('ok');
    expect(authorize(new Request('https://x', {headers: {authorization: 'Bearer nope'}}), TOKEN)).toBe('denied');
    expect(authorize(new Request('https://x'), TOKEN)).toBe('denied');
    expect(authorize(new Request('https://x', {headers: authed()}), undefined)).toBe('not_configured');
    expect(authorize(new Request('https://x', {headers: authed()}), '')).toBe('not_configured');
  });
});

describe('the import API', () => {
  it('plan, apply, coverage and undo over HTTP-shaped requests', async () => {
    const d = deps();
    const planRes = await handlePlan(await planRequest([await weekFile('2026-10-12', [100, 200, 300, 400, 500, 600, 700])]), d);
    expect(planRes.status).toBe(200);
    const planned = await planRes.json();
    expect(planned.results[0]).toMatchObject({status: 'staged', newDays: 7});
    const id = planned.results[0].importId;

    const applyRes = await handleApply(json({importIds: [id]}), d);
    const applied = await applyRes.json();
    expect(applied.results[0]).toMatchObject({ok: true, receipt: {newDays: 7, loadedConfirmed: 2800, reconciled: true}});

    const cov = await (await handleCoverage(new Request('https://x', {headers: authed()}), d)).json();
    expect(cov.weeks[0]).toMatchObject({weekStart: '2026-10-12', status: 'complete'});

    const undone = await (await handleUndo(json({importId: id, reason: 'wrong export'}), d)).json();
    expect(undone.ok).toBe(true);
    expect((await (await handleCoverage(new Request('https://x', {headers: authed()}), d)).json()).weeks).toEqual([]);
  });

  it('refuses without the token, and says so plainly when none is configured', async () => {
    expect((await handlePlan(await planRequest([await weekFile('2026-10-12', [1, 2])], {}, {authorization: 'Bearer wrong'}), deps())).status).toBe(401);
    expect((await handleApply(json({importIds: ['x']}, {authorization: 'Bearer wrong'}), deps())).status).toBe(401);
    expect((await handlePlan(await planRequest([await weekFile('2026-10-12', [1, 2])]), {...deps(), token: undefined})).status).toBe(503);
  });

  it('a rejected file comes back with its reasons and writes no figures', async () => {
    const d = deps();
    const bad = {name: 'sales_overview_20261012-20261014.xlsx', bytes: await salesOverviewFile(week('2026-10-12', [100, 200, 300]), {summaryConf: 999})};
    const res = await (await handlePlan(await planRequest([bad]), d)).json();
    expect(res.results[0]).toMatchObject({status: 'rejected'});
    expect(res.results[0].failures[0].code).toBe('SUM_CONFIRMED');
    expect(d.store.obs.size).toBe(0);
  });

  it('applies only what exists and is staged, and refuses a stale or unknown plan', async () => {
    const d = deps();
    const res = await (await handleApply(json({importIds: ['missing']}), d)).json();
    expect(res.results[0]).toMatchObject({ok: false, code: 'NOT_FOUND'});
    expect((await handleApply(json({}), d)).status).toBe(400);
  });

  it('limits the request: no files, too many files, a file too large, a name it does not know', async () => {
    const d = deps();
    expect((await handlePlan(await planRequest([]), d)).status).toBe(400);
    const many = await Promise.all(Array.from({length: 31}, (_, i) => weekFile('2026-10-12', [i + 1, 2])));
    expect((await handlePlan(await planRequest(many), d)).status).toBe(413);
    const big = {name: 'sales_overview_20261012-20261018.xlsx', bytes: Buffer.alloc(6 * 1024 * 1024)};
    expect((await handlePlan(await planRequest([big]), d)).status).toBe(413);
    const odd = (await (await handlePlan(await planRequest([{name: 'notes.txt', bytes: Buffer.from('hello')}]), d)).json());
    expect(odd.results[0]).toMatchObject({status: 'unsupported'});
  });

  it('an undo needs a written reason', async () => {
    const d = deps();
    const planned = await (await handlePlan(await planRequest([await weekFile('2026-10-12', [1, 2, 3])]), d)).json();
    const id = planned.results[0].importId;
    await handleApply(json({importIds: [id]}), d);
    expect((await handleUndo(json({importId: id, reason: ''}), d)).status).toBe(400);
  });
});
