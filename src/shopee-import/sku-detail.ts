// Parses the "Top Performing Products" sheet of a Shopee weekly parent SKU detail export (.xlsx): one row per product, then one row per
// variation of it. The export carries only the top performing products (85 to 100% of the week's shop sales), so a SKU file is never the
// whole week; the pipeline records how much of it. Columns by header name. The file has no date inside, so the period comes from the file name.
import {columnsOf, headerKey, loadWorkbook, sheetRows, toNumber} from './cells';
import type {ParsedSku, SkuRow} from './types';

const COLUMNS = {
  itemId: 'itemid', product: 'product', variationId: 'variationid', variationName: 'variationname', sku: 'sku', parentSku: 'parentsku',
  salesPlaced: 'salesplacedorderphp', salesConfirmed: 'salesconfirmedorderphp', unitsPlaced: 'unitsplacedorder', unitsConfirmed: 'unitsconfirmedorder',
  ordersPlaced: 'placedorder', ordersConfirmed: 'confirmedorder', buyersPlaced: 'buyersplacedorder', buyersConfirmed: 'buyersconfirmedorder',
  impressions: 'productimpression', clicks: 'productclicks', visitors: 'productvisitorsvisit', pageViews: 'productpageviews',
} as const;

const dash = (s: string): string | null => (s.trim() === '' || s.trim() === '-' ? null : s.trim());

export async function parseSkuDetail(bytes: ArrayBuffer | Uint8Array | Buffer, period: {from: string; to: string}): Promise<ParsedSku> {
  const wb = await loadWorkbook(bytes, 'parent SKU detail');
  const ws = wb.worksheets.find((w) => headerKey(w.name) === 'topperformingproducts');
  if (!ws) throw new Error('This is not a parent SKU detail workbook (no "Top Performing Products" sheet).');
  const rows = sheetRows(ws);
  const head = rows.findIndex((r) => r.map(headerKey).includes('itemid'));
  if (head < 0) throw new Error('SKU detail: no header row with "Item ID".');
  const idx = columnsOf(rows[head], COLUMNS);
  for (const required of ['itemId', 'product', 'salesPlaced', 'salesConfirmed', 'unitsConfirmed'] as const) if (idx[required] < 0) throw new Error(`SKU detail: no "${required}" column.`);
  const out: SkuRow[] = [];
  for (const r of rows.slice(head + 1)) {
    const at = (k: keyof typeof COLUMNS): string => (idx[k] >= 0 ? r[idx[k]] ?? '' : '');
    const itemId = dash(at('itemId'));
    if (!itemId) continue;
    const n = (k: keyof typeof COLUMNS): number => toNumber(at(k)) ?? 0;
    const o = (k: keyof typeof COLUMNS): number | null => toNumber(at(k));
    out.push({
      itemId, product: at('product').trim(), variationId: dash(at('variationId')), variationName: dash(at('variationName')), sku: dash(at('sku')), parentSku: dash(at('parentSku')),
      salesPlaced: n('salesPlaced'), salesConfirmed: n('salesConfirmed'), unitsPlaced: n('unitsPlaced'), unitsConfirmed: n('unitsConfirmed'), ordersPlaced: n('ordersPlaced'),
      ordersConfirmed: n('ordersConfirmed'), buyersPlaced: n('buyersPlaced'), buyersConfirmed: n('buyersConfirmed'), impressions: o('impressions'), clicks: o('clicks'), visitors: o('visitors'), pageViews: o('pageViews'),
    });
  }
  return {periodFrom: period.from, periodTo: period.to, rows: out};
}
