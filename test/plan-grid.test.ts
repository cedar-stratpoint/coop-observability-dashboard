import {describe, expect, it} from 'vitest';
import {assemblePlan, LINES, METRICS, REQUIRED_LINE_ORDER, stockOrderSeries} from '../src/plan-compute';
import {LINE_ROW, SHEET_ROWS, targetId} from '../src/plan-sheet';

// The All months grid IS the Business Plan sheet (src/plan-sheet.ts, BHR-06): typed lines are entered on their own sheet rows.
describe('grid row structure', () => {
  it('the lines that close a month are walked in sheet row order, each once', () => {
    expect([...REQUIRED_LINE_ORDER].sort()).toEqual(LINES.map((l) => l.id).sort());
    expect(REQUIRED_LINE_ORDER.map((id) => LINE_ROW[id].row)).toEqual([33, 34, 35, 36, 37, 38, 41, 52, 53, 54, 59, 60, 61, 66, 67, 68, 69, 70, 87, 88, 89]);
  });
  it('every metric the cards read is a row of the sheet mirror (the old Key metrics block is gone, BHR-06)', () => {
    const ids = SHEET_ROWS.filter((r) => r.unit).map(targetId);
    for (const m of METRICS) if (m.id !== 'coverage') expect(ids, m.id).toContain(m.id);
  });
});

describe('planned stock orders', () => {
  it('assemblePlan keeps the inventory purchases row', () => {
    const p = assemblePlan('v1', [{month: '2026-08-01', metric: 'inv_purchases', value: 0}, {month: '2026-09-01', metric: 'inv_purchases', value: '250000'}]);
    expect(p.targets.inv_purchases).toEqual([0, 250000]);
  });
  it('stockOrderSeries is the plan row as is, null where the plan has none (never invented)', () => {
    expect(stockOrderSeries({targets: {inv_purchases: [0, 250000, null]}})).toEqual([0, 250000, null]);
    expect(stockOrderSeries({targets: {}})).toEqual([]);
  });
});
