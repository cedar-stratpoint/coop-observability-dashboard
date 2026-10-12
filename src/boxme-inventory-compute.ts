// Pure logic for the BoxMe (Online) inventory channel. No I/O: the reader in
// boxme-inventory-data.ts loads the boxme_* tables (written daily by
// zoomy-observability's boxme-sync job) plus the POS catalog, and hands them here.
// Unit-tested in test/boxme-inventory-compute.test.ts.
//
// Two rules worth knowing:
//  - The sync never deletes. A stock/lot row the latest run did not see keeps an
//    older synced_at, so only rows synced at or after the latest successful run's
//    started_at count as current.
//  - BoxMe's own numbers are the truth. available = stock - reserved - awaiting is
//    BoxMe's definition; we never recompute it.

import {effectiveThreshold, type ForecastConfig, type ForecastStatus} from './pos-forecast-compute';

export type BoxmeStatus = ForecastStatus; // 'healthy' | 'low' | 'out', same as the Offline table

/** Days of cover at or under which an online SKU is Low (restocking BoxMe takes longer than an event top-up). */
export const ONLINE_LOW_COVER_DAYS = 14;
/** Minimum span of daily history before we trust a sales-speed estimate. */
export const MIN_HISTORY_DAYS = 7;
/** Hours after which the last good sync counts as stale (daily job + slack for a late GitHub run). */
export const STALE_AFTER_HOURS = 26;
/** Default "expiring soon" window when BoxMe has no expiry_threshold for the SKU. */
export const DEFAULT_EXPIRY_WINDOW_DAYS = 60;
/** Key-rotation warning window, matching the sync job's email reminder. */
export const KEY_WARN_DAYS = 14;
const NO_EXPIRY = '9999-12-31';
const DAY_MS = 86_400_000;

export interface BoxmeProduct {
  seller_sku: string;
  name: string;
  active: boolean;
  sale_price: number | null;
  min_quantity: number;
  expiry_threshold: number | null;
  image_url: string | null;
}
export interface BoxmeWarehouse {
  pickup_id: string;
  warehouse_code: string | null;
  pickup_name: string | null;
}
export interface BoxmeStockRow {
  seller_sku: string;
  pickup_id: string;
  stock: number;
  awaiting: number;
  reserved: number;
  available: number;
  incoming: number;
  damaged_stock: number;
  damaged_available: number;
  synced_at: string;
}
export interface BoxmeDailyRow {
  snapshot_date: string; // YYYY-MM-DD (Manila)
  seller_sku: string;
  pickup_id: string;
  stock: number;
  available: number;
}
export interface BoxmeLotRow {
  seller_sku: string;
  warehouse_code: string;
  batch_lot: string;
  expire_date: string;
  quantity: number;
  synced_at: string;
}
export interface BoxmeSyncRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'ok' | 'partial' | 'failed';
  skus_seen: number;
  skus_written: number;
  error: string | null;
  key_expires_at: string | null;
}
/** The POS side of a SKU, for the "Offline" column and the match panel. */
export interface PosRef {
  product_id: string;
  name: string;
  category: string | null;
  active: boolean;
  office: number;
  event: number;
}

export type SyncState = 'fresh' | 'partial' | 'stale' | 'failed' | 'never';
export interface SyncInfo {
  state: SyncState;
  lastRunAt: string | null;
  lastGoodAt: string | null; // finished_at of the latest ok/partial run
  lastGoodStartedAt: string | null; // cut-off for "current" rows
  ageHours: number | null; // since lastGoodAt
  error: string | null;
  skus: number;
  keyExpiresAt: string | null;
  keyDaysLeft: number | null;
}

export interface WarehouseSplit {
  pickup_id: string;
  label: string;
  available: number;
  stock: number;
  awaiting: number;
  incoming: number;
  damaged: number;
}
export interface NextExpiry {
  date: string;
  daysLeft: number;
  quantity: number;
  soon: boolean;
}
export interface BoxmeInventoryRow {
  sku: string;
  name: string;
  category: string | null;
  imageUrl: string | null;
  price: number | null;
  inPos: boolean;
  stock: number;
  available: number;
  awaiting: number;
  reserved: number;
  incoming: number;
  damaged: number;
  byWarehouse: WarehouseSplit[];
  offline: number | null; // Stratpoint Office + Event; null when the SKU is not in POS
  threshold: number;
  status: BoxmeStatus;
  nextExpiry: NextExpiry | null;
  soldPerDay: number | null; // null until MIN_HISTORY_DAYS of history
  lastsDays: number | null;
  historyDays: number;
}
export interface ExpiringLot {
  sku: string;
  name: string;
  warehouse_code: string;
  batch_lot: string;
  date: string;
  daysLeft: number;
  quantity: number;
}
export interface BoxmeInventoryResult {
  rows: BoxmeInventoryRow[];
  totals: {available: number; awaiting: number; reserved: number; incoming: number; damaged: number; stock: number};
  summary: {healthy: number; low: number; out: number; expiring: number; total: number};
  expiring: ExpiringLot[];
  posOnly: PosRef[]; // active POS products BoxMe does not stock
  boxmeOnly: string[]; // BoxMe SKUs POS does not know
  warehouses: BoxmeWarehouse[];
  sync: SyncInfo;
}

const toMs = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** Manila calendar day for an instant (YYYY-MM-DD). */
export function manilaDay(now: Date): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** Whole days from Manila "today" to a YYYY-MM-DD date (negative = past). */
export function daysUntil(date: string, now: Date): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${manilaDay(now)}T00:00:00Z`)) / DAY_MS);
}

/** Freshness of the BoxMe feed from the sync-run log (any order). */
export function syncInfo(runs: BoxmeSyncRun[], now: Date): SyncInfo {
  const sorted = [...runs].sort((a, b) => toMs(b.started_at) - toMs(a.started_at));
  const latest = sorted.find((r) => r.status !== 'running') ?? null;
  const good = sorted.find((r) => r.status === 'ok' || r.status === 'partial') ?? null;
  const keyExpiresAt = sorted.find((r) => r.key_expires_at)?.key_expires_at ?? null;
  const keyDaysLeft = keyExpiresAt ? Math.floor((toMs(keyExpiresAt) - now.getTime()) / DAY_MS) : null;
  const lastGoodAt = good ? good.finished_at ?? good.started_at : null;
  const ageHours = lastGoodAt ? (now.getTime() - toMs(lastGoodAt)) / 3_600_000 : null;

  let state: SyncState;
  if (!latest) state = 'never';
  else if (latest.status === 'failed') state = 'failed';
  else if (ageHours == null || ageHours > STALE_AFTER_HOURS) state = 'stale';
  else if (latest.status === 'partial') state = 'partial';
  else state = 'fresh';

  return {
    state,
    lastRunAt: latest ? latest.finished_at ?? latest.started_at : null,
    lastGoodAt,
    lastGoodStartedAt: good?.started_at ?? null,
    ageHours,
    error: latest && latest.status !== 'ok' ? latest.error : null,
    skus: good?.skus_seen ?? 0,
    keyExpiresAt,
    keyDaysLeft,
  };
}

/** Keep only rows written by the latest good run (the job never deletes). */
export function currentRows<T extends {synced_at: string}>(rows: T[], cutoff: string | null): T[] {
  if (!cutoff) return [];
  const c = toMs(cutoff);
  return rows.filter((r) => toMs(r.synced_at) >= c);
}

/**
 * Units per day leaving the warehouse, from day-over-day drops in physical stock
 * summed across warehouses. Rises (inbound deliveries, returns) are ignored, so a
 * restock day does not read as negative sales. Null until MIN_HISTORY_DAYS of span.
 */
export function salesSpeed(daily: BoxmeDailyRow[]): {soldPerDay: number | null; historyDays: number} {
  const byDay = new Map<string, number>();
  for (const r of daily) byDay.set(r.snapshot_date, (byDay.get(r.snapshot_date) ?? 0) + r.stock);
  const days = [...byDay.keys()].sort();
  if (days.length < 2) return {soldPerDay: null, historyDays: 0};
  const span = Math.round((Date.parse(days.at(-1)!) - Date.parse(days[0])) / DAY_MS);
  let out = 0;
  for (let i = 1; i < days.length; i++) out += Math.max(0, byDay.get(days[i - 1])! - byDay.get(days[i])!);
  if (span < MIN_HISTORY_DAYS) return {soldPerDay: null, historyDays: span};
  return {soldPerDay: out / span, historyDays: span};
}

/** Healthy / Low / Out for an online SKU. */
export function boxmeStatus(available: number, threshold: number, lastsDays: number | null): BoxmeStatus {
  if (available <= 0) return 'out';
  if (available <= threshold || (lastsDays != null && lastsDays <= ONLINE_LOW_COVER_DAYS)) return 'low';
  return 'healthy';
}

export interface BuildInput {
  products: BoxmeProduct[];
  warehouses: BoxmeWarehouse[];
  stock: BoxmeStockRow[];
  daily: BoxmeDailyRow[];
  lots: BoxmeLotRow[];
  runs: BoxmeSyncRun[];
  pos: PosRef[];
  config: ForecastConfig;
  now: Date;
}

export function buildBoxmeInventory(input: BuildInput): BoxmeInventoryResult {
  const {products, warehouses, daily, pos, config, now} = input;
  const sync = syncInfo(input.runs, now);
  const stock = currentRows(input.stock, sync.lastGoodStartedAt);
  const lots = currentRows(input.lots, sync.lastGoodStartedAt);

  const posById = new Map(pos.map((p) => [p.product_id, p]));
  const whLabel = new Map(warehouses.map((w) => [w.pickup_id, w.warehouse_code || w.pickup_name || w.pickup_id]));
  const stockBySku = group(stock, (r) => r.seller_sku);
  const dailyBySku = group(daily, (r) => r.seller_sku);
  const lotsBySku = group(lots, (r) => r.seller_sku);

  const expiring: ExpiringLot[] = [];
  const rows: BoxmeInventoryRow[] = products
    .filter((p) => p.active)
    .map((p) => {
      const s = stockBySku.get(p.seller_sku) ?? [];
      const sum = (k: keyof Pick<BoxmeStockRow, 'stock' | 'available' | 'awaiting' | 'reserved' | 'incoming' | 'damaged_stock'>) =>
        s.reduce((t, r) => t + (Number(r[k]) || 0), 0);
      const available = sum('available');
      const posRef = posById.get(p.seller_sku);
      const threshold = p.min_quantity > 0 ? p.min_quantity : effectiveThreshold(config, p.seller_sku);
      const {soldPerDay, historyDays} = salesSpeed(dailyBySku.get(p.seller_sku) ?? []);
      const lastsDays = soldPerDay && soldPerDay > 0 ? available / soldPerDay : null;

      const window = p.expiry_threshold ?? DEFAULT_EXPIRY_WINDOW_DAYS;
      const live = (lotsBySku.get(p.seller_sku) ?? []).filter((l) => l.quantity > 0 && l.expire_date !== NO_EXPIRY);
      live.sort((a, b) => a.expire_date.localeCompare(b.expire_date));
      let nextExpiry: NextExpiry | null = null;
      if (live.length) {
        const first = live[0];
        const qty = live.filter((l) => l.expire_date === first.expire_date).reduce((t, l) => t + l.quantity, 0);
        const daysLeft = daysUntil(first.expire_date, now);
        nextExpiry = {date: first.expire_date, daysLeft, quantity: qty, soon: daysLeft <= window};
      }
      for (const l of live) {
        const daysLeft = daysUntil(l.expire_date, now);
        if (daysLeft <= window) {
          expiring.push({sku: p.seller_sku, name: posRef?.name ?? cleanName(p.name), warehouse_code: l.warehouse_code, batch_lot: l.batch_lot, date: l.expire_date, daysLeft, quantity: l.quantity});
        }
      }

      return {
        sku: p.seller_sku,
        name: posRef?.name ?? cleanName(p.name),
        category: posRef?.category ?? null,
        imageUrl: p.image_url,
        price: p.sale_price,
        inPos: Boolean(posRef),
        stock: sum('stock'),
        available,
        awaiting: sum('awaiting'),
        reserved: sum('reserved'),
        incoming: sum('incoming'),
        damaged: sum('damaged_stock'),
        byWarehouse: s.map((r) => ({
          pickup_id: r.pickup_id,
          label: whLabel.get(r.pickup_id) ?? r.pickup_id,
          available: r.available,
          stock: r.stock,
          awaiting: r.awaiting,
          incoming: r.incoming,
          damaged: r.damaged_stock,
        })),
        offline: posRef ? posRef.office + posRef.event : null,
        threshold,
        status: boxmeStatus(available, threshold, lastsDays),
        nextExpiry,
        soldPerDay,
        lastsDays,
        historyDays,
      };
    });

  expiring.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  const boxmeSkus = new Set(products.map((p) => p.seller_sku));
  const totals = rows.reduce(
    (t, r) => ({
      available: t.available + r.available,
      awaiting: t.awaiting + r.awaiting,
      reserved: t.reserved + r.reserved,
      incoming: t.incoming + r.incoming,
      damaged: t.damaged + r.damaged,
      stock: t.stock + r.stock,
    }),
    {available: 0, awaiting: 0, reserved: 0, incoming: 0, damaged: 0, stock: 0},
  );

  return {
    rows,
    totals,
    summary: {
      healthy: rows.filter((r) => r.status === 'healthy').length,
      low: rows.filter((r) => r.status === 'low').length,
      out: rows.filter((r) => r.status === 'out').length,
      expiring: new Set(expiring.map((e) => e.sku)).size,
      total: rows.length,
    },
    expiring,
    posOnly: pos.filter((p) => p.active && !boxmeSkus.has(p.product_id)).sort((a, b) => a.name.localeCompare(b.name)),
    boxmeOnly: rows.filter((r) => !r.inPos).map((r) => r.sku),
    warehouses,
    sync,
  };
}

/** BoxMe names carry the brand prefix ("Zoomy! Meaty Treats Beef"); POS names don't. */
export function cleanName(name: string): string {
  return name.replace(/^Zoomy!\s*/i, '').trim();
}

function group<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const arr = m.get(k);
    if (arr) arr.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/** Client-side filter for the BoxMe table (line, status, search), mirroring filterInventoryRows. */
export function filterBoxmeRows(
  rows: BoxmeInventoryRow[],
  {line = '', status = '', search = ''}: {line?: string; status?: '' | BoxmeStatus | 'expiring'; search?: string},
): BoxmeInventoryRow[] {
  const q = search.trim().toLowerCase();
  return rows.filter((r) => {
    if (line && r.category !== line) return false;
    if (status === 'expiring' ? !r.nextExpiry?.soon : status && r.status !== status) return false;
    if (q && !r.name.toLowerCase().includes(q) && !r.sku.toLowerCase().includes(q)) return false;
    return true;
  });
}
