// The four reports that are one snapshot of their period (weekly ads and SKU, daily traffic and product funnel): read the file, run its checks,
// and shape the rows for its observation table. Unlike the Sales Overview there is no day-by-day merge: the app reads the newest ACCEPTED
// import per period (weekly reports) or per day (daily reports), so an import is one status flip and undo is one flip back. Pure apart from reading the bytes.
import {parseAds} from './ads';
import {parseProductOverview} from './product-overview';
import {parseSkuDetail} from './sku-detail';
import {parseTraffic} from './traffic';
import type {GateFailure, ReportType} from './types';

export type SnapshotType = Exclude<ReportType, 'sales_overview'>;
export const SNAPSHOT_TYPES: readonly SnapshotType[] = ['ads', 'sku_detail', 'traffic', 'product_overview'];
export const isSnapshotType = (t: ReportType | null): t is SnapshotType => t !== null && (SNAPSHOT_TYPES as readonly string[]).includes(t);

export const TABLE: Record<SnapshotType, string> = {
  ads: 'marketplace_ads_week_observations',
  sku_detail: 'marketplace_sku_week_observations',
  traffic: 'marketplace_traffic_day_observations',
  product_overview: 'marketplace_funnel_day_observations',
};
export const LABEL: Record<SnapshotType, string> = {ads: 'ads', sku_detail: 'product (SKU)', traffic: 'traffic', product_overview: 'product funnel'};

export interface Snapshot {
  periodFrom: string;
  periodTo: string;
  exportedAt: string | null;
  /** Rows for the observation table, minus import_id. */
  records: Record<string, unknown>[];
  /** Plain figures that identify the file, for the plan and the receipt. */
  summary: Record<string, number>;
  /** SKU only: the sum of product-level confirmed sales, to set against the shop's sales for the period. */
  skuConfirmed?: number;
  openSkipped: string[];
}
export type SnapshotRead = {ok: true; snapshot: Snapshot} | {ok: false; failures: GateFailure[]};

const fail = (code: string, message: string): GateFailure => ({code, message});
const DAY = 86_400_000;
const daysBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};
const r2 = (n: number): number => Math.round(n * 100) / 100;

/** One row for every day of the file's period, once. */
function dayChecks(days: readonly string[], from: string, to: string, what: string): GateFailure[] {
  const failures: GateFailure[] = [];
  const seen = new Set<string>();
  for (const d of days) {
    if (seen.has(d)) failures.push(fail('DUPLICATE_DAY', `${what}: ${d} appears more than once.`));
    seen.add(d);
  }
  const missing = daysBetween(from, to).filter((d) => !seen.has(d));
  if (missing.length) failures.push(fail('GAP', `${what}: no row for ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ' and more' : ''}.`));
  const outside = [...seen].filter((d) => d < from || d > to);
  if (outside.length) failures.push(fail('PERIOD_MISMATCH', `${what}: rows outside the period (${outside.slice(0, 3).join(', ')}).`));
  return failures;
}
const nameCheck = (p: {from: string; to: string}, name: {from: string; to: string} | null): GateFailure[] =>
  name && (name.from !== p.from || name.to !== p.to) ? [fail('FILENAME_MISMATCH', `The file name says ${name.from} to ${name.to} but the file covers ${p.from} to ${p.to}.`)] : [];
const negative = (values: readonly (number | null)[], what: string): GateFailure[] =>
  values.some((v) => v !== null && (!Number.isFinite(v) || v < 0)) ? [fail('BAD_NUMBER', `${what}: a figure is negative or not a number.`)] : [];

export async function readSnapshot(type: SnapshotType, bytes: Uint8Array, filenamePeriod: {from: string; to: string} | null, today: string): Promise<SnapshotRead> {
  try {
    if (type === 'ads') {
      const p = parseAds(bytes);
      const failures = [
        ...(p.rows.length ? [] : [fail('EMPTY', 'The ads report has no campaign rows.')]),
        ...(p.periodFrom <= p.periodTo ? [] : [fail('PERIOD_MISMATCH', 'The date period runs backwards.')]),
        ...nameCheck({from: p.periodFrom, to: p.periodTo}, filenamePeriod),
        ...negative(p.rows.flatMap((r) => [r.expense, r.gmv, r.impressions, r.clicks]), 'Ads'),
      ];
      if (failures.length) return {ok: false, failures};
      const spend = r2(p.rows.reduce((s, r) => s + r.expense, 0));
      const gmv = r2(p.rows.reduce((s, r) => s + r.gmv, 0));
      return {
        ok: true,
        snapshot: {
          periodFrom: p.periodFrom, periodTo: p.periodTo, exportedAt: p.exportedAt, openSkipped: [],
          summary: {campaigns: p.rows.length, spend, adRevenue: gmv, roas: spend > 0 ? r2(gmv / spend) : 0},
          records: p.rows.map((r, i) => ({seq: i + 1, ad_name: r.adName, ads_type: r.adsType, status: r.status, impressions: r.impressions, clicks: r.clicks, conversions: r.conversions, direct_conversions: r.directConversions, items_sold: r.itemsSold, gmv: r.gmv, direct_gmv: r.directGmv, expense: r.expense})),
        },
      };
    }
    if (type === 'sku_detail') {
      if (!filenamePeriod) return {ok: false, failures: [fail('NO_PERIOD', 'This file has no dates inside it, and its name has none either. Keep the name Shopee gave it (parentskudetail.YYYYMMDD_YYYYMMDD.xlsx).')]};
      const p = await parseSkuDetail(bytes, filenamePeriod);
      const failures = [...(p.rows.length ? [] : [fail('EMPTY', 'The SKU report has no product rows.')]), ...negative(p.rows.flatMap((r) => [r.salesPlaced, r.salesConfirmed, r.unitsPlaced, r.unitsConfirmed]), 'SKU')];
      if (failures.length) return {ok: false, failures};
      const products = p.rows.filter((r) => r.variationId === null);
      const skuConfirmed = r2(products.reduce((s, r) => s + r.salesConfirmed, 0));
      return {
        ok: true,
        snapshot: {
          periodFrom: p.periodFrom, periodTo: p.periodTo, exportedAt: null, openSkipped: [], skuConfirmed,
          summary: {products: products.length, variations: p.rows.length - products.length, confirmedSales: skuConfirmed},
          records: p.rows.map((r, i) => ({seq: i + 1, item_id: r.itemId, product: r.product, variation_id: r.variationId, variation_name: r.variationName, sku: r.sku, parent_sku: r.parentSku, sales_placed: r.salesPlaced, sales_confirmed: r.salesConfirmed, units_placed: r.unitsPlaced, units_confirmed: r.unitsConfirmed, orders_placed: r.ordersPlaced, orders_confirmed: r.ordersConfirmed, buyers_placed: r.buyersPlaced, buyers_confirmed: r.buyersConfirmed, impressions: r.impressions, clicks: r.clicks, visitors: r.visitors, page_views: r.pageViews})),
        },
      };
    }
    if (type === 'traffic') {
      const p = await parseTraffic(bytes);
      const failures: GateFailure[] = [...nameCheck({from: p.periodFrom, to: p.periodTo}, filenamePeriod)];
      for (const platform of ['all', 'pc', 'app'] as const) {
        const rows = p.days.filter((d) => d.platform === platform);
        if (rows.length === 0 && platform === 'all') failures.push(fail('EMPTY', 'The traffic report has no daily rows.'));
        if (rows.length) {
          failures.push(...dayChecks(rows.map((d) => d.day), p.periodFrom, p.periodTo, `Traffic (${platform})`));
          const total = rows.reduce((s, d) => s + d.pageViews, 0);
          const file = p.summaryPageViews[platform];
          if (file !== undefined && total !== file) failures.push(fail('SUM_PAGE_VIEWS', `Traffic (${platform}): daily page views add up to ${total} but the file's own total is ${file}.`));
        }
      }
      failures.push(...negative(p.days.flatMap((d) => [d.pageViews, d.visitors]), 'Traffic'));
      if (failures.length) return {ok: false, failures};
      const days = p.days.filter((d) => d.day < today);
      const openSkipped = [...new Set(p.days.filter((d) => d.day >= today).map((d) => d.day))].sort();
      if (days.length === 0) return {ok: false, failures: [fail('ALL_DAYS_OPEN', 'Every day in the file is today or later, so none can be loaded yet.')]};
      return {
        ok: true,
        snapshot: {
          periodFrom: p.periodFrom, periodTo: p.periodTo, exportedAt: null, openSkipped,
          summary: {days: new Set(days.map((d) => d.day)).size, pageViews: days.filter((d) => d.platform === 'all').reduce((s, d) => s + d.pageViews, 0)},
          records: days.map((d) => ({day: d.day, platform: d.platform, page_views: d.pageViews, avg_page_views: d.avgPageViews, avg_time_seconds: d.avgTimeSeconds, bounce_rate: d.bounceRate, visitors: d.visitors, new_visitors: d.newVisitors, existing_visitors: d.existingVisitors, new_followers: d.newFollowers})),
        },
      };
    }
    const p = await parseProductOverview(bytes);
    const failures = [...dayChecks(p.days.map((d) => d.day), p.periodFrom, p.periodTo, 'Product funnel'), ...nameCheck({from: p.periodFrom, to: p.periodTo}, filenamePeriod), ...negative(p.days.flatMap((d) => [d.salesPlaced, d.salesConfirmed, d.visitors]), 'Product funnel')];
    if (failures.length) return {ok: false, failures};
    const days = p.days.filter((d) => d.day < today);
    if (days.length === 0) return {ok: false, failures: [fail('ALL_DAYS_OPEN', 'Every day in the file is today or later, so none can be loaded yet.')]};
    return {
      ok: true,
      snapshot: {
        periodFrom: p.periodFrom, periodTo: p.periodTo, exportedAt: null, openSkipped: p.days.filter((d) => d.day >= today).map((d) => d.day),
        summary: {days: days.length, salesPlaced: r2(days.reduce((s, d) => s + d.salesPlaced, 0)), salesConfirmed: r2(days.reduce((s, d) => s + d.salesConfirmed, 0))},
        records: days.map((d) => ({day: d.day, visitors: d.visitors, page_views: d.pageViews, items_visited: d.itemsVisited, bounce_visitors: d.bounceVisitors, bounce_rate: d.bounceRate, search_clicks: d.searchClicks, likes: d.likes, add_to_cart_visitors: d.addToCartVisitors, add_to_cart_units: d.addToCartUnits, buyers_placed: d.buyersPlaced, units_placed: d.unitsPlaced, sales_placed: d.salesPlaced, buyers_confirmed: d.buyersConfirmed, units_confirmed: d.unitsConfirmed, sales_confirmed: d.salesConfirmed})),
      },
    };
  } catch (e) {
    return {ok: false, failures: [fail('PARSE', e instanceof Error ? e.message : String(e))]};
  }
}
