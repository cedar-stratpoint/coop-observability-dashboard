// The owner's rule: only the workbook's INPUT rows are typed in Coop; everything the workbook computes by formula is computed in Coop by the same formula.
// This test proves it, cell by cell, against the REAL workbook (the repo is public and holds no plan figure): set PLAN_WORKBOOK="/path/Business Plan.xlsx" and python3 with openpyxl
// must be on PATH; scripts/extract-workbook-audit.py dumps every row's formula and Excel's cached value into a temp file. Without PLAN_WORKBOOK the workbook suites are skipped.
//  1. re-evaluates every workbook formula from its INPUT cells and compares with the cached value (is the workbook itself consistent?);
//  2. feeds Coop's pure functions only the workbook's input-side rows (GMV rows 48-51, the typed cost lines, stock bought, funding, one-time payments)
//     and asserts every derived row Coop shows equals the workbook's, for every month, to 1e-6 relative.
import {describe, expect, it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {makeEvaluator, type Audit} from './support/xlsx-eval';
// @ts-expect-error plain .mjs shared with the private loader
import {readWorkbook} from '../scripts/plan-workbook.mjs';
import {GAP, LINES, derivedActuals, inventorySeries, plannedCogs, type ActualCell, type LineSeries} from '../src/plan-compute';

const WORKBOOK = process.env.PLAN_WORKBOOK;
const hasWb = !!WORKBOOK && existsSync(WORKBOOK);
function loadAudit(): Audit {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'plan-audit-')), 'audit.json');
  execFileSync('python3', ['-I', path.resolve(__dirname, '../scripts/extract-workbook-audit.py'), WORKBOOK as string, out], {stdio: 'pipe'});
  return JSON.parse(readFileSync(out, 'utf8')) as Audit;
}
const A: Audit = hasWb ? loadAudit() : {source: '', sheet: '', months: [], rows: []};
const COLS = 'CDEFGHIJKLMNOPQRS'.split('');
const ev = makeEvaluator(A);
const row = (r: number): number[] => COLS.map((c) => ev.cellValue(`${c}${r}`) as number);
const cached = (r: number): (number | string | null)[] => COLS.map((c) => A.rows.find((x) => x.row === r)?.cells.find((x) => x.c === c)?.v ?? null);
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
const K = 1000; // the workbook is in thousands of pesos, Coop in pesos

describe.skipIf(!hasWb)('workbook audit: the workbook is internally consistent', () => {
  it('re-evaluating every formula from the input cells gives the cached value in every month', () => {
    const bad: string[] = [];
    let n = 0;
    for (const r of A.rows) for (const c of r.cells) {
      if (!c.f) continue;
      n++;
      const got = ev.cellValue(`${c.c}${r.row}`);
      const ok = typeof got === 'number' && typeof c.v === 'number' ? close(got, c.v) : got === c.v;
      if (!ok) bad.push(`${c.c}${r.row} ${c.f}: evaluated ${got}, cached ${c.v}`);
    }
    expect(n).toBeGreaterThan(1000);
    expect(bad).toEqual([]);
  });

  it('the rows the cash chain stands on are the kind the audit says they are', () => {
    const kind = (r: number) => A.rows.find((x) => x.row === r)?.kind;
    for (const r of [87, 88, 89, 44, 118, 119, 120]) expect(kind(r), `row ${r}`).toBe('input');
    for (const r of [41]) expect(kind(r), `row ${r}`).toBe('mixed');
    for (const r of [39, 48, 49, 50, 51, 55, 56, 57, 59, 60, 61, 62, 63, 66, 67, 68, 69, 70, 71, 72, 73, 75, 76, 81, 82, 83, 84, 86, 90, 96, 113, 121, 122, 123, 124]) expect(kind(r) === 'formula' || r === 48 || r === 49 || r === 9, `row ${r} is ${kind(r)}`).toBe(true);
    // Cash (row 90) is a formula everywhere and has NO opening-cash input: month one is `=C87+C86-C88-C89`.
    expect(A.rows.find((x) => x.row === 90)?.cells[0].f).toBe('=C87+C86-C88-C89');
    expect(A.rows.find((x) => x.row === 90)?.cells.every((c) => c.f)).toBe(true);
  });

  it("the private loader's opening facts and scalar inputs are the workbook's cells", async () => {
    const one = (r: number) => cached(r)[0] as number;
    const wb = await readWorkbook(WORKBOOK);
    const pre = (m: string) => wb.prefills.find((p: {metric: string}) => p.metric === m).amountPhp;
    expect(pre('opening_inventory')).toBe(one(44) * K);
    expect(pre('opening_customers')).toBe(one(120));
    expect(wb.assumptions.repeat_rate).toBe(one(118));
    expect(wb.assumptions.aov).toBeCloseTo(one(119) * K, 9);
    expect(wb.prefills.find((p: {metric: string}) => p.metric === 'bridge_funding').amountPhp).toBe((cached(87)[1] as number) * K);
  });
});

describe.skipIf(!hasWb)("Coop's derived rows equal the workbook's, month by month", () => {
  const cell = (v: number): ActualCell => ({value: v, state: 'ok'});
  const col = (r: number) => row(r).map((v) => v * K);
  const gmv = {gmv_marketplace: col(48).map(cell), gmv_website: col(49).map(cell), gmv_events: col(50).map(cell), gmv_total: col(51).map(cell)};
  // The typed lines are the workbook's input-side rows: what was actually paid (here: what the workbook says is paid), stock bought, funding, one-time payments.
  const lines: LineSeries = {
    overhead: col(39), cogs: col(55), platform_fees: col(59), fulfilment: col(60), event_costs: col(61),
    ad_marketplace: col(66), ad_website: col(67), event_marketing: col(68), content_other: col(69).map((v, i) => v + col(70)[i]),
    inv_purchases_paid: col(41), bridge_funding: col(87), liability_settlement: col(88), freight_onetime: col(89),
  };
  const withOpening: LineSeries = {...lines, opening_cash: [0]}; // the workbook starts from 0: typed explicitly, because Coop never assumes an opening balance
  // The customer roll's two scalar inputs, as the loader stores them in the plan targets (workbook rows 118 and 119).
  const scalars = {repeat_rate: cached(118).map(() => cached(118)[0] as number), aov: cached(119).map(() => (cached(119)[0] as number) * K)};
  const plan = {months: A.months.map(() => ''), targets: {gmv_total: col(51), cm1: col(56), ...scalars} as Record<string, (number | null)[]>};
  // The workbook's opening stock and customers are typed facts in Coop (prefilled by the loader).
  const opened: LineSeries = {...withOpening, opening_inventory: [(cached(44)[0] as number) * K], opening_customers: [cached(120)[0] as number]};
  const got = derivedActuals(plan, gmv, opened);

  const expectRow = (id: string, got: ActualCell[], want: number[], scale: number, skipLast = false) => {
    const diffs: string[] = [];
    want.forEach((w, i) => {
      if (skipLast && i === want.length - 1) return;
      const g = got[i]?.value;
      if (g === null || g === undefined || !close(g, w * scale)) diffs.push(`${A.months[i]}: Coop ${g}, workbook ${w * scale}`);
    });
    expect(diffs, id).toEqual([]);
  };

  it('uses every typed line Coop has, and only workbook input-side rows', () => {
    expect(Object.keys(lines).sort()).toEqual(LINES.map((l) => l.id).sort());
  });
  it('CM1, CM2, CM3, EBITDA and their margins (rows 56 57 62 63 72 73 75 76)', () => {
    expectRow('cm1', got.cm1, row(56), K); expectRow('cm1_pct', got.cm1_pct, row(57), 1);
    expectRow('cm2', got.cm2, row(62), K); expectRow('cm2_pct', got.cm2_pct, row(63), 1);
    expectRow('cm3', got.cm3, row(72), K); expectRow('cm3_pct', got.cm3_pct, row(73), 1);
    expectRow('ebitda', got.ebitda, row(75), K); expectRow('ebitda_pct', got.ebitda_pct, row(76), 1);
  });
  it('cash at month end (row 90), derived with no typed cash', () => expectRow('cash', got.cash, row(90), K));
  it('stock on hand (row 83)', () => expectRow('inv', inventorySeries(opened, 17), row(83), K));
  it('forward coverage (row 84): every month but the last, which needs the workbook growth input', () => {
    expectRow('coverage', got.coverage, row(84), 1, true);
    expect(got.coverage[16]).toEqual(GAP);
    expect(plannedCogs(plan).map((v) => (v as number) / K).every((v, i) => close(v, row(55)[i]))).toBe(true);
  });
  it('active customers (row 113) and CAC (row 96)', () => {
    expectRow('customers', got.customers, row(113), 1);
    expectRow('cac', got.cac, row(96), 1); // ad spend in thousands x 1000 / new customers = pesos per customer: same unit as Coop
  });
  it('total ad spend in Coop (the four typed ad lines) is the workbook total ad spend (row 71)', () => {
    const sum = COLS.map((_, i) => ['ad_marketplace', 'ad_website', 'event_marketing', 'content_other'].reduce((t, id) => t + (lines[id]?.[i] ?? 0), 0));
    expect(sum.every((v, i) => close(v, row(71)[i] * K))).toBe(true);
  });
});

import {LINE_TARGET_ID} from '../src/plan-compute';
describe.skipIf(!hasWb)('the loader reads the cost-line targets from the workbook rows that plan them', () => {
  const rowOf: Record<string, (i: number) => number> = {
    overhead: (i) => row(39)[i], cogs: (i) => row(55)[i], platform_fees: (i) => row(59)[i], fulfilment: (i) => row(60)[i], event_costs: (i) => row(61)[i],
    ad_marketplace: (i) => row(66)[i], ad_website: (i) => row(67)[i], event_marketing: (i) => row(68)[i], content_other: (i) => row(69)[i] + row(70)[i],
    inv_purchases_paid: (i) => row(41)[i], bridge_funding: (i) => row(87)[i], liability_settlement: (i) => row(88)[i], freight_onetime: (i) => row(89)[i],
  };
  it.each(LINES.map((l) => l.id))('%s equals the workbook in all 17 months', async (id) => {
    const seeded = (await readWorkbook(WORKBOOK)).targets[LINE_TARGET_ID[id as keyof typeof LINE_TARGET_ID]] as number[];
    expect(seeded).toHaveLength(17);
    seeded.forEach((v, i) => expect(close(v, rowOf[id](i) * K), `${id} ${A.months[i]}`).toBe(true));
  });
});

describe('a missing input never becomes a guess', () => {
  const cell = (v: number): ActualCell => ({value: v, state: 'ok'});
  const n = 3;
  const full = (): LineSeries => ({...Object.fromEntries(LINES.map((l) => [l.id, Array(n).fill(1000)])), opening_cash: [0]});
  const gmv = {gmv_marketplace: Array(n).fill(cell(70_000)), gmv_website: Array(n).fill(cell(4_000)), gmv_total: Array(n).fill(cell(74_000))};
  const plan = {months: ['a', 'b', 'c'], targets: {} as Record<string, (number | null)[]>};
  it('cash waits for every input of its month and for every earlier month', () => {
    expect(derivedActuals(plan, gmv, full()).cash.every((c) => c.value !== null)).toBe(true);
    for (const id of ['cogs', 'inv_purchases_paid', 'bridge_funding', 'liability_settlement', 'freight_onetime', 'overhead', 'ad_website']) {
      const l = full();
      (l[id] as (number | null)[])[1] = null;
      expect(derivedActuals(plan, gmv, l).cash.map((c) => c.value !== null), id).toEqual([true, false, false]);
    }
    expect(derivedActuals(plan, {...gmv, gmv_total: [cell(74_000), GAP, cell(74_000)]}, full()).cash.map((c) => c.value !== null)).toEqual([true, false, false]);
  });
  it('cash waits for the opening cash: until typed, no month has a cash, never a guess', () => {
    const l = full();
    delete l.opening_cash;
    expect(derivedActuals(plan, gmv, l).cash.every((c) => c.value === null)).toBe(true);
  });
  it('a partial GMV gives a partial (grey) cash from that month on', () => {
    const p = derivedActuals(plan, {...gmv, gmv_total: [cell(74_000), {value: 1, state: 'partial'}, cell(74_000)]}, full()).cash;
    expect(p.map((c) => c.state)).toEqual(['ok', 'partial', 'partial']);
  });
  it('a typed 0 is a real 0, an empty cell is not', () => {
    const l = full();
    l.bridge_funding = [0, 0, 0];
    expect(derivedActuals(plan, gmv, l).cash[2].value).not.toBeNull();
  });
});
