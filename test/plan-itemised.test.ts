// BHR-06 owner correction (2026-11-06): where the Business Plan sheet itemises a cost, Coop does too. Each sheet row is its own typed line with its own
// target (overhead rows 33 to 38, COGS by channel 52 to 54, content and other 69 and 70); the parent (row 39 overhead, row 55 COGS, content and other)
// is the SUM of its rows, computed, never typed. A blank row waits and leaves its total waiting, never 0. Synthetic numbers only.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {GAP, LINES, LINE_TARGET_ID, REQUIRED_COUNT, REQUIRED_LINE_ORDER, TOTAL_LINES, monthComplete, nextEmptyLine, validateLine, withTotals} from '../src/plan-compute';
import {SHEET_ROWS, sheetActuals, targetId} from '../src/plan-sheet';

const OVERHEAD = ['salaries', 'rent', 'accounting', 'tech', 'growth_consultant', 'rnd'];
const COGS = ['marketplace_cogs', 'website_cogs', 'events_cogs'];
const CONTENT = ['content_socials', 'other_spend'];
const rowOfLine = (id: string) => SHEET_ROWS.find((r) => r.unit && targetId(r) === LINE_TARGET_ID[id as keyof typeof LINE_TARGET_ID])?.row;

describe('the itemised rows are typed lines, each with its own sheet row and target', () => {
  it('overhead is typed as rows 33 to 38, COGS by channel as rows 52 to 54, content and other as rows 69 and 70', () => {
    expect(OVERHEAD.map(rowOfLine)).toEqual([33, 34, 35, 36, 37, 38]);
    expect(COGS.map(rowOfLine)).toEqual([52, 53, 54]);
    expect(CONTENT.map(rowOfLine)).toEqual([69, 70]);
  });
  it('every typed line sits on its own sheet row, and Fill in / Enter walk them in sheet order', () => {
    for (const l of LINES) expect(rowOfLine(l.id), l.id).toBeDefined();
    const rows = REQUIRED_LINE_ORDER.map(rowOfLine) as number[];
    expect(rows).toEqual([...rows].sort((a, b) => a - b));
  });
  it('the parents are not typeable: not a line, rejected by validateLine and by the save RPC', () => {
    for (const parent of ['overhead', 'cogs', 'content_other']) {
      expect(LINES.map((l) => l.id), parent).not.toContain(parent);
      expect(validateLine(parent, 1), parent).toBe('Unknown line.');
    }
    for (const child of [...OVERHEAD, ...COGS, ...CONTENT]) expect(validateLine(child, 1), child).toBeNull();
    const sql = readFileSync(path.resolve(__dirname, '../supabase/plan_report.sql'), 'utf8');
    const allowed = /p_metric not in \(([^)]*)\)/.exec(sql)![1];
    for (const parent of ['overhead', 'cogs', 'content_other']) expect(allowed).not.toContain(`'${parent}'`);
    for (const child of [...OVERHEAD, ...COGS, ...CONTENT]) expect(allowed).toContain(`'${child}'`);
  });
});

describe('Close month needs the itemised rows, not the parent', () => {
  it('21 required lines: the 11 itemised rows and the 10 other inputs', () => {
    expect(REQUIRED_COUNT).toBe(21);
    expect(REQUIRED_LINE_ORDER.slice(0, 6)).toEqual(OVERHEAD);
    const all = Object.fromEntries(LINES.map((l) => [l.id, [0]]));
    expect(monthComplete(all, 0)).toBe(true);
    expect(monthComplete({...all, rent: [null]}, 0)).toBe(false);
    expect(monthComplete({...all, rent: [null], overhead: [100]} as never, 0)).toBe(false); // a parent value never stands in for its rows
    expect(nextEmptyLine({...all, rent: [null]}, 0)).toBe('rent');
  });
  it('the close RPC counts the 21 itemised lines', () => {
    const sql = readFileSync(path.resolve(__dirname, '../supabase/plan_report.sql'), 'utf8');
    const close = sql.slice(sql.indexOf('create or replace function public.plan_close_month'));
    const list = /metric in \(([^)]*)\)/.exec(close)![1];
    expect(list.split(',').map((s) => s.trim().replace(/'/g, '')).sort()).toEqual(LINES.map((l) => l.id).sort());
    expect(close).toMatch(/if n < 21 then raise exception 'month_incomplete'/);
  });
});

describe('withTotals: the parent is the sum of its rows, or waits', () => {
  it('declares the three totals and their rows', () => {
    expect(TOTAL_LINES).toEqual({overhead: OVERHEAD, cogs: COGS, content_other: CONTENT});
  });
  it('row 39 = the sum of rows 33 to 38; a typed 0 is a real 0', () => {
    const t = withTotals({salaries: [100, 0], rent: [20, 0], accounting: [5, 0], tech: [3, 0], growth_consultant: [2, 0], rnd: [10, 0]});
    expect(t.overhead).toEqual([140, 0]);
  });
  it('a blank row leaves the total waiting, never 0, and never borrows a stored parent value', () => {
    const t = withTotals({salaries: [100], rent: [null], accounting: [5], tech: [3], growth_consultant: [2], rnd: [10], overhead: [999]} as never);
    expect(t.overhead).toEqual([null]);
    expect(withTotals({}).cogs).toEqual([]);
    expect(withTotals({marketplace_cogs: [1, 2], website_cogs: [1, null], events_cogs: [0, 0]}).cogs).toEqual([2, null]);
  });
});

describe('the sheet mirror shows each itemised row and the computed total', () => {
  const lines = withTotals({salaries: [100, 100], rent: [20, null], accounting: [5, 5], tech: [3, 3], growth_consultant: [2, 2], rnd: [10, 10], marketplace_cogs: [50, 50], website_cogs: [10, 10], events_cogs: [0, 0], content_socials: [4, 4], other_spend: [1, 1]});
  const a = sheetActuals({months: ['a', 'b'], targets: {}}, {gmv_marketplace: [{value: 500, state: 'ok'}, {value: 500, state: 'ok'}]}, lines);
  it('rows 33 to 38 are their own actuals; a blank one waits', () => {
    expect(a[33].map((c) => c.value)).toEqual([100, 100]);
    expect(a[34][1]).toEqual(GAP);
  });
  it('row 39 is the sum, waiting when a row is blank; row 74 follows it', () => {
    expect(a[39].map((c) => c.value)).toEqual([140, null]);
    expect(a[74].map((c) => c.value)).toEqual([-140, null]);
  });
  it('row 55 total COGS, rows 52 to 54 by channel, row 24 the channel share; rows 69 and 70', () => {
    expect(a[55].map((c) => c.value)).toEqual([60, 60]);
    expect(a[52].map((c) => c.value)).toEqual([50, 50]);
    expect(a[24].map((c) => c.value)).toEqual([0.1, 0.1]);
    expect(a[69].map((c) => c.value)).toEqual([4, 4]);
    expect(a[70].map((c) => c.value)).toEqual([1, 1]);
  });
});
