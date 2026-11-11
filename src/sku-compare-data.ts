import 'server-only';
import {posClient, usingPosMock} from './pos-data';
import {fetchAllRows} from './pos-fetch-paginate';
import {aliasRowsFromDb, type ShopeeSkuRow} from './sku-compare-readers';
import type {AliasRow} from './sku-compare';

/**
 * Server-side loaders for the SKU comparison (service role, RLS on with no policies). Soft like src/shopee-weekly-data.ts: mock mode, a missing table or view
 * (the SQL not applied yet) or a failed read gives no rows, and the comparison then shows the channel as unmapped or without data instead of failing.
 * Unlike the Sales page's reader this one selects `item_id` and `sku`, which the alias lookup needs.
 */
export async function loadAliasRows(): Promise<AliasRow[]> {
  if (usingPosMock()) return [];
  try {
    const sb = posClient();
    const rows = await fetchAllRows('product_channel_alias', (a, b) =>
      sb.from('product_channel_alias').select('channel,alias_type,alias_value,product_id,bundle_id,component_qty,valid_from,valid_to,source,confirmed_at').order('id').range(a, b));
    return aliasRowsFromDb(rows);
  } catch (error) {
    console.warn(`product_channel_alias read failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/** Shopee weekly SKU rows (newest accepted import per week) for the weeks from `from` to `to` (Mondays). */
export async function loadShopeeSkuRows(from: string, to: string): Promise<ShopeeSkuRow[]> {
  if (usingPosMock()) return [];
  try {
    const sb = posClient();
    const rows = await fetchAllRows('marketplace_sku_weekly', (a, b) =>
      sb.from('marketplace_sku_weekly').select('period_from,period_to,seq,item_id,product,variation_id,sku,sales_confirmed,units_confirmed').gte('period_from', from).lte('period_from', to).order('period_from').order('seq').range(a, b));
    return rows.map((r) => ({
      period_from: String(r.period_from), period_to: String(r.period_to), item_id: String(r.item_id), product: String(r.product),
      variation_id: r.variation_id === null ? null : String(r.variation_id), sku: r.sku === null ? null : String(r.sku),
      sales_confirmed: Number(r.sales_confirmed), units_confirmed: Number(r.units_confirmed),
    }));
  } catch (error) {
    console.warn(`marketplace_sku_weekly read failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
