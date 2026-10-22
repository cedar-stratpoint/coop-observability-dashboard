// Parses a Shopee Product Overview export (.xlsx): one sheet, one row per PH day of the shop-level product funnel (visit, add to cart, placed,
// confirmed). No summary row, so the period is the first and last day, checked against the file name by the gates. Columns by header name.
import {columnsOf, loadWorkbook, sheetRows, toIsoDay, toNumber} from './cells';
import type {FunnelDay, ParsedFunnel} from './types';

const COLUMNS = {
  date: 'date', visitors: 'productvisitorsvisit', pageViews: 'productpageviews', itemsVisited: 'itemsvisited', bounceVisitors: 'productbouncevisitors', bounceRate: 'productbouncerate',
  searchClicks: 'searchclicks', likes: 'likes', atcVisitors: 'productvisitorsaddtocart', atcUnits: 'unitsaddtocart', buyersPlaced: 'buyersplacedorder', unitsPlaced: 'unitsplacedorder',
  salesPlaced: 'salesplacedorderphp', buyersConfirmed: 'buyersconfirmedorder', unitsConfirmed: 'unitsconfirmedorder', salesConfirmed: 'salesconfirmedorderphp',
} as const;

export async function parseProductOverview(bytes: ArrayBuffer | Uint8Array | Buffer): Promise<ParsedFunnel> {
  const wb = await loadWorkbook(bytes, 'Product Overview');
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('This is not a Product Overview workbook (no sheet).');
  const rows = sheetRows(ws);
  const idx = columnsOf(rows[0] ?? [], COLUMNS);
  if (idx.date < 0 || idx.visitors < 0 || idx.salesPlaced < 0 || idx.salesConfirmed < 0) throw new Error('This is not a Product Overview workbook (no date, visitors or sales column).');
  const days: FunnelDay[] = [];
  for (const r of rows.slice(1)) {
    if (r.every((c) => c.trim() === '')) continue;
    const day = toIsoDay(r[idx.date] ?? '');
    if (!day) throw new Error(`Product Overview: "${(r[idx.date] ?? '').slice(0, 12)}" is not a date.`);
    const o = (k: keyof typeof COLUMNS): number | null => (idx[k] >= 0 ? toNumber(r[idx[k]] ?? '') : null);
    days.push({
      day, visitors: o('visitors') ?? 0, pageViews: o('pageViews') ?? 0, itemsVisited: o('itemsVisited'), bounceVisitors: o('bounceVisitors'), bounceRate: o('bounceRate'), searchClicks: o('searchClicks'),
      likes: o('likes'), addToCartVisitors: o('atcVisitors'), addToCartUnits: o('atcUnits'), buyersPlaced: o('buyersPlaced') ?? 0, unitsPlaced: o('unitsPlaced') ?? 0, salesPlaced: o('salesPlaced') ?? 0,
      buyersConfirmed: o('buyersConfirmed') ?? 0, unitsConfirmed: o('unitsConfirmed') ?? 0, salesConfirmed: o('salesConfirmed') ?? 0,
    });
  }
  days.sort((a, b) => (a.day < b.day ? -1 : 1));
  if (days.length === 0) throw new Error('Product Overview: the file has no daily rows.');
  return {periodFrom: days[0].day, periodTo: days[days.length - 1].day, days};
}
