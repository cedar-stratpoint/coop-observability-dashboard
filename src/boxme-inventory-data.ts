import 'server-only';
import {cache} from 'react';
import {unstable_cache} from 'next/cache';
import {posClient, usingPosMock, getPosProducts} from './pos-data';
import {getLocationStock} from './pos-location-data';
import {getStockConfig} from './pos-stock-settings';
import {POS_TAGS, POS_CACHE_REVALIDATE} from './pos-cache';
import {fetchAllRows} from './pos-fetch-paginate';
import {buildBoxmeInventory, syncInfo, type BoxmeInventoryResult, type PosRef, type BoxmeInventoryRow} from './boxme-inventory-compute';
import {BOXME_COLUMNS, BOXME_HISTORY_DAYS, mapBoxmeFeed, type BoxmeFeed} from './boxme-feed';
import {MOCK_BOXME_PRODUCTS, MOCK_BOXME_WAREHOUSES, mockBoxmeFeed} from './boxme-mock';

// SERVER-ONLY. The BoxMe (Online) channel of /inventory. Reads the boxme_* tables
// the zoomy-observability boxme-sync job writes once a day (same archive project
// and service-role env as pos_*), joins them to the POS catalog on
// seller_sku = product_id, and computes rows in boxme-inventory-compute.ts.
// Fail-soft: if the tables are missing (SQL not applied yet) the page shows the
// "not connected" state instead of crashing. Env unset => built-in demo data.

export interface BoxmePageData extends BoxmeInventoryResult {
  usingMock: boolean;
  connected: boolean; // false when the boxme_* tables could not be read
  loadError: string | null;
}

// The feed changes once a day, so the shared 30s window is plenty; the tag lets a
// future "sync now" action invalidate it.
const boxmeFeedCached = unstable_cache(async (): Promise<BoxmeFeed> => {
  const sb = posClient();
  const since = new Date(Date.now() - BOXME_HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
  const [products, warehouses, stock, daily, lots, runsRes] = await Promise.all([
    fetchAllRows('boxme_products', (from, to) => sb.from('boxme_products').select(BOXME_COLUMNS.products).order('seller_sku').range(from, to)),
    fetchAllRows('boxme_warehouses', (from, to) => sb.from('boxme_warehouses').select(BOXME_COLUMNS.warehouses).order('pickup_id').range(from, to)),
    fetchAllRows('boxme_stock', (from, to) => sb.from('boxme_stock').select(BOXME_COLUMNS.stock).order('seller_sku').order('pickup_id').range(from, to)),
    fetchAllRows('boxme_stock_daily', (from, to) =>
      sb.from('boxme_stock_daily').select(BOXME_COLUMNS.daily)
        .gte('snapshot_date', since)
        .order('snapshot_date').order('seller_sku').order('pickup_id').range(from, to)),
    fetchAllRows('boxme_stock_lots', (from, to) =>
      sb.from('boxme_stock_lots').select(BOXME_COLUMNS.lots)
        .order('seller_sku').order('warehouse_code').order('batch_lot').order('expire_date').range(from, to)),
    // Bounded: only the recent runs matter for freshness. The page also shows the error and the API key expiry.
    sb.from('boxme_sync_runs')
      .select(`${BOXME_COLUMNS.runs},error,key_expires_at`)
      .order('started_at', {ascending: false}).limit(20),
  ]);
  if (runsRes.error) throw new Error(`boxme_sync_runs read failed: ${runsRes.error.message}`);
  return mapBoxmeFeed({products, warehouses, stock, daily, lots, runs: (runsRes.data ?? []) as Record<string, unknown>[]});
}, ['boxme-feed'], {tags: [POS_TAGS.boxme], revalidate: POS_CACHE_REVALIDATE});

/** The raw feed for this request: demo data, the cached tables, or the read error. */
const loadFeed = cache(async (): Promise<{feed: BoxmeFeed; mock: boolean} | {error: string}> => {
  if (usingPosMock()) {
    return {feed: {products: MOCK_BOXME_PRODUCTS, warehouses: MOCK_BOXME_WAREHOUSES, ...mockBoxmeFeed(new Date())}, mock: true};
  }
  try {
    return {feed: await boxmeFeedCached(), mock: false};
  } catch (e) {
    return {error: e instanceof Error ? e.message : String(e)};
  }
});

/** Everything the BoxMe channel renders. React-cached per request. */
export const getBoxmeInventoryPageData = cache(async (): Promise<BoxmePageData> => {
  const now = new Date();
  const mock = usingPosMock();

  const [posProducts, locations, config, loaded] = await Promise.all([
    getPosProducts(),
    getLocationStock().catch(() => []),
    getStockConfig(),
    loadFeed(),
  ]);
  const locById = new Map(locations.map((l) => [l.product_id, l]));
  const pos: PosRef[] = posProducts.map((p) => {
    const l = locById.get(p.product_id);
    // Mock mode has no per-location view; treat the whole on-hand as Event.
    return {product_id: p.product_id, name: p.name, category: p.category, active: p.active, office: l?.office ?? 0, event: l?.event ?? (mock ? p.stock : 0)};
  });

  if ('error' in loaded) {
    const empty = buildBoxmeInventory({products: [], warehouses: [], stock: [], daily: [], lots: [], runs: [], pos, config, now});
    return {...empty, sync: syncInfo([], now), usingMock: false, connected: false, loadError: loaded.error};
  }
  return {...buildBoxmeInventory({...loaded.feed, pos, config, now}), usingMock: loaded.mock, connected: true, loadError: null};
});

export interface BoxmeSkuDetail {
  row: BoxmeInventoryRow;
  sync: BoxmePageData['sync'];
  usingMock: boolean;
  /** Daily available units summed across warehouses, oldest first (last ~35 days). */
  history: {date: string; available: number}[];
}

/** The BoxMe side of one SKU for /inventory/[sku]; null when BoxMe does not stock it. */
export async function getBoxmeSkuDetail(sku: string): Promise<BoxmeSkuDetail | null> {
  const [data, loaded] = await Promise.all([getBoxmeInventoryPageData(), loadFeed()]);
  const row = data.rows.find((r) => r.sku === sku);
  if (!row || 'error' in loaded) return null;
  const byDay = new Map<string, number>();
  for (const d of loaded.feed.daily) if (d.seller_sku === sku) byDay.set(d.snapshot_date, (byDay.get(d.snapshot_date) ?? 0) + d.available);
  const history = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, available]) => ({date, available}));
  return {row, sync: data.sync, usingMock: data.usingMock, history};
}
