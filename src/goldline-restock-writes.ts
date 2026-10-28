import 'server-only';
import {nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {getGlSupplyRef} from './goldline-ref-data';
import {loadForecastBase} from './goldline-forecast-data';
import {onHandOf} from './goldline-inventory';
import type {Shipment} from './goldline-supply';
import {buildRecommendations, runCycle, splitForSave, type Decision, type StoreCount} from './goldline-restock';

// Server-only writes for the restock (F11): make a half month's run, and record the
// owner's decisions. Callers (app/stock/actions.ts) have already authorized the company,
// role and store scope; every statement here is still company-fenced.

const db = nichidoDb;

export class RestockError extends Error {
  constructor(public code: 'remark_required' | 'bad_qty' | 'over_warehouse' | 'edit_one' | 'nothing_changed') {
    super(code);
  }
}

/**
 * Work out every line for `runDate` and save the run for its half month. Lines the owner
 * already decided keep their numbers; their approved units are taken off the warehouse
 * before the pending lines are capped. Always company-wide (the warehouse serves every store).
 */
export async function makeRestockRun(companyId: string, runDate: string, by: string | null): Promise<{id: string; saved: number}> {
  const supa = db();
  const cycle = runCycle(runDate);
  // pagination-ok: one row by (company_id, cycle), unique.
  const existing = await supa.from('restock_runs').select('id').eq('company_id', companyId).eq('cycle', cycle).maybeSingle();
  if (existing.error) throw new Error(`restock_runs read failed: ${existing.error.message}`);

  const [base, supply, shipments, decided] = await Promise.all([
    loadForecastBase(companyId, runDate, null),
    getGlSupplyRef(companyId),
    fetchAllRows('shipments', (from, to) =>
      supa
        .from('shipments') // pagination-ok: paged by fetchAllRows (.range below)
        .select('id,store_code,item_code,qty,shipped_on,arrives_on')
        .eq('company_id', companyId)
        .eq('status', 'in_transit')
        .order('id')
        .range(from, to),
    ) as unknown as Promise<Array<{id: string; store_code: string; item_code: string; qty: number; shipped_on: string; arrives_on: string}>>,
    existing.data
      ? (fetchAllRows('recommendations', (from, to) =>
          supa
            .from('recommendations') // pagination-ok: paged by fetchAllRows (.range below)
            .select('id,store_code,item_code,decision,final_qty')
            .eq('company_id', companyId)
            .eq('run_id', existing.data!.id)
            .neq('decision', 'pending')
            .order('id')
            .range(from, to),
        ) as unknown as Promise<Array<{store_code: string; item_code: string; decision: Decision; final_qty: number | null}>>)
      : Promise.resolve([]),
  ]);

  const counts = new Map<string, StoreCount>();
  for (const r of base.latestCounts) {
    const c = counts.get(r.store_code) ?? {periodEnd: r.period_end, onHand: new Map<string, number | null>()};
    c.onHand.set(r.item_code, onHandOf(r).onHand);
    counts.set(r.store_code, c);
  }
  const reserved: Record<string, number> = {};
  const decidedPairs = new Set<string>();
  for (const d of decided) {
    decidedPairs.add(`${d.store_code}|${d.item_code}`);
    if (d.decision !== 'rejected') reserved[d.item_code] = (reserved[d.item_code] ?? 0) + (d.final_qty ?? 0);
  }
  const ship: Shipment[] = shipments.map((s) => ({id: s.id, storeCode: s.store_code, itemCode: s.item_code, qty: s.qty, shippedOn: s.shipped_on, arrivesOn: s.arrives_on}));

  const recs = buildRecommendations({
    lines: base.lines.filter((l) => !decidedPairs.has(`${l.storeCode}|${l.itemCode}`)),
    counts,
    shipments: ship,
    warehouse: Object.fromEntries(supply.warehouse.map((w) => [w.item_code, w.on_hand])),
    reserved,
  });
  const {keep, skipped} = splitForSave(recs);

  const {data, error} = await supa.rpc('save_restock_run', {
    p_company: companyId,
    p_cycle: cycle,
    p_run_date: runDate,
    p_months: base.window.months,
    p_last_year: base.window.lastYear,
    p_window: base.settings.windowMonths,
    p_safety: base.settings.safetyMonths,
    p_skipped: skipped,
    p_lines: keep.map((r) => ({
      store_code: r.storeCode,
      item_code: r.itemCode,
      ly_units: r.lyUnits,
      need: r.need,
      safety: r.safety,
      on_hand: r.onHand,
      on_hand_period_end: r.onHandPeriodEnd,
      on_the_way: r.onTheWay,
      raw_send: r.rawSend,
      suggested: r.suggested,
      warehouse_short: r.warehouseShort,
      holds: r.holds,
    })),
    p_by: by,
  });
  if (error) throw new Error(`save_restock_run failed: ${error.message}`);
  return {id: data as string, saved: keep.length};
}

/** Approve, edit, reject or undo. Returns how many lines changed. */
export async function decideRecommendations(
  companyId: string,
  scope: string[] | null,
  input: {ids: string[]; decision: Decision; qty: number | null; remark: string | null; by: string | null},
): Promise<number> {
  const {data, error} = await db().rpc('decide_recommendations', {
    p_company: companyId,
    p_ids: input.ids,
    p_decision: input.decision,
    p_qty: input.qty,
    p_remark: input.remark,
    p_by: input.by,
    p_stores: scope,
  });
  if (error) {
    const code = (['remark_required', 'bad_qty', 'over_warehouse', 'edit_one'] as const).find((c) => (error.message ?? '').includes(c));
    if (code) throw new RestockError(code);
    throw new Error(`decide_recommendations failed: ${error.message}`);
  }
  const changed = Number(data) || 0;
  if (!changed) throw new RestockError('nothing_changed');
  return changed;
}
