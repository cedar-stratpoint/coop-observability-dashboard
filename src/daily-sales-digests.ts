// The backend's marketplace_daily_sales rows (one per PH day per channel) shaped as digests carrying `daily`, so the existing
// rollup merges them with the stored digests unchanged: newest run wins per day, and a day inside a run's window with no row is a zero.
// Rows are grouped by the run window that wrote them, because that window is what says which days the run covered. Pure.
import type {RollupDigest} from './period-rollup';

export type DailySalesRow = {day: string; channel: 'shopee' | 'lazada'; revenue: number; orders: number; units: number; window_from: string; window_to: string; captured_at: string};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
type Day = {day: string; revenue: number; orders: number; units: number};
const usable = (r: DailySalesRow): boolean =>
  (r.channel === 'shopee' || r.channel === 'lazada') && DAY_RE.test(r.day) && [r.revenue, r.orders, r.units].every(Number.isFinite) && Number.isFinite(Date.parse(r.window_from)) && Number.isFinite(Date.parse(r.window_to));

export function dailyRowsToDigests(rows: readonly DailySalesRow[]): RollupDigest[] {
  const groups = new Map<string, {from: string; to: string; at: number; daily: {shopee: Map<string, Day>; lazada: Map<string, Day>}}>();
  for (const r of rows) {
    if (!usable(r)) continue;
    const from = new Date(r.window_from).toISOString();
    const to = new Date(r.window_to).toISOString();
    const g = groups.get(`${from}|${to}`) ?? {from, to, at: 0, daily: {shopee: new Map<string, Day>(), lazada: new Map<string, Day>()}};
    g.at = Math.max(g.at, Date.parse(r.captured_at) || 0);
    if (!g.daily[r.channel].has(r.day)) g.daily[r.channel].set(r.day, {day: r.day, revenue: r.revenue, orders: r.orders, units: r.units});
    groups.set(`${from}|${to}`, g);
  }
  return [...groups.values()].map((g) => {
    const daily: NonNullable<RollupDigest['digest']['daily']> = {};
    for (const c of ['shopee', 'lazada'] as const) if (g.daily[c].size) daily[c] = [...g.daily[c].values()].sort((a, b) => (a.day < b.day ? -1 : 1));
    return {source: 'daily_rows' as const, window_from: g.from, window_to: g.to, created_at: new Date(g.at).toISOString(), digest: {daily}};
  });
}
