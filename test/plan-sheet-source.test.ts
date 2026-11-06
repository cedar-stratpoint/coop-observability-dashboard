// BHR-07: every actual line says where its number comes from (owner, 2026-11-06). type = an admin types it, auto = read from a Coop source, calc = the
// sheet's own formula over the rows above, with the typed rows it needs (feeds) so a waiting line can say what to fill. Labels only, never a figure.
import {describe, expect, it} from 'vitest';
import {SHEET_ROWS, TYPED_ROW, actualKind, actualSource, rowRefs, rowRange} from '../src/plan-sheet';

const ROWS = new Set(SHEET_ROWS.map((r) => r.row));
const actualRows = SHEET_ROWS.map((r) => r.row).filter((r) => actualKind(r) !== null);

describe('actualSource: one source per actual line', () => {
  it.each(actualRows)('row %i has exactly one source', (row) => {
    const s = actualSource(row);
    expect(s, `row ${row}`).not.toBeNull();
    expect(['type', 'auto', 'calc']).toContain(s!.kind);
    expect(s!.from.length, `row ${row}`).toBeGreaterThan(0);
  });
  it('rows with no actual line have no source', () => {
    for (const r of SHEET_ROWS.filter((x) => actualKind(x.row) === null)) expect(actualSource(r.row), `row ${r.row}`).toBeNull();
  });
  it('the type rows are exactly TYPED_ROW, plus opening cash under row 90', () => {
    const typed = actualRows.filter((r) => actualSource(r)!.kind === 'type');
    expect(typed).toEqual(Object.keys(TYPED_ROW).map(Number).sort((a, b) => a - b));
    expect(actualSource('opening_cash')).toMatchObject({kind: 'type', from: 'once'});
  });
  it('rows 48-51 are auto, each naming its source', () => {
    expect([48, 49, 50, 51].map((r) => actualSource(r))).toEqual([
      {kind: 'auto', from: 'Shopee + Lazada'}, {kind: 'auto', from: 'Website (CRM)'}, {kind: 'auto', from: 'POS events'}, {kind: 'auto', from: 'Marketplace GMV + Website GMV + Events GMV'},
    ]);
  });
  it('every other actual row is calc', () => {
    for (const r of actualRows) if (!TYPED_ROW[r] && ![48, 49, 50, 51].includes(r)) expect(actualSource(r)!.kind, `row ${r}`).toBe('calc');
  });
  it('the owner example: row 71 = rows 66-70 and needs rows 66-70; row 39 = rows 33-38', () => {
    expect(actualSource(71)).toEqual({kind: 'calc', from: '= rows 66-70', feeds: [66, 67, 68, 69, 70]});
    expect(actualSource(39)).toEqual({kind: 'calc', from: '= rows 33-38', feeds: [33, 34, 35, 36, 37, 38]});
    expect(actualSource(55)?.from).toBe('= rows 52-54');
    expect(actualSource(56)?.from).toBe('= 51 − 55');
  });
  it.each(actualRows.filter((r) => actualSource(r)?.kind === 'calc'))('row %i: every row it cites or needs exists, and it needs only typed rows', (row) => {
    const s = actualSource(row)!;
    for (const r of rowRefs(s.from)) expect(ROWS.has(r), `row ${row} cites ${r}`).toBe(true);
    expect(s.feeds, `row ${row}`).toBeDefined();
    for (const r of s.feeds!) expect(TYPED_ROW[r], `row ${row} needs ${r}`).toBeDefined();
  });
});

describe('rowRefs / rowRange: the row numbers in a formula text, and a compact list', () => {
  it('reads single rows and ranges', () => {
    expect(rowRefs('= rows 33-38')).toEqual([33, 34, 35, 36, 37, 38]);
    expect(rowRefs('= 56 − 59 − 60 − 61')).toEqual([56, 59, 60, 61]);
  });
  it('writes runs as ranges', () => {
    expect(rowRange([66, 67, 68, 69, 70])).toBe('66-70');
    expect(rowRange([33, 34, 35, 36, 37, 38, 52, 53, 54, 60])).toBe('33-38, 52-54, 60');
  });
});
