// BHR-06: the All months grid mirrors the Business Plan sheet as is (rows 4 to 125), every workbook value a TARGET, green/red only where
// met/not-met makes accounting sense. Synthetic numbers only (the repo is public); test/plan-sheet-workbook.test.ts checks the map against the real sheet.
import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {BAND, SHEET_ROWS, blockOf, fmtSheet, judge, sheetActuals, sheetStatus, shownRows, targetId, SHEET_TARGET_IDS, type SheetDir} from '../src/plan-sheet';
import {GAP, NEUTRAL_LINES, LINE_TARGET_ID, assemblePlan, withTotals, type ActualCell} from '../src/plan-compute';

const rowsOf = (pred: (r: (typeof SHEET_ROWS)[number]) => boolean) => SHEET_ROWS.filter(pred).map((r) => r.row);
const range = (a: number, b: number) => Array.from({length: b - a + 1}, (_, i) => a + i);
const dirOf = (row: number): SheetDir => SHEET_ROWS.find((r) => r.row === row)!.dir as SheetDir;
const ok = (value: number): ActualCell => ({value, state: 'ok'});

describe('AC1: the row map is the sheet, rows 4 to 125 in order', () => {
  it('has exactly one entry per sheet row 4..125, in order; scratch rows 148 to 152 are not in it', () => {
    expect(SHEET_ROWS.map((r) => r.row)).toEqual(range(4, 125));
    for (const r of [148, 149, 150, 151, 152]) expect(SHEET_ROWS.some((x) => x.row === r)).toBe(false);
  });
  it('section headers, label-only rows, spacers and static rows sit where the sheet has them', () => {
    expect(rowsOf((r) => r.kind === 'section')).toEqual([5, 6, 22, 47, 80, 93, 117]);
    expect(rowsOf((r) => r.kind === 'label')).toEqual([7, 11, 15, 23, 27, 32, 40, 43]);
    expect(rowsOf((r) => r.kind === 'spacer')).toEqual([21, 42, 79, 92, 97, 104, 112, 116]);
    expect(rowsOf((r) => r.kind === 'static')).toEqual([...range(98, 103), ...range(105, 111)]);
    expect(rowsOf((r) => r.kind === 'check')).toEqual([85, 91, 125]);
    expect(SHEET_ROWS[0]).toMatchObject({row: 4, kind: 'header', label: "₱'000 / month"});
  });
  it('every value row has a unit and a direction; structure rows have neither', () => {
    for (const r of SHEET_ROWS) {
      const value = ['input', 'formula', 'check', 'static'].includes(r.kind);
      expect(!!r.unit, `row ${r.row} unit`).toBe(value);
      expect(!!r.dir, `row ${r.row} dir`).toBe(value);
    }
  });
  it('blocks follow the five top sections', () => {
    expect(blockOf(5)).toBe('inputs'); expect(blockOf(46)).toBe('inputs'); expect(blockOf(47)).toBe('pnl'); expect(blockOf(79)).toBe('pnl');
    expect(blockOf(80)).toBe('cash'); expect(blockOf(93)).toBe('metrics'); expect(blockOf(117)).toBe('repeat'); expect(blockOf(125)).toBe('repeat');
  });
  it('the units the accountant flagged', () => {
    const unit = (row: number) => SHEET_ROWS.find((r) => r.row === row)!.unit;
    expect(unit(96)).toBe('peso'); expect(unit(111)).toBe('peso');
    for (const r of [105, 106, 107]) expect(unit(r)).toBe('mn');
    for (const r of [9, 13, 77, 78]) expect(unit(r)).toBe('x');
    for (const r of [16, 113, 121, 122]) expect(unit(r)).toBe('count');
    for (const r of [45, 84]) expect(unit(r)).toBe('months');
    expect(unit(51)).toBe('php');
  });
  it('a target id per value row, unique, keeping the ids the rest of the page already reads', () => {
    const ids = SHEET_ROWS.filter((r) => r.unit).map(targetId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(targetId(SHEET_ROWS.find((r) => r.row === 51)!)).toBe('gmv_total');
    expect(targetId(SHEET_ROWS.find((r) => r.row === 74)!)).toBe('r74');
    for (const id of ['gmv_total', 'cash', 'coverage', 'roas', 'aov', 'repeat_rate', 'r84', 'r103']) expect(SHEET_TARGET_IDS).toContain(id);
    // every typed line's target is a sheet row's id, so the typed block and the sheet read the same number
    for (const t of Object.values(LINE_TARGET_ID)) expect(SHEET_TARGET_IDS, t).toContain(t);
  });
  it('assemblePlan keeps every sheet target (an unknown id would be dropped)', () => {
    const p = assemblePlan('v', [{month: '2026-08-01', metric: 'r8', value: '0.5'}, {month: '2026-08-01', metric: 'r74', value: -7}]);
    expect(p.targets.r8).toEqual([0.5]);
    expect(p.targets.r74).toEqual([-7]);
  });
});

describe('AC2: the INPUTS — DRIVERS block (rows 5 to 46) is collapsed by default and expands', () => {
  it('collapsed: only its header row 5 shows; expanded: rows 5 to 46 all show, in order', () => {
    const shut = shownRows(false).map((r) => r.row);
    expect(shut).toContain(5);
    for (const r of range(6, 46)) expect(shut).not.toContain(r);
    expect(shut[0]).toBe(5);
    expect(shut[1]).toBe(47);
    const open = shownRows(true).map((r) => r.row);
    expect(open).toEqual(range(5, 125)); // row 4 is the table head
  });
});

describe('AC3: market sizing rows 98 to 111 are greyed, never judged', () => {
  it.each([...range(98, 103), ...range(105, 111)])('row %i is static with no direction', (row) => {
    expect(dirOf(row)).toBe('none');
    expect(judge('none', 1, 2, {})).toBe('none');
  });
});

describe('AC5: direction per row', () => {
  const H = [8, 12, 9, 13, 16, 17, ...range(48, 51), 56, 57, 62, 63, 72, 73, 75, 76, 78, 81, 86, 90, 94, 95, 113, 114, 115, 121, 122, 123, 124];
  const L = [10, 14, 24, 25, 26, 28, 29, 30, 31, ...range(33, 39), 58, 77, 96];
  it('higher-is-better rows', () => { for (const r of H) expect(dirOf(r), `row ${r}`).toBe('H'); });
  it('lower-is-better rows', () => { for (const r of L) expect(dirOf(r), `row ${r}`).toBe('L'); });
  it('H: green at or above target, red below', () => {
    expect(judge('H', 100, 100, {})).toBe('met');
    expect(judge('H', 100, 120, {})).toBe('met');
    expect(judge('H', 100, 99, {})).toBe('missed');
  });
  it('L: green at or below target, red above', () => {
    expect(judge('L', 100, 100, {})).toBe('met');
    expect(judge('L', 100, 80, {})).toBe('met');
    expect(judge('L', 100, 101, {})).toBe('missed');
  });
});

describe('AC6: variable cost rows are judged as % of GMV, the peso value still shown', () => {
  it('rows 52 to 55, 59 to 61 and 66 to 71 are pct_gmv', () => {
    for (const r of [...range(52, 55), ...range(59, 61), ...range(66, 71)]) expect(dirOf(r), `row ${r}`).toBe('pct_gmv');
  });
  it('a cost above its peso target is green when GMV grew more (a lower share of GMV)', () => {
    expect(judge('pct_gmv', 100, 120, {actualGmv: 2000, targetGmv: 1000})).toBe('met'); // 6% against 10%
    expect(judge('pct_gmv', 100, 80, {actualGmv: 500, targetGmv: 1000})).toBe('missed'); // 16% against 10%
    expect(judge('pct_gmv', 100, 100, {actualGmv: 1000, targetGmv: 1000})).toBe('met');
  });
  it('waits without a GMV to divide by, never red', () => {
    expect(judge('pct_gmv', 100, 120, {actualGmv: null, targetGmv: 1000})).toBe('waiting');
    expect(judge('pct_gmv', 100, 120, {actualGmv: 0, targetGmv: 1000})).toBe('waiting');
    expect(judge('pct_gmv', 100, 120, {actualGmv: 1000, targetGmv: null})).toBe('waiting');
  });
});

describe('AC7: inventory on hand and forward coverage are judged against a band around the coverage target', () => {
  it('rows 83 and 84 are band rows', () => { expect(dirOf(83)).toBe('band'); expect(dirOf(84)).toBe('band'); });
  it(`green within ±${BAND * 100}% of the coverage target, red outside it: too much stock is not green`, () => {
    expect(BAND).toBe(0.25);
    const at = (coverage: number | null) => judge('band', null, 1, {coverage, coverageTarget: 2});
    expect(at(2)).toBe('met');
    expect(at(1.5)).toBe('met');
    expect(at(2.5)).toBe('met');
    expect(at(1.49)).toBe('missed');
    expect(at(2.51)).toBe('missed');
    expect(at(6)).toBe('missed');
    expect(at(null)).toBe('waiting');
    expect(judge('band', null, 1, {coverage: 2, coverageTarget: null})).toBe('waiting');
  });
});

describe('AC8: row 74 (overhead, stored negative in the sheet) reads correctly', () => {
  it('more overhead spend is red, less is green', () => {
    expect(dirOf(74)).toBe('H');
    expect(judge(dirOf(74), -100, -120, {})).toBe('missed');
    expect(judge(dirOf(74), -100, -80, {})).toBe('met');
  });
  it('its actual is minus the typed overhead, so it mirrors the sheet sign', () => {
    const a = sheetActuals({months: ['m'], targets: {}}, {}, {overhead: [120]});
    expect(a[74][0]).toEqual(ok(-120));
    expect(a[39][0]).toEqual(ok(120));
  });
});

describe('AC9 (negative): never green or red', () => {
  const N = [41, 82, 18, 19, 20, 87, 88, 89, 44, 45, 46, 118, 119, 120, 64, 65];
  it.each(N)('row %i has no direction', (row) => expect(dirOf(row)).toBe('none'));
  it.each([85, 91, 125])('check row %i is pass/fail text, never coloured', (row) => {
    expect(dirOf(row)).toBe('pass_fail');
    expect(judge('pass_fail', 1, 0, {})).toBe('none');
  });
  it('a none row is never judged, whatever the numbers', () => {
    expect(judge('none', 100, 1e9, {})).toBe('none');
    expect(judge('none', 100, -1e9, {})).toBe('none');
  });
  it.each(['H', 'L', 'pct_gmv', 'band'] as SheetDir[])('a %s row with no actual waits, never red', (dir) => {
    expect(judge(dir, 100, null, {actualGmv: 1, targetGmv: 1, coverage: null, coverageTarget: 1})).toBe('waiting');
  });
  it('sheetStatus: a past month with no actual is waiting; current and future months are never judged', () => {
    const row = SHEET_ROWS.find((r) => r.row === 51)!;
    expect(sheetStatus({row, actual: GAP, target: 100, phase: 'past', ctx: {}})).toBe('waiting');
    expect(sheetStatus({row, actual: ok(1), target: 100, phase: 'current', ctx: {}})).toBe('live');
    expect(sheetStatus({row, actual: ok(1), target: 100, phase: 'future', ctx: {}})).toBe('future');
    expect(sheetStatus({row, actual: {value: 1, state: 'partial'}, target: 100, phase: 'past', ctx: {}})).toBe('partial');
    expect(sheetStatus({row, actual: ok(1), target: 100, phase: 'past', ctx: {}})).toBe('bad');
    expect(sheetStatus({row, actual: ok(100), target: 100, phase: 'past', ctx: {}})).toBe('ok');
    const plug = SHEET_ROWS.find((r) => r.row === 41)!;
    expect(sheetStatus({row: plug, actual: ok(1), target: 100, phase: 'past', ctx: {}})).toBe('info');
  });
  it('every never-judged typed line sits on a none row of the sheet', () => {
    const rowOfTarget = (t: string) => SHEET_ROWS.find((r) => r.unit && targetId(r) === t)!;
    for (const id of NEUTRAL_LINES) expect(rowOfTarget(LINE_TARGET_ID[id as keyof typeof LINE_TARGET_ID]).dir, id).toBe('none');
  });
});

describe('sheetActuals: each actual row uses the sheet formula on the actuals, never a guess', () => {
  const months = ['2026-08-01', '2026-09-01'];
  const plan = {months, targets: {r103: [1000, 1000], r110: [4_800_000, 4_800_000], coverage: [2, 2]} as Record<string, (number | null)[]>};
  const live = {gmv_marketplace: [ok(1000), ok(1500)], gmv_website: [ok(200), ok(100)], gmv_events: [ok(0), ok(400)], gmv_total: [ok(1300), ok(2000)], ebitda: [ok(-50), ok(30)], cm2_pct: [ok(0.4), ok(0.5)], cash: [ok(10), ok(-5)], coverage: [ok(3), GAP], customers: [ok(10), ok(20)], cac: [GAP, GAP], new_customers: [ok(10), ok(5)], repeat_gmv: [ok(100), ok(2000)], new_gmv: [ok(1100), ok(0)]};
  const lines = withTotals({marketplace_cogs: [500, 700], website_cogs: [100, null], events_cogs: [0, 200], platform_fees: [120, 80], fulfilment: [60, 32], inv_purchases_paid: [500, 0], ad_marketplace: [10, 10], ad_website: [5, 5], event_marketing: [0, 1], content_socials: [2, 3], other_spend: [1, 1], opening_inventory: [800, null], opening_customers: [10, null]});
  const a = sheetActuals(plan, live, lines);
  const v = (row: number) => a[row].map((c) => c.value);
  it('GMV growth (rows 8, 12): this month over last, the first month waits', () => {
    expect(v(8)).toEqual([null, 0.5]);
    expect(v(12)).toEqual([null, -0.5]);
  });
  it('channel COGS % (rows 24 to 26) from the typed channel COGS rows (52 to 54); a blank row waits', () => {
    expect(v(24)).toEqual([0.5, 700 / 1500]);
    expect(v(25)).toEqual([0.5, null]);
    expect(v(26)).toEqual([null, 0.5]); // events GMV 0 in Aug: no share to compute
    expect(v(52)).toEqual([500, 700]);
    expect(v(55)).toEqual([600, null]); // the total waits for the blank website row
    expect(v(69)).toEqual([2, 3]);
  });
  it('take % and fulfilment % divide by marketplace + website GMV (rows 58, 30)', () => {
    expect(v(58)).toEqual([0.1, 0.05]);
    expect(v(30)).toEqual([0.05, 0.02]);
  });
  it('total ad spend (71), break-even ROAS (77), operating and net cash flow (81, 86), MRR and ARR (94, 95)', () => {
    expect(v(71)).toEqual([18, 20]); // marketplace + website + events ads + content and other (69 + 70)
    expect(v(77)).toEqual([2.5, 2]);
    expect(v(81)).toEqual([-50, 30]);
    expect(v(86)).toEqual([-50 + 600 - 500, null]); // Sep total COGS waits
    expect(v(94)).toEqual([1300, 2000]);
    expect(v(95)).toEqual([15600, 24000]);
  });
  it('penetration rows divide by the plan market sizing (114 by row 103, 115 by row 110)', () => {
    expect(v(114)).toEqual([0.01, 0.02]);
    expect(v(115)).toEqual([0.00325, 0.005]);
  });
  it('the checks pass or fail on the actuals (85 coverage ≥ target, 91 cash ≥ 0, 125 repeat GMV within marketplace + website)', () => {
    expect(v(85)).toEqual([1, null]);
    expect(v(91)).toEqual([1, 0]);
    expect(v(125)).toEqual([1, 0]);
    expect(fmtSheet('check', 1, 'LOW')).toBe('OK');
    expect(fmtSheet('check', 0, 'LOW')).toBe('LOW');
  });
  it('opening balances live on the first month only (44, 120); the stock bought is typed on row 41, and row 82 (the plug, = row 41) shows its target only', () => {
    expect(v(44)).toEqual([800, null]);
    expect(v(120)).toEqual([10, null]);
    expect(v(41)).toEqual([500, 0]);
    expect(a[82]).toBeUndefined();
  });
  it('rows with no actual source have no actual row (paid share, events count, memo rows, market sizing, settings)', () => {
    for (const r of [10, 14, 16, 17, 64, 65, 78, 45, 98, 118]) expect(a[r], `row ${r}`).toBeUndefined();
  });
  it('a partial input makes the derived cell partial (grey), never judged', () => {
    const p = sheetActuals(plan, {...live, gmv_total: [{value: 1300, state: 'partial'}, ok(2000)]}, lines);
    expect(p[94][0].state).toBe('partial');
  });
});

describe('fmtSheet', () => {
  it('formats the extra units', () => {
    expect(fmtSheet('mn', 12_345)).toBe('₱12,345mn');
    expect(fmtSheet('num', 0.5)).toBe('0.5');
    expect(fmtSheet('php', 1_500_000)).toBe('₱1,500k');
    expect(fmtSheet('pct', null)).toBe('—');
  });
});

describe('AC10: the repo holds labels only', () => {
  it('the row map file has no number other than row numbers', () => {
    const raw = readFileSync(path.resolve(__dirname, '../src/plan-sheet.json'), 'utf8');
    const withoutRows = raw.replace(/"row": \d+/g, '');
    // digits left may only be inside labels (years, "row 13"), never a value field
    for (const r of JSON.parse(raw) as Record<string, unknown>[]) for (const [k, val] of Object.entries(r)) if (k !== 'row') expect(typeof val === 'number', `row ${r.row} ${k}`).toBe(false);
    expect(withoutRows).not.toMatch(/:\s*-?\d/);
  });
});
