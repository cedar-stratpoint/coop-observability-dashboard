// BHR-06 review fixes (2026-11-06). Synthetic numbers only (the repo is public).
// H1 each variable cost is judged on the base that drives it in the sheet formula (AC6). H2 modelled rows are never green or red (AC5).
// L1 an actual equal to its target is met (no float noise). L3 row 77 shows a negative break-even ROAS. M4 / L5 values use the sheet's number format.
import {describe, expect, it} from 'vitest';
import {SHEET_ROWS, fmtCell, judge, sheetActuals, sheetCtx, sheetStatus, type SheetRow} from '../src/plan-sheet';
import {METRICS, type ActualCell} from '../src/plan-compute';

const row = (n: number): SheetRow => SHEET_ROWS.find((r) => r.row === n)!;
const ok = (value: number): ActualCell => ({value, state: 'ok'});
const status = (n: number, actual: number, target: number, ctx = {}) => sheetStatus({row: row(n), actual: ok(actual), target, phase: 'past', ctx});

describe('H1 / AC6: each variable cost is judged on the base that drives it in the sheet formula', () => {
  it.each([
    [52, ['gmv_marketplace']], [66, ['gmv_marketplace']],
    [53, ['gmv_website']], [67, ['gmv_website']],
    [54, ['gmv_events']],
    [59, ['gmv_marketplace', 'gmv_website']], [60, ['gmv_marketplace', 'gmv_website']],
    [61, ['r16']], [68, ['r16']],
    [55, ['gmv_total']], [71, ['gmv_total']],
  ])('row %i is a share of %j', (n, per) => {
    expect(row(n).dir).toBe('pct_gmv');
    expect(row(n).per).toEqual(per);
  });
  it('rows 69 and 70 are fixed budgets: lower is better, in pesos, whatever GMV did', () => {
    for (const n of [69, 70]) {
      expect(row(n).dir, `row ${n}`).toBe('L');
      expect(row(n).per, `row ${n}`).toBeUndefined();
      expect(status(n, 13, 12)).toBe('bad');
      expect(status(n, 12, 12)).toBe('ok');
    }
  });
  it('every pct_gmv row names its base; no other row does', () => {
    for (const r of SHEET_ROWS) expect(!!r.per, `row ${r.row}`).toBe(r.dir === 'pct_gmv');
  });

  const months = ['2026-08-01'];
  const plan = {months, targets: {gmv_marketplace: [1000], gmv_website: [500], gmv_events: [200], gmv_total: [1700], r16: [2]} as Record<string, (number | null)[]>};
  // Marketplace GMV on plan, website far above plan: Total GMV is above plan, marketplace is not.
  const actuals: Record<string, ActualCell[]> = {gmv_marketplace: [ok(1000)], gmv_website: [ok(3000)], gmv_events: [ok(200)], gmv_total: [ok(4200)]};
  it('sheetCtx sums the row base from the actuals and the targets of the same month', () => {
    expect(sheetCtx(row(52), plan, actuals, 0)).toMatchObject({actualBase: 1000, targetBase: 1000});
    expect(sheetCtx(row(59), plan, actuals, 0)).toMatchObject({actualBase: 4000, targetBase: 1500});
    expect(sheetCtx(row(54), plan, actuals, 0)).toMatchObject({actualBase: 200, targetBase: 200});
    expect(sheetCtx(row(55), plan, actuals, 0)).toMatchObject({actualBase: 4200, targetBase: 1700});
  });
  it('marketplace COGS above its share of MARKETPLACE GMV is red, even though Total GMV grew', () => {
    // target 10% of marketplace GMV; actual 11% of marketplace GMV (but only 2.6% of Total GMV)
    expect(status(52, 110, 100, sheetCtx(row(52), plan, actuals, 0))).toBe('bad');
    expect(status(52, 100, 100, sheetCtx(row(52), plan, actuals, 0))).toBe('ok');
  });
  it('website ad spend is judged on website GMV', () => {
    expect(status(67, 250, 100, sheetCtx(row(67), plan, actuals, 0))).toBe('ok'); // 8.3% against 20%
  });
  it('a partial or missing base waits, never red', () => {
    const partial = {...actuals, gmv_marketplace: [{value: 900, state: 'partial'} as ActualCell]};
    expect(sheetCtx(row(52), plan, partial, 0).actualBase).toBeNull();
    expect(status(52, 999, 100, sheetCtx(row(52), plan, partial, 0))).toBe('waiting');
    expect(status(59, 999, 100, sheetCtx(row(59), plan, {...actuals, gmv_website: []}, 0))).toBe('waiting');
    expect(status(54, 999, 100, sheetCtx(row(54), plan, {...actuals, gmv_events: [ok(0)]}, 0))).toBe('waiting');
  });
  it('rows 61 and 68 are per event: cost per actual event against cost per planned event; no event count yet = waiting', () => {
    expect(status(61, 30, 30, sheetCtx(row(61), plan, actuals, 0))).toBe('waiting'); // Coop has no actual event count
    const withCount = {...actuals, r16: [ok(3)]};
    expect(sheetCtx(row(61), plan, withCount, 0)).toMatchObject({actualBase: 3, targetBase: 2});
    expect(status(61, 45, 30, sheetCtx(row(61), plan, withCount, 0))).toBe('ok'); // 15 per event against 15
    expect(status(68, 46, 30, sheetCtx(row(68), plan, withCount, 0))).toBe('bad');
  });
});

describe('H2 / AC5: CAC and the customer rows are modelled, shown but never green or red', () => {
  const MODELLED = [96, 113, 114, 121, 122, 123, 124];
  it.each(MODELLED)('row %i is modelled and its past actual is grey', (n) => {
    expect(row(n).modelled, `row ${n}`).toBe(true);
    expect(status(n, 1, 100)).toBe('modelled');
    expect(status(n, 1000, 100)).toBe('modelled');
  });
  it('no other row is modelled (revenue penetration, row 115, is on real GMV)', () => {
    expect(SHEET_ROWS.filter((r) => r.modelled).map((r) => r.row)).toEqual(MODELLED);
    expect(status(115, 1, 100)).toBe('bad');
  });
  it('agrees with the tiles: every modelled metric sits on a modelled sheet row', () => {
    for (const m of METRICS.filter((x) => x.modelled)) expect(SHEET_ROWS.find((r) => r.id === m.id)?.modelled, m.id).toBe(true);
  });
  it('a modelled row still waits, and is live in the month in progress', () => {
    expect(sheetStatus({row: row(113), actual: {value: null, state: 'gap'}, target: 1, phase: 'past', ctx: {}})).toBe('waiting');
    expect(sheetStatus({row: row(113), actual: ok(1), target: 1, phase: 'current', ctx: {}})).toBe('live');
  });
});

describe('L1: equal to target is met, whatever the float noise', () => {
  it('H and L rows', () => {
    expect(judge('H', 0.1 + 0.2, 0.3, {})).toBe('met');
    expect(judge('L', 0.3, 0.1 + 0.2, {})).toBe('met');
    expect(judge('L', 300_000.1 + 0.2, 300_000.3, {})).toBe('met');
    expect(judge('H', 100, 99.99, {})).toBe('missed');
  });
});

describe('L3: row 77 shows the break-even ROAS the sheet shows, negative included', () => {
  const a = sheetActuals({months: ['a', 'b', 'c'], targets: {}}, {cm2_pct: [ok(-0.25), ok(0), ok(0.5)]}, {});
  it('1 ÷ CM2 %: negative when CM2 is negative, waiting only on a divide by zero', () => {
    expect(a[77].map((c) => c.value)).toEqual([-4, null, 2]);
  });
  it('a negative break-even ROAS is red: no ROAS breaks even', () => {
    expect(status(77, -4, 3.2)).toBe('bad');
    expect(status(77, 2, 3.2)).toBe('ok');
  });
});

describe("M4 / L5: values use the sheet's own number format per row", () => {
  it('money rows: thousands with one decimal, as the sheet (₱\'000 head)', () => {
    expect(fmtCell(row(51), 1_234_500)).toBe('1,234.5');
    expect(fmtCell(row(51), 0)).toBe('0.0');
    expect(fmtCell(row(75), -1_234_560)).toBe('−1,234.6');
    expect(fmtCell(row(44), 420_000)).toBe('420'); // General
  });
  it('coverage rows 45, 84 and the check 85 do not contradict', () => {
    expect(fmtCell(row(84), 1.6)).toBe('1.60 mo');
    expect(fmtCell(row(84), 1.556)).toBe('1.56 mo');
    expect(fmtCell(row(45), 1.6)).toBe('1.6');
    const c = sheetActuals({months: ['a'], targets: {coverage: [2.1]}}, {coverage: [ok(0.7 * 3)]}, {}); // 2.0999999999999996 against 2.1
    expect(fmtCell(row(84), c[84][0].value)).toBe('2.10 mo');
    expect(fmtCell(row(85), c[85][0].value)).toBe('OK');
  });
  it('percent, multiple and count rows', () => {
    expect(fmtCell(row(57), 0.4567)).toBe('45.7%');
    expect(fmtCell(row(114), 0.001234)).toBe('0.123%');
    expect(fmtCell(row(9), 3.2)).toBe('3.20x');
    expect(fmtCell(row(113), 1234.6)).toBe('1,235');
    expect(fmtCell(row(96), 1234.56)).toBe('1,234.6');
    expect(fmtCell(row(51), null)).toBe('—');
  });
  it('row 46: the first month is the buffer in months (0.0), later months the sheet shows as a percent (0.00%)', () => {
    expect(fmtCell(row(46), 0.7, 0)).toBe('0.7');
    expect(fmtCell(row(46), 0.0588, 1)).toBe('5.88%');
  });
  it('every value row carries a format; only row 46 has a different first month', () => {
    for (const r of SHEET_ROWS.filter((x) => x.unit && x.unit !== 'check')) expect(r.fmt, `row ${r.row}`).toBeTruthy();
    expect(SHEET_ROWS.filter((r) => r.fmtFirst).map((r) => r.row)).toEqual([46]);
  });
});
