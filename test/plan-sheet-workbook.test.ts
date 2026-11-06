// BHR-06 against the REAL workbook (the repo is public and holds no plan figure). Skipped unless PLAN_WORKBOOK points at it:
//   PLAN_WORKBOOK="/path/Business Plan.xlsx" npx vitest run test/plan-sheet-workbook.test.ts
// Needs python3 with openpyxl (scripts/extract-workbook-audit.py, as the equality test). Nothing here prints a figure.
import {describe, expect, it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {makeEvaluator, type Audit} from './support/xlsx-eval';
// @ts-expect-error plain .mjs shared with the private loader
import {readWorkbook} from '../scripts/plan-workbook.mjs';
// @ts-expect-error plain .mjs
import {buildRows} from '../scripts/seed-plan-from-workbook.mjs';
import {SHEET_ROWS, sheetActuals, targetId, unitScale} from '../src/plan-sheet';
import {derivedActuals, withTotals, type ActualCell, type LineSeries} from '../src/plan-compute';

const WORKBOOK = process.env.PLAN_WORKBOOK;
const hasWb = !!WORKBOOK && existsSync(WORKBOOK);
const A: Audit = hasWb ? (() => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'plan-sheet-')), 'audit.json');
  execFileSync('python3', ['-I', path.resolve(__dirname, '../scripts/extract-workbook-audit.py'), WORKBOOK as string, out], {stdio: 'pipe'});
  return JSON.parse(readFileSync(out, 'utf8')) as Audit;
})() : {source: '', sheet: '', months: [], rows: []};
const COLS = 'CDEFGHIJKLMNOPQRS'.split('');
const ev = makeEvaluator(A);
const audit = (r: number) => A.rows.find((x) => x.row === r);
const val = (r: number): (number | string | null)[] => COLS.map((c) => audit(r)?.cells.find((x) => x.c === c)?.v ?? null);
const num = (r: number): number[] => COLS.map((c) => ev.cellValue(`${c}${r}`) as number);
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
const K = 1000;

async function sheetLabels(): Promise<Map<number, string>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(WORKBOOK as string);
  const ws = wb.getWorksheet('Business Plan')!;
  const out = new Map<number, string>();
  for (let r = 1; r <= ws.rowCount; r++) { const v = ws.getRow(r).getCell(2).value; out.set(r, v === null || v === undefined ? '' : String(v)); }
  return out;
}

describe.skipIf(!hasWb)('AC1: the row map equals the Business Plan sheet', () => {
  it('labels and order of rows 4 to 125 are the sheet’s column B, exactly', async () => {
    const labels = await sheetLabels();
    const diffs = SHEET_ROWS.filter((r) => r.label !== labels.get(r.row)).map((r) => `row ${r.row}`);
    expect(diffs).toEqual([]);
  });
  it('rows 126 to 147 are empty and the scratch rows 148 to 152 have values but no label', async () => {
    const labels = await sheetLabels();
    for (let r = 126; r <= 147; r++) { expect(labels.get(r), `row ${r}`).toBe(''); expect(audit(r), `row ${r}`).toBeUndefined(); }
    for (let r = 148; r <= 152; r++) expect(labels.get(r), `row ${r}`).toBe('');
  });
  it('structure rows carry no value; value rows do; static and single rows hold column C only', () => {
    for (const r of SHEET_ROWS) {
      const cells = audit(r.row)?.cells ?? [];
      if (r.kind === 'header') continue;
      if (['section', 'label', 'spacer'].includes(r.kind)) expect(cells.filter((c) => typeof c.v === 'number'), `row ${r.row}`).toEqual([]);
      else expect(cells.length, `row ${r.row}`).toBeGreaterThan(0);
      if (r.kind === 'static' || r.single) expect(cells.map((c) => c.c), `row ${r.row}`).toEqual(['C']);
    }
  });
  it('the check rows hold pass/fail text whose failing word the map knows', () => {
    for (const r of SHEET_ROWS.filter((x) => x.kind === 'check')) for (const v of val(r.row)) expect(['OK', r.fail].some((w) => String(v).startsWith(w as string)), `row ${r.row}`).toBe(true);
  });
  it('row 74 is stored negative (minus row 39), every other "less:" row positive', () => {
    for (const r of SHEET_ROWS.filter((x) => x.label.startsWith('less:') && x.row < 98)) {
      const vs = num(r.row);
      if (r.row === 74) vs.forEach((v, i) => expect(close(v, -num(39)[i])).toBe(true));
      else vs.forEach((v) => expect(v, `row ${r.row}`).toBeGreaterThanOrEqual(0));
    }
  });
});

describe.skipIf(!hasWb)('AC4: the loader loads every workbook value as a target, and no actual', () => {
  it('a target series for every value row, equal to the sheet (pesos for money, 1 = OK for a check)', async () => {
    const wb = await readWorkbook(WORKBOOK);
    const bad: string[] = [];
    for (const r of SHEET_ROWS.filter((x) => x.unit)) {
      const got = wb.targets[targetId(r)] as (number | null)[] | undefined;
      if (!got || got.length !== 17) { bad.push(`row ${r.row}: missing`); continue; }
      const want = val(r.row);
      got.forEach((g, i) => {
        const w = r.kind === 'static' || r.single ? want[0] : want[i];
        const expected = w === null ? null : r.unit === 'check' ? (String(w) === 'OK' ? 1 : 0) : (w as number) * unitScale(r.unit!);
        const same = expected === null ? g === null : g !== null && close(g, expected);
        if (!same) bad.push(`row ${r.row} month ${i}`);
      });
    }
    expect(bad).toEqual([]);
  });
  it('builds no actual rows: the workbook holds targets only', async () => {
    const wb = await readWorkbook(WORKBOOK);
    expect(wb.prefills).toBeUndefined();
    expect(buildRows(wb).prefills).toBeUndefined();
  });
});

describe.skipIf(!hasWb)("the sheet's derived actual rows use the workbook's own formulas", () => {
  const cell = (v: number): ActualCell => ({value: v, state: 'ok'});
  const col = (r: number) => num(r).map((v) => v * K);
  // The typed lines are the sheet's itemised rows; their totals (39, 55, content and other) are summed by withTotals, never fed in.
  const lines: LineSeries = withTotals({
    salaries: col(33), rent: col(34), accounting: col(35), tech: col(36), growth_consultant: col(37), rnd: col(38),
    marketplace_cogs: col(52), website_cogs: col(53), events_cogs: col(54), platform_fees: col(59), fulfilment: col(60), event_costs: col(61),
    ad_marketplace: col(66), ad_website: col(67), event_marketing: col(68), content_socials: col(69), other_spend: col(70),
    inv_purchases_paid: col(41), bridge_funding: col(87), liability_settlement: col(88), freight_onetime: col(89),
    opening_cash: [0], opening_inventory: [(val(44)[0] as number) * K], opening_customers: [val(120)[0] as number],
  });
  const gmv = {gmv_marketplace: col(48).map(cell), gmv_website: col(49).map(cell), gmv_events: col(50).map(cell), gmv_total: col(51).map(cell)};
  const targets: Record<string, (number | null)[]> = {gmv_total: col(51), cm1: col(56), repeat_rate: COLS.map(() => val(118)[0] as number), aov: COLS.map(() => (val(119)[0] as number) * K), coverage: COLS.map(() => val(45)[0] as number), r103: COLS.map(() => val(103)[0] as number), r110: COLS.map(() => (val(110)[0] as number) * K)};
  const plan = {months: A.months.map(() => ''), targets};
  const actuals = hasWb ? sheetActuals(plan, {...gmv, ...derivedActuals(plan, gmv, lines)}, lines) : {};
  const rows = [8, 12, 24, 25, 26, 30, 33, 38, 39, 52, 53, 54, 55, 58, 69, 70, 71, 74, 77, 81, 83, 84, 85, 86, 90, 91, 94, 95, 113, 114, 115, 121, 122, 123, 124, 125];
  // The only months Coop cannot compute (L2: asserted, not skipped): the first month of a growth row (no month before it), the last month of forward
  // coverage and its check (the sheet divides by a COGS beyond the plan), and channel COGS % where that channel's GMV is 0 (a divide by zero).
  const zeroGmv = (r: number) => num(r).flatMap((v, i) => (v === 0 ? [i] : []));
  const NULL_MONTHS: Record<number, () => number[]> = {8: () => [0], 12: () => [0], 84: () => [16], 85: () => [16], 24: () => zeroGmv(48), 25: () => zeroGmv(49), 26: () => zeroGmv(50)};
  it.each(rows)('row %i equals the workbook in every month, and waits only where the sheet has inputs Coop does not hold', (r) => {
    const row = SHEET_ROWS.find((x) => x.row === r)!;
    const scale = row.unit === 'check' ? 1 : unitScale(row.unit!);
    const want = val(r);
    const got = actuals[r] ?? [];
    expect(got, `row ${r} has a cell per month`).toHaveLength(17);
    const nulls = got.flatMap((c, i) => (c.value === null ? [i] : []));
    expect(nulls, `row ${r} waiting months`).toEqual(NULL_MONTHS[r]?.() ?? []);
    const diffs: string[] = [];
    got.forEach((c, i) => {
      if (c.value === null) return;
      const w = row.unit === 'check' ? (String(want[i]).startsWith('OK') ? 1 : 0) : num(r)[i] * scale;
      if (!close(c.value, w)) diffs.push(`month ${i}`);
    });
    expect(diffs, `row ${r}`).toEqual([]);
  });
});

describe.skipIf(!hasWb)("M4 / L5: the row map carries the sheet's own number format", () => {
  it('fmt is the number format of the monthly cells (column C for a single value); fmtFirst is column C where it differs', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(WORKBOOK as string);
    const ws = wb.getWorksheet('Business Plan')!;
    const fmtOf = (r: number, c: string) => ws.getCell(`${c}${r}`).numFmt ?? 'General';
    const plain = (f: string | undefined) => f?.replace(/\\/g, ''); // ExcelJS drops the format code's backslash escapes; the map keeps the raw code
    const bad: string[] = [];
    for (const r of SHEET_ROWS.filter((x) => x.unit && x.unit !== 'check')) {
      const single = r.kind === 'static' || !!r.single;
      const monthly = fmtOf(r.row, single ? 'C' : 'D');
      if (plain(r.fmt) !== monthly) bad.push(`row ${r.row} fmt`);
      const first = fmtOf(r.row, 'C');
      if (plain(r.fmtFirst ?? r.fmt) !== first) bad.push(`row ${r.row} fmtFirst`);
    }
    expect(bad).toEqual([]);
  });
  it('rows 47 and 80 repeat the month headings in the sheet (L4)', () => {
    for (const r of [47, 80]) expect(SHEET_ROWS.find((x) => x.row === r)!.months, `row ${r}`).toBe(true);
    expect(SHEET_ROWS.filter((x) => x.months).map((x) => x.row)).toEqual([47, 80]);
    for (const r of [47, 80]) for (const c of COLS) expect(String(audit(r)?.cells.find((x) => x.c === c)?.f ?? ''), `${c}${r}`).toMatch(/^=?[A-Z]+(4|47)$/);
  });
});

describe.skipIf(!hasWb)('AC10: no workbook figure is committed', () => {
  it('no distinctive workbook value appears in a tracked plan file', () => {
    const root = path.resolve(__dirname, '..');
    const files = execFileSync('git', ['ls-files', 'src/plan-*', 'src/chat/catalog/catalog.json', 'scripts/*plan*', 'scripts/local-supabase/*plan*', 'supabase/plan_*', 'test/plan-*', 'components/analyst/health-report*', 'components/analyst/plan-*', 'CHANGELOG.md'], {cwd: root, encoding: 'utf8'}).split('\n').filter(Boolean);
    // distinctive = at least 4 significant digits and not a round number, in the sheet's thousands or in pesos
    const figures = new Set<string>();
    for (const r of A.rows) if (r.row >= 4 && r.row <= 125) for (const c of r.cells) if (typeof c.v === 'number') for (const x of [c.v, c.v * K]) {
      const s = String(Math.round(Math.abs(x) * 100) / 100);
      if (s.replace(/[.0]/g, '').length >= 4 && !/0{3}$/.test(s.split('.')[0])) figures.add(s);
    }
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(path.join(root, f), 'utf8').replace(/(\d)_(?=\d)/g, '$1').replace(/(\d),(?=\d{3})/g, '$1');
      for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) if (figures.has(m[0])) hits.push(`${f}: a workbook figure`);
    }
    expect(figures.size).toBeGreaterThan(100);
    expect([...new Set(hits)]).toEqual([]);
  });
});
