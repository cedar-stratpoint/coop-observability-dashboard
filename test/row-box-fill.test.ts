import {describe, expect, it} from 'vitest';
import {estimateRowBoxes} from '../src/row-box-fill';

// Lines of 0.01: heading A, A1..A4, heading B, B1..B3, then SOLO (one line, no bar of its own), heading C, C1.
const heads: Record<string, string> = {A1: 'A', A2: 'A', A3: 'A', A4: 'A', B1: 'B', B2: 'B', B3: 'B', SOLO: 'Solo item', C1: 'C'};
const at = (line: number) => ({y_top: 0.1 + line * 0.01, y_bottom: 0.1 + line * 0.01 + 0.008});
const page = () => [['A1', 1], ['A2', 2], ['A3', 3], ['A4', 4], ['B1', 6], ['B2', 7], ['B3', 8], ['SOLO', 9], ['C1', 11]].map(([c, l]) => ({item_code: c as string, box: at(l as number) as ReturnType<typeof at> | null}));
const est = (rows: ReturnType<typeof page>) => estimateRowBoxes(rows, (c) => heads[c], (c) => (c === 'SOLO' ? 'Solo item' : c));

describe('estimateRowBoxes', () => {
  it('places missing rows by counting printed lines, heading bars included', () => {
    for (const i of [0, 2, 4, 5, 7, 8]) {
      const rows = page(); const real = rows[i].box!; rows[i].box = null;
      expect(est(rows)[i].y_top).toBeCloseTo(real.y_top, 6);
    }
  });
  it('places several missing rows in a run', () => {
    const rows = page(); const [a, b] = [rows[4].box!, rows[5].box!]; rows[4].box = rows[5].box = null;
    expect([est(rows)[4].y_top, est(rows)[5].y_top].map((y) => y.toFixed(4))).toEqual([a.y_top.toFixed(4), b.y_top.toFixed(4)]);
  });
  it('never guesses with too few located rows, or between oddly spaced ones', () => {
    expect(est(page())).toEqual({});
    const none = page().map((r) => ({...r, box: null as ReturnType<typeof at> | null}));
    expect(est(none)).toEqual({});
    const odd = page(); odd[5].box = null; for (const i of [6, 7, 8]) odd[i].box = {y_top: odd[i].box!.y_top + 0.2, y_bottom: odd[i].box!.y_bottom + 0.2};
    expect(est(odd)[5]).toBeUndefined();
  });
});
