// The BoxMe feed rows -> typed rows, shared by the Inventory page (src/boxme-inventory-data.ts) and Ask Coop
// (src/chat/read/boxme-data.ts) so both read the same columns and compute with buildBoxmeInventory. Pure, no I/O.
import type {BoxmeDailyRow, BoxmeLotRow, BoxmeProduct, BoxmeStockRow, BoxmeSyncRun, BoxmeWarehouse} from './boxme-inventory-compute';

/** Days of daily snapshots read for the sales-speed estimate. */
export const BOXME_HISTORY_DAYS = 35;

/** Explicit columns per feed relation (never `*`). Sync runs leave out the error text and the API key expiry: the chat never needs them. */
export const BOXME_COLUMNS = Object.freeze({
  products: 'seller_sku,name,active,sale_price,min_quantity,expiry_threshold,image_url',
  warehouses: 'pickup_id,warehouse_code,pickup_name',
  stock: 'seller_sku,pickup_id,stock,awaiting,reserved,available,incoming,damaged_stock,damaged_available,synced_at',
  daily: 'snapshot_date,seller_sku,pickup_id,stock,available',
  lots: 'seller_sku,warehouse_code,batch_lot,expire_date,quantity,synced_at',
  runs: 'id,started_at,finished_at,status,skus_seen,skus_written',
});

export interface BoxmeFeed {
  products: BoxmeProduct[];
  warehouses: BoxmeWarehouse[];
  stock: BoxmeStockRow[];
  daily: BoxmeDailyRow[];
  lots: BoxmeLotRow[];
  runs: BoxmeSyncRun[];
}

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0) || 0;
const s = (v: unknown): string | null => (v == null ? null : String(v));

export function mapBoxmeFeed(raw: {products: Row[]; warehouses: Row[]; stock: Row[]; daily: Row[]; lots: Row[]; runs: Row[]}): BoxmeFeed {
  return {
    products: raw.products.map((p) => ({
      seller_sku: String(p.seller_sku), name: String(p.name ?? p.seller_sku), active: p.active !== false,
      sale_price: p.sale_price == null ? null : n(p.sale_price), min_quantity: n(p.min_quantity),
      expiry_threshold: p.expiry_threshold == null ? null : n(p.expiry_threshold), image_url: s(p.image_url),
    })),
    warehouses: raw.warehouses.map((w) => ({pickup_id: String(w.pickup_id), warehouse_code: s(w.warehouse_code), pickup_name: s(w.pickup_name)})),
    stock: raw.stock.map((r) => ({
      seller_sku: String(r.seller_sku), pickup_id: String(r.pickup_id), stock: n(r.stock), awaiting: n(r.awaiting), reserved: n(r.reserved),
      available: n(r.available), incoming: n(r.incoming), damaged_stock: n(r.damaged_stock), damaged_available: n(r.damaged_available), synced_at: String(r.synced_at),
    })),
    daily: raw.daily.map((r) => ({snapshot_date: String(r.snapshot_date), seller_sku: String(r.seller_sku), pickup_id: String(r.pickup_id), stock: n(r.stock), available: n(r.available)})),
    lots: raw.lots.map((l) => ({
      seller_sku: String(l.seller_sku), warehouse_code: String(l.warehouse_code), batch_lot: String(l.batch_lot ?? ''),
      expire_date: String(l.expire_date), quantity: n(l.quantity), synced_at: String(l.synced_at),
    })),
    runs: raw.runs.map((r) => ({
      id: n(r.id), started_at: String(r.started_at), finished_at: s(r.finished_at),
      status: r.status as BoxmeSyncRun['status'], skus_seen: n(r.skus_seen), skus_written: n(r.skus_written),
      error: s(r.error), key_expires_at: s(r.key_expires_at),
    })),
  };
}
