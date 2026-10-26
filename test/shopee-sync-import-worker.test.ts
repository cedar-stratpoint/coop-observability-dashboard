import {describe, expect, it} from 'vitest';
import {handleApply, handleCoverage, handlePlan, handleUndo} from '../src/shopee-import/api';
import {workerAuthFor} from '../src/shopee-sync/worker-auth';
import {hashSecret, newWorkerToken} from '../src/shopee-sync/tokens';
import {salesOverviewFile, week} from './support/shopee-fixture';
import {FakeStore} from './support/shopee-fake-store';
import {FakeSyncStore} from './support/shopee-sync-fake-store';

const IMPORT_TOKEN = 'import-token-0123456789';
const NOW = new Date('2026-10-27T03:00:00Z');
const bearer = (t: string) => ({authorization: `Bearer ${t}`});

async function setup() {
  const sync = new FakeSyncStore();
  const token = newWorkerToken();
  const w = await sync.createWorker({ownerEmail: 'a@x.com', name: 'm', tokenHash: hashSecret(token)}, NOW);
  const store = new FakeStore();
  return {sync, token, w, store, deps: {store, token: IMPORT_TOKEN as string | undefined, now: () => NOW, workerAuth: workerAuthFor(sync)}};
}
async function planReq(token: string, files: {name: string; bytes: Buffer}[], fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const f of files) form.append('files', new File([new Uint8Array(f.bytes)], f.name));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new Request('https://coop.example/p', {method: 'POST', body: form, headers: bearer(token)});
}
const json = (token: string, body: unknown) => new Request('https://coop.example/x', {method: 'POST', body: JSON.stringify(body), headers: {'content-type': 'application/json', ...bearer(token)}});
const daily = async () => ({name: 'sales_overview_20261012-20261018.xlsx', bytes: await salesOverviewFile(week('2026-10-12', [100, 200, 300, 400, 500, 600, 700]))});

describe('the import API with a worker token', () => {
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
  it('refuses every other report type, and the whole request if any file is one, with nothing written', async () => {
    const {token, deps, store} = await setup();
    const other = {name: 'traffic_20261012-20261018.xlsx', bytes: Buffer.from('x')};
    const res = await handlePlan(await planReq(token, [await daily(), other]), deps);
    expect(res.status).toBe(403);
    expect(store.runs).toHaveLength(0);
  });
  it('refuses to apply a run that is not a plain sales_overview, before applying any', async () => {
    const {token, deps, store} = await setup();
    const planned = await (await handlePlan(await planReq(IMPORT_TOKEN, [await daily()]), deps)).json();
    const id = planned.results[0].importId;
    store.runs.find((r) => r.importId === id)!.restated = true;
    const res = await handleApply(json(token, {importIds: [id]}), deps);
    expect(res.status).toBe(403);
    expect(store.runs.find((r) => r.importId === id)?.status).toBe('staged');
    store.runs.find((r) => r.importId === id)!.restated = false;
    store.runs.find((r) => r.importId === id)!.reportType = 'traffic';
    expect((await handleApply(json(token, {importIds: [id]}), deps)).status).toBe(403);
  });
  it('refuses undo and coverage with 403', async () => {
    const {token, deps} = await setup();
    expect((await handleUndo(json(token, {importId: 'x', reason: 'r'}), deps)).status).toBe(403);
    expect((await handleCoverage(new Request('https://x', {headers: bearer(token)}), deps)).status).toBe(403);
  });
  it('401 for an unknown or revoked worker token', async () => {
    const {token, deps, sync, w} = await setup();
    expect((await handlePlan(await planReq('zsw_unknown', [await daily()]), deps)).status).toBe(401);
    await sync.revokeWorker(w.id, NOW);
    expect((await handlePlan(await planReq(token, [await daily()]), deps)).status).toBe(401);
    expect((await handleApply(json(token, {importIds: ['x']}), deps)).status).toBe(401);
  });
  it('401 (not 503) for a bad token on a deployment with no import token but worker auth', async () => {
    const {deps} = await setup();
    expect((await handlePlan(await planReq('zsw_unknown', [await daily()]), {...deps, token: undefined})).status).toBe(401);
  });
  it('the import token keeps doing everything it did, including undo', async () => {
    const {deps} = await setup();
    const planned = await (await handlePlan(await planReq(IMPORT_TOKEN, [await daily()]), deps)).json();
    const id = planned.results[0].importId;
    await handleApply(json(IMPORT_TOKEN, {importIds: [id]}), deps);
    expect((await handleUndo(json(IMPORT_TOKEN, {importId: id, reason: 'r'}), deps)).status).toBe(200);
  });
});
