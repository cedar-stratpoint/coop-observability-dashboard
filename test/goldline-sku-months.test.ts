import {describe, expect, it} from 'vitest';
import {allMonths, monthLabel, monthRows, presence, presenceText, spread, type SkuMonths} from '../src/goldline-sku-months';

const m = (i: number) => `2025-${String(i).padStart(2, '0')}-01`;
const every = (n: number) => Array.from({length: n}, (_, i) => [m(i + 1), 10, 3] as [string, number, number]);

describe('Watsons SKUs month by month', () => {
  const data: SkuMonths = {
    A: every(12),
    B: every(12).slice(2), // months 3 to 12
    C: [[m(12), 0, 1]], // one month only
    D: every(12).slice(0, 5), // months 1 to 5
  };

  it('labels months and lists them in order', () => {
    expect(monthLabel('2025-12-01')).toBe('Dec 2025');
    expect(allMonths(data)).toHaveLength(12);
    expect(allMonths(data)[0]).toBe('2025-01-01');
  });

  it('says where a SKU shows up', () => {
    expect(presence(data.C)).toEqual({count: 1, first: m(12), last: m(12), only: true});
    expect(presenceText(presence(data.C)!, 12)).toBe('Only in Dec 2025');
    expect(presenceText(presence(data.B)!, 12)).toBe('In 10 of 12 months');
    expect(presence(undefined)).toBeNull();
  });

  it('counts SKUs per file, first seen and last seen', () => {
    const rows = monthRows(data);
    expect(rows[0]).toEqual({month: m(1), skus: 2, firstSeen: 2, lastSeen: 0});
    expect(rows[2]).toMatchObject({month: m(3), firstSeen: 1});
    expect(rows[4]).toMatchObject({month: m(5), lastSeen: 1});
    expect(rows[11]).toEqual({month: m(12), skus: 3, firstSeen: 1, lastSeen: 3});
  });

  it('groups SKUs by how many files they are in', () => {
    expect(spread(data).map((s) => [s.label, s.skus])).toEqual([
      ['All 12 months', 1],
      ['9 to 11 months', 1],
      ['2 to 8 months', 1],
      ['Only 1 month', 1],
    ]);
  });
});
