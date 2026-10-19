// BoxMe (online warehouse) stock for Ask Coop (plan knowledge/tasks/2026-10-19-ask-coop-inventory-plan.md, B3/B4). Pure.
// Builds the SAME view as the Inventory page's BoxMe channel (buildBoxmeInventory: current rows of the last good sync, status,
// days left, expiring lots) and says how fresh it is. BoxMe is synced once a day and fetches stock only: its "sold per day" is an
// estimate from day-over-day stock drops, never orders.
import {buildBoxmeInventory, syncInfo, type BoxmeInventoryResult, type PosRef} from '../boxme-inventory-compute';
import {parseStockConfig} from '../pos-stock-config';
import type {MetricData} from './result-types';

export interface OnlineView {
  result: BoxmeInventoryResult;
  /** A stale, failed or partial sync: placed first in the caveats, to be said before any figure. */
  warnings: string[];
  /** The as-of line. */
  basis: string;
}

/** "2026-10-19 09:31 PHT". */
export const phtStamp = (iso: string): string => `${new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} PHT`;

export const NOT_CONNECTED = 'BoxMe (online) stock is not connected here, so there are no online figures.';
export const SPEED_BASIS = 'BoxMe "sold per day" is estimated from day-over-day drops in BoxMe stock (restock days ignored, needs 7 days of daily snapshots); it is not an order count.';

/** The BoxMe view for this request, or why there is none. `undefined` data means BoxMe is not loaded here; null means the read failed. */
export function onlineStock(data: MetricData, now: Date): OnlineView | {error: string} {
  const feed = data.boxme;
  if (!feed) return {error: NOT_CONNECTED};
  const sync = syncInfo(feed.runs, now);
  if (!sync.lastGoodAt) {
    return {error: sync.state === 'failed' ? 'The BoxMe sync has failed and there is no earlier good sync, so there are no online figures.' : 'BoxMe has never synced here, so there are no online figures.'};
  }
  const s = data.stock;
  const pos: PosRef[] = Object.entries(s?.names ?? {}).map(([id, name]) => {
    const at = (loc: string) => s?.byLocation.filter((r) => r.product_id === id && r.location === loc).reduce((n, r) => n + r.stock, 0) ?? 0;
    return {product_id: id, name, category: null, active: true, office: at('office'), event: at('event')};
  });
  const result = buildBoxmeInventory({...feed, pos, config: s?.config ?? parseStockConfig(undefined), now});
  const warnings: string[] = [];
  if (sync.state === 'stale') warnings.push(`The BoxMe figures are ${Math.round(sync.ageHours ?? 0)} hours old (older than a day): the daily sync has not run since.`);
  if (sync.state === 'failed') warnings.push('The latest BoxMe sync failed, so these are the figures from the last good sync.');
  if (sync.state === 'partial') warnings.push('The last BoxMe sync was partial: lot and expiry details may be missing.');
  return {result, warnings, basis: `BoxMe (online) stock as of the last good sync, ${phtStamp(sync.lastGoodAt)}; BoxMe syncs once a day.`};
}
