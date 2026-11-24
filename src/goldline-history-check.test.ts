import {describe, expect, it} from 'vitest';
import {historyNote, historyNotes, latestBefore} from './goldline-history-check';

const prev = (code: string, end: string, ending: number | null) => ({item_code: code, period_end: end, ending_on_hand: ending});

describe('historyNote', () => {
  it('flags an ending above the last count plus delivery', () => {
    expect(historyNote({item_code: 'A', drawer: 60, selling_area: 18, ending_on_hand: 78}, prev('A', '2026-08-31', 38), 'legacy')).toBe(
      'Ending 78 is more than the last count (38 on Aug 31) with no delivery',
    );
    expect(historyNote({item_code: 'A', stockroom: 10, ending_on_hand: 50, delivery: 5}, prev('A', '2026-08-31', 30), 'v1')).toBe(
      'Ending 50 is more than the last count (30 on Aug 31) plus delivery 5',
    );
  });
  it('accepts an ending the last count and delivery can explain', () => {
    expect(historyNote({item_code: 'A', stockroom: 10, ending_on_hand: 35, delivery: 5}, prev('A', '2026-08-31', 30), 'v1')).toBeNull();
    expect(historyNote({item_code: 'A', ending_on_hand: 3}, prev('A', '2026-08-31', 30), 'v2')).toBeNull();
  });
  it('checks a printed-layout Legacy row by its Beginning', () => {
    expect(historyNote({item_code: 'A', delivery: 5, ending_on_hand: 9, extra: {beginning: 20}}, prev('A', '2026-08-31', 12), 'legacy')).toBe(
      "Beginning 20 differs from the last count's ending (12 on Aug 31)",
    );
    expect(historyNote({item_code: 'A', delivery: 5, ending_on_hand: 9, extra: {beginning: 12}}, prev('A', '2026-08-31', 12), 'legacy')).toBeNull();
  });
  it('says nothing without a usable last count or ending', () => {
    expect(historyNote({item_code: 'A', ending_on_hand: 99}, undefined, 'v1')).toBeNull();
    expect(historyNote({item_code: 'A', ending_on_hand: 99}, prev('A', '2026-08-31', null), 'v1')).toBeNull();
    expect(historyNote({item_code: 'A', stockroom: 3}, prev('A', '2026-08-31', 1), 'v1')).toBeNull();
  });
});

describe('latestBefore / historyNotes', () => {
  it('uses the latest count that ends before this period', () => {
    const m = latestBefore([prev('A', '2026-08-15', 5), prev('A', '2026-08-31', 7), prev('A', '2026-09-15', 99)], '2026-09-01');
    expect(m.get('A')?.ending_on_hand).toBe(7);
    expect(historyNotes([{item_code: 'A', stockroom: 9, ending_on_hand: 9}, {item_code: 'B', ending_on_hand: 1}], m, 'v1')).toEqual({
      0: 'Ending 9 is more than the last count (7 on Aug 31) with no delivery',
    });
  });
});
