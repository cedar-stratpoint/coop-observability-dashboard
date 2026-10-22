// FICTIONAL Shopee exports for the four weekly reports (ads CSV, parent SKU detail, Traffic Overview, Product Overview), shaped like the
// real files: text values with thousands separators, "-" for no value, DD/MM/YYYY dates, the traffic sheets as summary table + daily table.
// Built in the test so no shop figure is committed to this public repo.
import ExcelJS from 'exceljs';

const dmy = (iso: string): string => iso.split('-').reverse().join('/');
const fmt = (n: number): string => n.toLocaleString('en-US', {maximumFractionDigits: 2});
export const daysFrom = (from: string, count = 7): string[] => Array.from({length: count}, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
const toBuffer = async (wb: ExcelJS.Workbook): Promise<Buffer> => Buffer.from(await wb.xlsx.writeBuffer());

// ── ads ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface FixtureAd {name: string; status?: string; adsType?: string; impressions?: number; clicks?: number; conversions?: number; directConversions?: number; itemsSold?: number; gmv: number; directGmv?: number; expense: number}

const ADS_HEADER = [
  'Sequence', 'Ad Name', 'Status', 'Ads Type', 'Product ID', 'Creative', 'Bidding Method', 'Placement', 'Start Date', 'End Date', 'Impression', 'Clicks', 'CTR', 'Add to Cart', 'Add to Cart Rate',
  'Conversions', 'Direct Conversions', 'Conversion Rate', 'Direct Conversion Rate', 'Cost per Conversion', 'Cost per Direct Conversion', 'Items Sold', 'Direct Items Sold', 'GMV', 'Direct GMV',
  'Expense', 'ROAS', 'Direct ROAS', 'ACOS', 'Direct ACOS',
];

/** The CPC overall report: BOM, title and meta lines, a blank line, a header, one row per campaign. `period` is the raw "DD/MM/YYYY - DD/MM/YYYY" text. */
export function adsCsv(ads: FixtureAd[], opts: {period?: string; created?: string; title?: boolean} = {}): Buffer {
  const lines = [
    opts.title === false ? 'Some Other Report' : 'All CPC Ads Report - Shopee Philippines',
    'User Name,fictionalshop',
    'Shop Name,Fictional Shop',
    'Shop ID,1000000001',
    `Report Creation Time,${opts.created ?? '28/09/2026 10:25'}`,
    `Date Period,${opts.period ?? '21/09/2026 - 27/09/2026'}`,
    '',
    ADS_HEADER.join(','),
  ];
  ads.forEach((a, i) => {
    const row = ADS_HEADER.map((h) => {
      switch (h) {
        case 'Sequence': return String(i + 1);
        case 'Ad Name': return a.name.includes(',') ? `"${a.name}"` : a.name;
        case 'Status': return a.status ?? 'Ongoing';
        case 'Ads Type': return a.adsType ?? '';
        case 'Impression': return String(a.impressions ?? 1000);
        case 'Clicks': return String(a.clicks ?? 20);
        case 'Conversions': return String(a.conversions ?? 2);
        case 'Direct Conversions': return String(a.directConversions ?? 2);
        case 'Items Sold': return String(a.itemsSold ?? 3);
        case 'GMV': return a.gmv.toFixed(2);
        case 'Direct GMV': return (a.directGmv ?? a.gmv).toFixed(2);
        case 'Expense': return a.expense.toFixed(2);
        default: return '-';
      }
    });
    lines.push(row.join(','));
  });
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

// ── SKU ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface FixtureVariation {id: string; name: string; sku?: string; salesPlaced: number; salesConfirmed: number; unitsPlaced?: number; unitsConfirmed?: number}
export interface FixtureProduct {itemId: string; title: string; parentSku?: string; salesPlaced: number; salesConfirmed: number; unitsPlaced?: number; unitsConfirmed?: number; variations?: FixtureVariation[]}

const SKU_HEADER = [
  'Item ID', 'Product', 'Current Item Status', 'Variation ID', 'Variation Name', 'Current Variation Status', 'SKU', 'Parent SKU', 'Sales (Placed Order) (PHP)', 'Sales (Confirmed Order) (PHP)', 'Product Impression',
  'Product Clicks', 'CTR', 'Placed Order', 'Confirmed Order', 'Units (Placed Order)', 'Units (Confirmed Order)', 'Buyers (Placed Order)', 'Buyers (Confirmed Order)', 'Product Visitors (Visit)', 'Product Page Views',
];

/** The "Top Performing Products" sheet: a product row (variation columns "-") followed by its variation rows, plus the other sheets the real file carries. */
export async function skuDetailFile(products: FixtureProduct[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Top Performing Products');
  ws.addRow(SKU_HEADER);
  const row = (p: FixtureProduct, v?: FixtureVariation): string[] => {
    const placed = v ? v.salesPlaced : p.salesPlaced;
    const confirmed = v ? v.salesConfirmed : p.salesConfirmed;
    const up = v ? v.unitsPlaced ?? 1 : p.unitsPlaced ?? 2;
    const uc = v ? v.unitsConfirmed ?? 1 : p.unitsConfirmed ?? 2;
    return [
      p.itemId, p.title, 'Normal', v ? v.id : '-', v ? v.name : '-', v ? 'Normal' : '-', v ? v.sku ?? '-' : '-', p.parentSku ?? '-', fmt(placed), fmt(confirmed), v ? '-' : '4159', v ? '-' : '91',
      v ? '-' : '2.19%', v ? '-' : '4', v ? '-' : '3', fmt(up), fmt(uc), v ? '1' : '3', v ? '1' : '3', v ? '-' : '60', v ? '2' : '86',
    ];
  };
  for (const p of products) {
    ws.addRow(row(p));
    for (const v of p.variations ?? []) ws.addRow(row(p, v));
  }
  wb.addWorksheet('Newly Listed Products').addRow(['Item ID', 'Product']);
  return toBuffer(wb);
}

// ── traffic ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const TRAFFIC_HEADER = ['Date', 'Page Views', 'Avg. Page Views', 'Avg. Time Spent', 'Bounce Rate', 'Visitors', 'New Visitors', 'Existing Visitors', 'New Followers'];

export interface TrafficOpts {
  /** Page views per day for the "All" sheet; PC and APP split it (PC gets 1 a day, APP the rest). */
  pageViews?: number[];
  /** Replace the file's own page-view total on the All sheet (to make the days not add up). */
  summaryPageViews?: number;
  /** Leave one day out of every sheet. */
  dropDay?: string;
  /** Repeat one day's row on every sheet. */
  dupDay?: string;
  /** The text of the summary row's date range. */
  range?: string;
}

/** Three sheets (All, PC, APP): span summary row, a blank row, then one row per PH day. */
export async function trafficFile(from: string, opts: TrafficOpts = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const all = daysFrom(from);
  const pvs = opts.pageViews ?? all.map((_, i) => 50 + i * 10);
  const keep = all.map((d, i) => ({d, pv: pvs[i]})).filter((x) => x.d !== opts.dropDay);
  const rows = opts.dupDay ? [...keep, ...keep.filter((x) => x.d === opts.dupDay)] : keep;
  const last = all[all.length - 1];
  const range = opts.range ?? `${dmy(from)}-${dmy(last)}`;
  for (const [name, platform] of [['All', 'all'], ['PC', 'pc'], ['APP', 'app']] as const) {
    const pvOf = (pv: number): number => (platform === 'all' ? pv : platform === 'pc' ? 1 : pv - 1);
    const total = rows.reduce((s, x) => s + pvOf(x.pv), 0);
    const ws = wb.addWorksheet(name);
    ws.addRow(TRAFFIC_HEADER);
    ws.addRow([range, fmt(platform === 'all' && opts.summaryPageViews !== undefined ? opts.summaryPageViews : total), '3.01', '00:00:48', '19.44%', '180', '117', '63', platform === 'pc' ? '-' : '2']);
    ws.addRow([]);
    ws.addRow(TRAFFIC_HEADER);
    for (const x of rows) ws.addRow([dmy(x.d), fmt(pvOf(x.pv)), '2.62', '00:01:21', '15.38%', '13', '9', '4', platform === 'pc' ? '-' : '0']);
  }
  return toBuffer(wb);
}

// ── product overview (shop-level funnel) ────────────────────────────────────────────────────────────────────────────────
const FUNNEL_HEADER = [
  'Date', 'Product Visitors (Visit)', 'Product Page Views', 'Items Visited', 'Product Bounce Visitors', 'Product Bounce Rate', 'Search Clicks', 'Likes', 'Product Visitors (Add to Cart)', 'Units (Add to Cart)',
  'Conversion Rate (Add to Cart)', 'Buyers (Placed Order)', 'Units (Placed Order)', 'Items Placed', 'Sales (Placed Order) (PHP)', 'Conversion Rate (Placed Order)', 'Buyers (Confirmed Order)', 'Units (Confirmed Order)',
  'Items Confirmed', 'Sales (Confirmed Order) (PHP)', 'Conversion Rate (Confirmed Order)', 'Conversion Rate (Placed to Confirmed)',
];

export interface FunnelDayFixture {day: string; visitors?: number; salesPlaced: number; salesConfirmed: number}
export const funnelWeek = (from: string, confirmed: number[]): FunnelDayFixture[] => daysFrom(from, confirmed.length).map((day, i) => ({day, salesPlaced: confirmed[i] + 10, salesConfirmed: confirmed[i]}));

export async function productOverviewFile(days: FunnelDayFixture[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('overview');
  ws.addRow(FUNNEL_HEADER);
  for (const d of days) {
    ws.addRow([dmy(d.day), fmt(d.visitors ?? 12), '33', '6', '1', '8.33%', '8', '0', '3', '4', '25.00%', '2', '3', '2', fmt(d.salesPlaced), '8.33%', '2', '3', '2', fmt(d.salesConfirmed), '8.33%', '100.00%']);
  }
  return toBuffer(wb);
}
