// The imported weekly Shopee ads and SKU reports shaped as stored digests, so the Sales page's ad-spend and top-product readers (span-windows.ts)
// take them unchanged: a week counts only when it sits whole inside the chosen dates, and the newest run wins over an overlapping digest window.
// Also the plain-language coverage notes for the product list. Pure.
import type {WindowDigest} from './span-windows';
import type {DailySalesRow} from './daily-sales-digests';
import {rangeLabel} from './chat/range';

export type AdsWeekRow = {period_from: string; period_to: string; captured_at: string; gmv: number; expense: number};
export type SkuWeekRow = {period_from: string; period_to: string; captured_at: string; product: string; variation_id: string | null; sales_confirmed: number; units_confirmed: number};

const DAY_MS = 86_400_000;
const instant = (day: string): string => new Date(Date.parse(`${day}T00:00:00+08:00`)).toISOString();
const dayAfter = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
const round2 = (n: number): number => Math.round(n * 100) / 100;
const loose = (digest: unknown): WindowDigest['digest'] => digest as WindowDigest['digest'];
const shell = (period_from: string, period_to: string, captured_at: string) => ({window_from: instant(period_from), window_to: instant(dayAfter(period_to)), created_at: new Date(captured_at).toISOString()});

function groups<T extends {period_from: string; period_to: string; captured_at: string}>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) out.set(`${r.period_from}|${r.period_to}`, [...(out.get(`${r.period_from}|${r.period_to}`) ?? []), r]);
  return out;
}

/** One digest per imported ads week: spend is the sum of the campaigns' expense, ROAS is their ad revenue over that spend (never an average of ratios). */
export function adsWeeksToDigests(rows: readonly AdsWeekRow[]): WindowDigest[] {
  return [...groups(rows).values()].map((g) => {
    const spend = round2(g.reduce((s, r) => s + Number(r.expense), 0));
    const adRevenue = g.reduce((s, r) => s + Number(r.gmv), 0);
    const {period_from: from, period_to: to, captured_at} = g[0];
    const facet = {headline: '', figures: [], recommendations: [], window: {from, to, label: rangeLabel(from, to)}};
    return {
      ...shell(from, to, captured_at),
      digest: loose({
        comparison: {shopee: {revenue: null, orders: null, aov: null, units: null, adSpend: spend, roas: spend > 0 ? round2(adRevenue / spend) : null}},
        shopee: {ads: facet},
      }),
    };
  });
}

/** One digest per imported SKU week: the product-level rows (not the variation rows under them) as that week's product ranking. */
export function skuWeeksToDigests(rows: readonly SkuWeekRow[]): WindowDigest[] {
  return [...groups(rows).values()].map((g) => {
    const {period_from: from, period_to: to, captured_at} = g[0];
    const topProducts = g.filter((r) => r.variation_id === null).map((r) => ({title: r.product, revenue: Number(r.sales_confirmed), units: Number(r.units_confirmed)}));
    return {...shell(from, to, captured_at), digest: loose({shopee: {sales: {headline: '', figures: [], recommendations: [], window: {from, to, label: rangeLabel(from, to)}, topProducts}}})};
  });
}

/**
 * For each imported SKU week fully inside [fromDay, toDay]: how much of the shop's confirmed sales its product list accounts for (known only when every
 * day of the week has a sales figure). One note when any week is below 100%, so a product ranking is never read as the whole week.
 */
export function skuCoverageNotes(rows: readonly SkuWeekRow[], daily: readonly DailySalesRow[], fromDay: string, toDay: string): string[] {
  const shop = new Map(daily.filter((d) => d.channel === 'shopee').map((d) => [d.day, d.revenue]));
  const parts: string[] = [];
  for (const g of groups(rows).values()) {
    const {period_from: from, period_to: to} = g[0];
    if (from < fromDay || to > toDay) continue;
    const days: string[] = [];
    for (let d = from; d <= to; d = dayAfter(d)) days.push(d);
    if (!days.every((d) => shop.has(d))) continue;
    const total = days.reduce((s, d) => s + (shop.get(d) ?? 0), 0);
    const listed = g.filter((r) => r.variation_id === null).reduce((s, r) => s + Number(r.sales_confirmed), 0);
    if (total > 0 && listed / total < 0.995) parts.push(`${rangeLabel(from, to)} ${Math.round((listed / total) * 100)}%`);
  }
  return parts.length ? [`Shopee products: the weekly export lists only the top performing products, so these weeks cover part of the shop's sales (${parts.join('; ')}).`] : [];
}
