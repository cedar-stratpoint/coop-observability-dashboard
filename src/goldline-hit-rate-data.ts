import 'server-only';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {getGlCatalog, getGlStores} from './goldline-ref-data';
import {itemDisplayName} from './goldline-item-name';
import type {DecidedLine} from './goldline-hit-rate';

// Server-only read behind the Restock "Hit or miss" tab: the decided restock lines of the
// last N runs (restock_decisions(), one jsonb array, no row cap), narrowed to a
// store-scoped role's stores, plus item and store names from the cached catalog and
// store list. The board adds them up in the browser (src/goldline-hit-rate.ts) so its
// filters don't reload.

export const HIT_RANGES = [6, 12] as const; // runs; null = every run
export type HitRange = (typeof HIT_RANGES)[number] | null;

export type HitRateData = {
  configured: boolean;
  range: HitRange;
  lines: DecidedLine[];
  itemNames: Record<string, string>;
  storeNames: Record<string, string>;
};

type Row = {
  cycle: string;
  run_date: string;
  store_code: string;
  item_code: string;
  product_line: string | null;
  decision: DecidedLine['decision'];
  suggested: number | null;
  final_qty: number | null;
  remark: string | null;
  decided_by: string | null;
  decided_at: string | null;
};

export async function getHitRate(companyId: string, storeScope: string[] | null, range: HitRange): Promise<HitRateData> {
  const empty: HitRateData = {configured: nichidoConfigured(), range, lines: [], itemNames: {}, storeNames: {}};
  if (!nichidoConfigured()) return empty;
  const [res, catalog, stores] = await Promise.all([
    nichidoDb().rpc('restock_decisions', {p_company: companyId, p_stores: storeScope, p_runs: range}),
    getGlCatalog(companyId),
    getGlStores(companyId),
  ]);
  if (res.error) throw new Error(`restock_decisions failed: ${res.error.message}`);
  const rows = (res.data ?? []) as Row[];
  const used = new Set(rows.map((r) => r.item_code));
  const usedStores = new Set(rows.map((r) => r.store_code));
  return {
    configured: true,
    range,
    lines: rows.map((r) => ({
      cycle: r.cycle,
      runDate: r.run_date,
      storeCode: r.store_code,
      itemCode: r.item_code,
      productLine: r.product_line,
      decision: r.decision,
      suggested: r.suggested,
      finalQty: r.final_qty,
      remark: r.remark,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
    })),
    // Only the names the board shows, so the page payload stays small.
    itemNames: Object.fromEntries(catalog.filter((p) => used.has(p.item_code)).map((p) => [p.item_code, itemDisplayName(p.product_line, p.variant, p.item_code)])),
    storeNames: Object.fromEntries(stores.filter((s) => usedStores.has(s.store_code)).map((s) => [s.store_code, s.name])),
  };
}
