// The Shopee import pipeline's shared shapes. Plain data, no I/O. See knowledge/tasks/2026-10-22-shopee-import-data-engineering-plan.md.

/** One PH day of shop figures from a Sales Overview export. Money in pesos, counts whole. */
export interface DayFigures {
  day: string; // YYYY-MM-DD, PH calendar day
  salesPlaced: number;
  salesConfirmed: number;
  ordersPlaced: number;
  ordersConfirmed: number;
  unitsPlaced: number;
  unitsConfirmed: number;
  buyersPlaced: number | null;
  buyersConfirmed: number | null;
  visitors: number | null;
}

export interface ParsedSalesOverview {
  /** The week (or span) the file says it covers, from its summary row. */
  periodFrom: string;
  periodTo: string;
  /** The file's own totals, to check the daily rows against. */
  summary: {salesPlaced: number; salesConfirmed: number};
  days: DayFigures[];
}

export type ReportType = 'sales_overview' | 'product_overview' | 'traffic' | 'sku_detail' | 'ads';

export interface GateFailure {
  code: string;
  message: string;
}

// ── The other four reports (weekly ads and SKU, daily traffic and product funnel). One file is one snapshot of its period. ──

/** One campaign row of a weekly ads (CPC overall) export. Money in pesos. */
export interface AdsRow {
  adName: string;
  adsType: string | null;
  status: string | null;
  impressions: number;
  clicks: number;
  conversions: number;
  directConversions: number;
  itemsSold: number;
  gmv: number;
  directGmv: number;
  expense: number;
}
export interface ParsedAds {
  periodFrom: string;
  periodTo: string;
  /** The "Report Creation Time" in the file header, as an ISO instant (PH time), when it has one. */
  exportedAt: string | null;
  rows: AdsRow[];
}

/** One product (variation null) or one variation of a product, from the "Top Performing Products" sheet of a weekly parent SKU detail export. */
export interface SkuRow {
  itemId: string;
  product: string;
  variationId: string | null;
  variationName: string | null;
  sku: string | null;
  parentSku: string | null;
  salesPlaced: number;
  salesConfirmed: number;
  unitsPlaced: number;
  unitsConfirmed: number;
  ordersPlaced: number;
  ordersConfirmed: number;
  buyersPlaced: number;
  buyersConfirmed: number;
  impressions: number | null;
  clicks: number | null;
  visitors: number | null;
  pageViews: number | null;
}
export interface ParsedSku {
  periodFrom: string;
  periodTo: string;
  rows: SkuRow[];
}

export type TrafficPlatform = 'all' | 'pc' | 'app';
export interface TrafficDay {
  day: string;
  platform: TrafficPlatform;
  pageViews: number;
  avgPageViews: number | null;
  avgTimeSeconds: number | null;
  bounceRate: number | null; // percent, 19.44 = 19.44%
  visitors: number;
  newVisitors: number | null;
  existingVisitors: number | null;
  newFollowers: number | null;
}
export interface ParsedTraffic {
  periodFrom: string;
  periodTo: string;
  /** The file's own page-view total for each platform's whole span, to check the daily rows against. */
  summaryPageViews: Partial<Record<TrafficPlatform, number>>;
  days: TrafficDay[];
}

/** One PH day of the shop-level product funnel (product overview export). */
export interface FunnelDay {
  day: string;
  visitors: number;
  pageViews: number;
  itemsVisited: number | null;
  bounceVisitors: number | null;
  bounceRate: number | null;
  searchClicks: number | null;
  likes: number | null;
  addToCartVisitors: number | null;
  addToCartUnits: number | null;
  buyersPlaced: number;
  unitsPlaced: number;
  salesPlaced: number;
  buyersConfirmed: number;
  unitsConfirmed: number;
  salesConfirmed: number;
}
export interface ParsedFunnel {
  periodFrom: string;
  periodTo: string;
  days: FunnelDay[];
}
