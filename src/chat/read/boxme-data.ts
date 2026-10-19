// Loads the BoxMe (online warehouse) feed for Ask Coop (plan knowledge/tasks/2026-10-19-ask-coop-inventory-plan.md, B2) through the
// guarded chat read client: the same columns and row mapping as the Inventory page (src/boxme-feed.ts), so both compute with
// buildBoxmeInventory. Never throws: missing views or a failed read is null, and the chat says BoxMe is not connected (never 0).
import {fetchAllRows} from '../../pos-fetch-paginate';
import {BOXME_HISTORY_DAYS, mapBoxmeFeed, type BoxmeFeed} from '../../boxme-feed';
import {relationsForMode, type ChatReadMode} from './relations';
import type {StockReadClient} from './stock-data';

export async function loadBoxmeData(client: StockReadClient, mode: ChatReadMode, now: Date): Promise<BoxmeFeed | null> {
  try {
    const {tables, columns} = relationsForMode(mode);
    const since = new Date(now.getTime() - BOXME_HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
    const [products, warehouses, stock, daily, lots, runs] = await Promise.all([
      fetchAllRows(tables.boxmeProducts, (from, to) => client.from(tables.boxmeProducts).select(columns.boxmeProducts).order('seller_sku', {ascending: true}).range(from, to)),
      fetchAllRows(tables.boxmeWarehouses, (from, to) => client.from(tables.boxmeWarehouses).select(columns.boxmeWarehouses).order('pickup_id', {ascending: true}).range(from, to)),
      fetchAllRows(tables.boxmeStock, (from, to) =>
        client.from(tables.boxmeStock).select(columns.boxmeStock).order('seller_sku', {ascending: true}).order('pickup_id', {ascending: true}).range(from, to)),
      fetchAllRows(tables.boxmeDaily, (from, to) =>
        client.from(tables.boxmeDaily).select(columns.boxmeDaily).gte('snapshot_date', since)
          .order('snapshot_date', {ascending: true}).order('seller_sku', {ascending: true}).order('pickup_id', {ascending: true}).range(from, to)),
      fetchAllRows(tables.boxmeLots, (from, to) =>
        client.from(tables.boxmeLots).select(columns.boxmeLots)
          .order('seller_sku', {ascending: true}).order('warehouse_code', {ascending: true}).order('batch_lot', {ascending: true}).order('expire_date', {ascending: true}).range(from, to)),
      // an async wrapper: a synchronous throw here must reject this one promise, not leave the others unhandled
      (async () => client.from(tables.boxmeRuns).select(columns.boxmeRuns).order('started_at', {ascending: false}).limit(20))(),
    ]);
    if (runs.error) return null;
    return mapBoxmeFeed({products, warehouses, stock, daily, lots, runs: runs.data ?? []});
  } catch {
    return null;
  }
}
