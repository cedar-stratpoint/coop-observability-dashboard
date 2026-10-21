import {describe, expect, it} from 'vitest';
import {dailyRowsToDigests, type DailySalesRow} from '../src/daily-sales-digests';
import {rollupChannels} from '../src/period-rollup';

// FICTIONAL rows shaped like the backend's marketplace_daily_sales: each row says which digest run (window) wrote it.
const ph = (day: string): string => new Date(Date.parse(`${day}T00:00:00+08:00`)).toISOString();
const row = (day: string, channel: 'shopee' | 'lazada', revenue: number, from: string, to: string, captured = '2026-10-20T01:00:00Z'): DailySalesRow =>
  ({day, channel, revenue, orders: 1, units: 2, window_from: ph(from), window_to: ph(to), captured_at: captured});

describe('dailyRowsToDigests', () => {
  it('groups rows by the window that wrote them, one per-day series per channel, newest capture as created_at', () => {
    const out = dailyRowsToDigests([
      row('2026-10-12', 'shopee', 1000, '2026-10-12', '2026-10-19', '2026-10-19T01:00:00Z'),
      row('2026-10-13', 'shopee', 2000, '2026-10-12', '2026-10-19', '2026-10-19T02:00:00Z'),
      row('2026-10-12', 'lazada', 500, '2026-10-12', '2026-10-19'),
      row('2026-10-05', 'shopee', 700, '2026-10-05', '2026-10-12'),
    ]);
    expect(out).toHaveLength(2);
    const week = out.find((d) => d.window_from === ph('2026-10-12'));
    expect(week?.created_at).toBe('2026-10-20T01:00:00.000Z');
    expect(week?.digest.daily?.shopee).toEqual([{day: '2026-10-12', revenue: 1000, orders: 1, units: 2}, {day: '2026-10-13', revenue: 2000, orders: 1, units: 2}]);
    expect(week?.digest.daily?.lazada).toHaveLength(1);
  });

  it('skips a malformed row and a repeated day, never turning them into zero', () => {
    const out = dailyRowsToDigests([
      {...row('2026-10-12', 'shopee', 1000, '2026-10-12', '2026-10-19'), revenue: Number.NaN},
      {...row('13/10/2026', 'shopee', 5, '2026-10-12', '2026-10-19')},
      row('2026-10-14', 'shopee', 300, '2026-10-12', '2026-10-19'),
      row('2026-10-14', 'shopee', 999, '2026-10-12', '2026-10-19'),
    ]);
    expect(out[0].digest.daily?.shopee).toEqual([{day: '2026-10-14', revenue: 300, orders: 1, units: 2}]);
  });

  it('is empty for no rows', () => {
    expect(dailyRowsToDigests([])).toEqual([]);
  });

  it('feeds the existing rollup: days inside the saved window sum exactly, a day with no row in the window is a zero', () => {
    const digests = dailyRowsToDigests([row('2026-07-06', 'shopee', 100, '2026-07-06', '2026-07-09'), row('2026-07-07', 'shopee', 200, '2026-07-06', '2026-07-09'), row('2026-07-08', 'shopee', 300, '2026-07-06', '2026-07-09')]);
    const [b] = rollupChannels({fromDay: '2026-07-06', toDay: '2026-07-08', channels: ['shopee'], granularity: 'total', digests, website: null, offline: null});
    expect(b.channels[0]).toMatchObject({status: 'ok', revenue: 600, orders: 3});
  });
});
