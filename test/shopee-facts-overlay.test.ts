import {describe, expect, it} from 'vitest';
import {overlayShopeeFacts} from '../src/shopee-facts-overlay';
import type {DigestArchiveRow} from '../src/types';
import type {DailySalesRow} from '../src/daily-sales-digests';

// A 3-day period, 1 to 3 March 2025 PH time (instants), with synthetic figures.
const row = {
  window_from: '2025-02-28T16:00:00.000Z',
  window_to: '2025-03-03T16:00:00.000Z',
  digest: {comparison: {shopee: {revenue: 100, orders: 4, aov: 25, units: 5, adSpend: 20, roas: 5}}},
} as unknown as DigestArchiveRow;
const fact = (day: string, revenue: number, orders: number, units: number): DailySalesRow => ({day, channel: 'shopee', revenue, orders, units, window_from: day, window_to: day, captured_at: 'x'});
const all = [fact('2025-03-01', 50, 2, 3), fact('2025-03-02', 60, 3, 4), fact('2025-03-03', 40, 1, 1)];

describe('overlayShopeeFacts', () => {
  it('replaces revenue, orders, units and AOV when every day has a fact, keeps ads', () => {
    const o = overlayShopeeFacts(row, all);
    expect(o.row.digest.comparison!.shopee).toEqual({revenue: 150, orders: 6, aov: 25, units: 8, adSpend: 20, roas: 5});
    expect(o.published).toBe(100);
    expect(o.facts).toBe(150);
  });
  it('leaves the row untouched when a day is missing', () => {
    const o = overlayShopeeFacts(row, all.slice(0, 2));
    expect(o.row).toBe(row);
    expect(o.facts).toBeNull();
  });
  it('ignores other channels and rows with no shopee comparison', () => {
    expect(overlayShopeeFacts(row, all.map((r) => ({...r, channel: 'lazada' as const}))).facts).toBeNull();
    const bare = {...row, digest: {}} as unknown as DigestArchiveRow;
    expect(overlayShopeeFacts(bare, all).row).toBe(bare);
  });
});
