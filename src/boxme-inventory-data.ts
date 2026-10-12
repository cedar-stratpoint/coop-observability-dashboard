import 'server-only';
import {cache} from 'react';
import {unstable_cache} from 'next/cache';
import {posClient, usingPosMock, getPosProducts} from './pos-data';
import {getLocationStock} from './pos-location-data';
import {getStockConfig} from './pos-stock-settings';
import {POS_TAGS, POS_CACHE_REVALIDATE} from './pos-cache';
import {fetchAllRows} from './pos-fetch-paginate';
import {
  buildBoxmeInventory, syncInfo,
  type BoxmeInventoryResult, type BoxmeProduct, type BoxmeWarehouse, type BoxmeStockRow,
  type BoxmeDailyRow, type BoxmeLotRow, type BoxmeSyncRun, type PosRef, type BoxmeInventoryRow,
} from './boxme-inventory-compute';
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

/** Days of daily snapshots to load for the sales-speed estimate. */
const HISTORY_DAYS = 35;

interface RawFeed {
  products: BoxmeProduct[];
  warehouses: BoxmeWarehouse[];
  stock: BoxmeStockRow[];
  daily: BoxmeDailyRow[];
  lots: BoxmeLotRow[];
  runs: BoxmeSyncRun[];
}

const n = (v: unknown) => Number(v ?? 0) || 0;

// The feed changes once a day, so the shared 30s window is plenty; the tag lets a
// future "sync now" action invalidate it.
const boxmeFeedCached = unstable_cache(async (): Promise<RawFeed> => {
  const sb = posClient();
  const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
  const [products, warehouses, stock, daily, lots, runsRes] = await Promise.all([
    fetchAllRows('boxme_products', (from, to) =>
      sb.from('boxme_products').select('seller_sku,name,active,sale_price,min_quantity,expiry_threshold,image_url').order('seller_sku').range(from, to)),
    fetchAllRows('boxme_warehouses', (from, to) =>
      sb.from('boxme_warehouses').select('pickup_id,warehouse_code,pickup_name').order('pickup_id').range(from, to)),
    fetchAllRows('boxme_stock', (from, to) =>
      sb.from('boxme_stock')
        .select('seller_sku,pickup_id,stock,awaiting,reserved,available,incoming,damaged_stock,damaged_available,synced_at')
        .order('seller_sku').order('pickup_id').range(from, to)),
    fetchAllRows('boxme_stock_daily', (from, to) =>
      sb.from('boxme_stock_daily').select('snapshot_date,seller_sku,pickup_id,stock,available')
        .gte('snapshot_date', since)
        .order('snapshot_date').order('seller_sku').order('pickup_id').range(from, to)),
    fetchAllRows('boxme_stock_lots', (from, to) =>
      sb.from('boxme_stock_lots').select('seller_sku,warehouse_code,batch_lot,expire_date,quantity,synced_at')
        .order('seller_sku').order('warehouse_code').order('batch_lot').order('expire_date').range(from, to)),
    // Bounded: only the recent runs matter for freshness.
    sb.from('boxme_sync_runs')
      .select('id,started_at,finished_at,status,skus_seen,skus_written,error,key_expires_at')
      .order('started_at', {ascending: false}).limit(20),
  ]);
  if (runsRes.error) throw new Error(`boxme_sync_runs read failed: ${runsRes.error.message}`);

  return {
    products: products.map((p) => ({
      seller_sku: String(p.seller_sku), name: String(p.name ?? p.seller_sku), active: p.active !== false,
      sale_price: p.sale_price == null ? null : n(p.sale_price), min_quantity: n(p.min_quantity),
      expiry_threshold: p.expiry_threshold == null ? null : n(p.expiry_threshold), image_url: (p.image_url as string | null) ?? null,
    })),
    warehouses: warehouses.map((w) => ({pickup_id: String(w.pickup_id), warehouse_code: (w.warehouse_code as string | null) ?? null, pickup_name: (w.pickup_name as string | null) ?? null})),
    stock: stock.map((r) => ({
      seller_sku: String(r.seller_sku), pickup_id: String(r.pickup_id), stock: n(r.stock), awaiting: n(r.awaiting), reserved: n(r.reserved),
      available: n(r.available), incoming: n(r.incoming), damaged_stock: n(r.damaged_stock), damaged_available: n(r.damaged_available), synced_at: String(r.synced_at),
    })),
    daily: daily.map((r) => ({snapshot_date: String(r.snapshot_date), seller_sku: String(r.seller_sku), pickup_id: String(r.pickup_id), stock: n(r.stock), available: n(r.available)})),
    lots: lots.map((l) => ({
      seller_sku: String(l.seller_sku), warehouse_code: String(l.warehouse_code), batch_lot: String(l.batch_lot ?? ''),
      expire_date: String(l.expire_date), quantity: n(l.quantity), synced_at: String(l.synced_at),
    })),
    runs: (runsRes.data ?? []).map((r) => ({
      id: n(r.id), started_at: String(r.started_at), finished_at: (r.finished_at as string | null) ?? null,
      status: r.status as BoxmeSyncRun['status'], skus_seen: n(r.skus_seen), skus_written: n(r.skus_written),
      error: (r.error as string | null) ?? null, key_expires_at: (r.key_expires_at as string | null) ?? null,
    })),
  };
}, ['boxme-feed'], {tags: [POS_TAGS.boxme], revalidate: POS_CACHE_REVALIDATE});

/** The raw feed for this request: demo data, the cached tables, or the read error. */
const loadFeed = cache(async (): Promise<{feed: RawFeed; mock: boolean} | {error: string}> => {
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
