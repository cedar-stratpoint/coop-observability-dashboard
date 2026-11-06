import {existsSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
// @ts-expect-error plain .mjs shared with the private loader
import {readWorkbook, SOURCE, PART_SOURCE} from '../scripts/plan-workbook.mjs';
// @ts-expect-error plain .mjs
import {buildRows, urlRefusal, LABEL} from '../scripts/seed-plan-from-workbook.mjs';

// The repo is public and holds NO plan figure. Everything below is either synthetic (made-up numbers) or runs against the real workbook ONLY when
// PLAN_WORKBOOK points at it:  PLAN_WORKBOOK="/path/Business Plan.xlsx" npm test -- plan-seed
const WORKBOOK = process.env.PLAN_WORKBOOK;
const near = (a: number, b: number, tol = 1) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe('buildRows (synthetic workbook, always runs)', () => {
  const months = ['2026-08-01', '2026-09-01'];
  const rows = buildRows({
    months, targets: {gmv_total: [1, 2], coverage: [3, 3]}, partTargets: {overhead: {salaries: [4, 5], rent: [6, 7]}},
    assumptions: {repeat_rate: 0.5, aov: 9}, prefills: [{month: months[0], metric: 'opening_inventory', amountPhp: 8, source: 'workbook'}],
  });
  it('makes one target row per metric and month, scalar inputs repeated for every month', () => {
    expect(rows.targetRows).toHaveLength(2 * 2 + 2 * 2);
    expect(rows.targetRows.filter((r: {metric: string}) => r.metric === 'aov').map((r: {value: number}) => r.value)).toEqual([9, 9]);
    expect(rows.targetRows.find((r: {metric: string}) => r.metric === 'coverage')?.note).toMatch(/constant/);
  });
  it('makes one part row per part and month, and renames the prefill amount', () => {
    expect(rows.partRows).toHaveLength(4);
    expect(rows.partRows[0]).toEqual({month: months[0], line: 'overhead', part: 'salaries', value: 4});
    expect(rows.prefills).toEqual([{month: months[0], metric: 'opening_inventory', amount: 8, source: 'workbook'}]);
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
    for (const id of [...Object.keys(SOURCE), 'content_other', 'coverage']) expect(wb.targets[id], id).toHaveLength(17);
    for (const [line, parts] of Object.entries(PART_SOURCE)) for (const part of Object.keys(parts as object)) expect(wb.partTargets[line][part], `${line}.${part}`).toHaveLength(17);
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
      near(t.cm2[i] - t.ad_marketplace[i] - t.ad_website[i] - t.event_marketing[i] - t.content_other[i], t.cm3[i], 2);
    }
    expect(new Set(t.coverage).size).toBe(1); // one constant for every month
  });
  it('the per-part targets add up to the consolidated line target in every month', async () => {
    const {targets: t, partTargets: p} = await readWorkbook(WORKBOOK);
    for (const line of Object.keys(p)) for (let i = 0; i < 17; i++) near(Object.values(p[line] as Record<string, number[]>).reduce((n, s) => n + s[i], 0), t[line][i], 1);
  });
  it('the three prefills are the opening stock, opening customers and Sep 2026 funding (owner), on the right months', async () => {
    const {prefills, assumptions} = await readWorkbook(WORKBOOK);
    expect(prefills.map((p: {month: string; metric: string; source: string}) => [p.month, p.metric, p.source])).toEqual([
      ['2026-08-01', 'opening_inventory', 'workbook'], ['2026-08-01', 'opening_customers', 'workbook'], ['2026-09-01', 'bridge_funding', 'owner'],
    ]);
    for (const p of prefills) expect(p.amountPhp).toBeGreaterThan(0);
    expect(Object.keys(assumptions).sort()).toEqual(['aov', 'repeat_rate']);
  });
});
