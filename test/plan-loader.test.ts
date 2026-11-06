import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
// @ts-expect-error plain .mjs shared with the private loader
import {readWorkbook, SOURCE} from '../scripts/plan-workbook.mjs';
// @ts-expect-error plain .mjs
import {buildRows, urlRefusal, LABEL} from '../scripts/seed-plan-from-workbook.mjs';

// The repo is public and holds NO plan figure. Everything below is either synthetic (made-up numbers) or runs against the real workbook ONLY when
// PLAN_WORKBOOK points at it:  PLAN_WORKBOOK="/path/Business Plan.xlsx" npm test -- plan-seed
const WORKBOOK = process.env.PLAN_WORKBOOK;
const near = (a: number, b: number, tol = 1) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe('buildRows (synthetic workbook, always runs)', () => {
  const months = ['2026-08-01', '2026-09-01'];
  const rows = buildRows({
    months, targets: {gmv_total: [1, 2], coverage: [3, 3]},
    assumptions: {repeat_rate: 0.5, aov: 9},
  });
  it('makes one target row per metric and month, scalar inputs repeated for every month', () => {
    expect(rows.targetRows).toHaveLength(2 * 2 + 2 * 2);
    expect(rows.targetRows.filter((r: {metric: string}) => r.metric === 'aov').map((r: {value: number}) => r.value)).toEqual([9, 9]);
    expect(rows.targetRows.find((r: {metric: string}) => r.metric === 'coverage')?.note).toMatch(/constant/);
  });
  it('writes no part targets any more: the itemised rows are sheet rows with their own target ids (BHR-06)', () => {
    expect(rows.partRows).toBeUndefined();
  });
  it('AC4: builds no actual rows, and the loader never calls the prefill RPC (the workbook holds targets only)', () => {
    expect(rows.prefills).toBeUndefined();
    const src = readFileSync(path.resolve(__dirname, '../scripts/seed-plan-from-workbook.mjs'), 'utf8') + readFileSync(path.resolve(__dirname, '../scripts/plan-workbook.mjs'), 'utf8');
    expect(src).not.toMatch(/plan_seed_actual|plan_set_actual|from\('plan_actuals'\)|PREFILL/);
  });
  it('a target with no value in a month (a blank cell) makes no row, never a 0', () => {
    const r = buildRows({months, targets: {r19: [null, 10]}, assumptions: {}});
    expect(r.targetRows).toEqual([{month: months[1], metric: 'r19', value: 10, note: null}]);
  });
});

describe('urlRefusal: the loader writes to the local stack unless told, twice, otherwise', () => {
  it('accepts the loopback stack and refuses everything else by default', () => {
    expect(urlRefusal('http://127.0.0.1:54420', {allowHostedFlag: false, env: {}})).toBeNull();
    expect(urlRefusal('https://abc.supabase.co', {allowHostedFlag: false, env: {}})).toMatch(/not local/);
    expect(urlRefusal('https://abc.supabase.co', {allowHostedFlag: true, env: {}})).toMatch(/not local/); // the flag alone is not enough
    expect(urlRefusal('https://abc.supabase.co', {allowHostedFlag: false, env: {PLAN_LOADER_ALLOW_HOSTED: 'staging'}})).toMatch(/not local/); // nor the env alone
    expect(urlRefusal('https://abc.supabase.co', {allowHostedFlag: true, env: {PLAN_LOADER_ALLOW_HOSTED: 'staging'}})).toBeNull();
    expect(urlRefusal(undefined, {allowHostedFlag: true, env: {PLAN_LOADER_ALLOW_HOSTED: 'staging'}})).toMatch(/not set/);
    expect(LABEL).toBe('vSept26');
  });
});

describe.skipIf(!WORKBOOK || !existsSync(WORKBOOK))('the workbook reader against the real workbook (set PLAN_WORKBOOK)', () => {
  it('reads 17 months, Aug 2026 to Dec 2027, and a full series per metric', async () => {
    const wb = await readWorkbook(WORKBOOK);
    expect(wb.months).toHaveLength(17);
    expect(wb.months[0]).toBe('2026-08-01');
    expect(wb.months[16]).toBe('2027-12-01');
    for (const id of [...Object.keys(SOURCE), 'coverage', 'r33', 'r52', 'r69', 'r70']) expect(wb.targets[id], id).toHaveLength(17);
  });
  it('is internally consistent: channels sum to total, margins are ratios of GMV, overhead is a positive cost', async () => {
    const {targets: t} = await readWorkbook(WORKBOOK);
    for (let i = 0; i < 17; i++) {
      near(t.gmv_marketplace[i] + t.gmv_website[i] + t.gmv_events[i], t.gmv_total[i], 2);
      near(t.cm1[i] / t.gmv_total[i], t.cm1_pct[i], 1e-6);
      near(t.cm3[i] / t.gmv_total[i], t.cm3_pct[i], 1e-6);
      expect(t.overhead[i]).toBeGreaterThan(0);
      near(t.ebitda[i], t.cm3[i] - t.overhead[i], 2);
      near(t.gmv_total[i] - t.cogs[i], t.cm1[i], 2);
      near(t.cm1[i] - t.platform_fees[i] - t.fulfilment[i] - t.event_costs[i], t.cm2[i], 2);
      near(t.cm2[i] - t.ad_marketplace[i] - t.ad_website[i] - t.event_marketing[i] - t.r69[i] - t.r70[i], t.cm3[i], 2);
    }
    expect(new Set(t.coverage).size).toBe(1); // one constant for every month
  });
  it('the itemised rows add up to their sheet totals in every month (rows 33-38 = 39, 52-54 = 55)', async () => {
    const {targets: t} = await readWorkbook(WORKBOOK);
    for (let i = 0; i < 17; i++) {
      near(['r33', 'r34', 'r35', 'r36', 'r37', 'r38'].reduce((n, id) => n + t[id][i], 0), t.overhead[i], 1);
      near(['r52', 'r53', 'r54'].reduce((n, id) => n + t[id][i], 0), t.cogs[i], 1);
    }
  });
  it('reads the two scalar inputs of the customer roll, and no actual', async () => {
    const {prefills, assumptions} = await readWorkbook(WORKBOOK);
    expect(prefills).toBeUndefined();
    expect(Object.keys(assumptions).sort()).toEqual(['aov', 'repeat_rate']);
  });
});
