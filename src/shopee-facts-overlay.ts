import type {DigestArchiveRow} from './types';
import type {DailySalesRow} from './daily-sales-digests';
import {periodDays} from './custom-range';

const DAY_MS = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Every PH day from `min` to `max` inclusive. */
function eachDay(min: string, max: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(min); t <= Date.parse(max); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export type ShopeeOverlay = {row: DigestArchiveRow; published: number | null; facts: number | null};

/**
 * The weekly view's Shopee revenue, orders, units and AOV from the imported daily facts, so it agrees with the date-range view.
 * Only when EVERY day of the period has a fact (a partial week would under-report); otherwise the row is returned untouched.
 * Ads spend and ROAS have no daily source and stay as the digest published them. `published` is the digest's own revenue,
 * so the page can show "as published" when the two differ.
 */
export function overlayShopeeFacts(row: DigestArchiveRow, daily: readonly DailySalesRow[]): ShopeeOverlay {
  const published = row.digest.comparison?.shopee?.revenue ?? null;
  const untouched = {row, published, facts: null};
  const base = row.digest.comparison?.shopee;
  if (!base) return untouched;
  const {min, max} = periodDays(row.window_from, row.window_to);
  const byDay = new Map(daily.filter((r) => r.channel === 'shopee').map((r) => [r.day, r]));
  const days = eachDay(min, max);
  if (!days.length || days.some((d) => !byDay.has(d))) return untouched;
  let revenue = 0;
  let orders = 0;
  let units = 0;
  for (const d of days) {
    const r = byDay.get(d)!;
    revenue += r.revenue;
    orders += r.orders;
    units += r.units;
  }
  revenue = round2(revenue);
  const shopee = {...base, revenue, orders, units, aov: orders ? round2(revenue / orders) : base.aov};
  return {row: {...row, digest: {...row.digest, comparison: {...row.digest.comparison, shopee}}}, published, facts: revenue};
}
