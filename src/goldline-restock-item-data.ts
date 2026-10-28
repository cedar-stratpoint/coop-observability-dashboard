import 'server-only';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {getForecastSettings, getGlCatalog, getGlStores, getGlSupplyRef, getStoreScope} from './goldline-ref-data';
import {itemDisplayName} from './goldline-item-name';
import {onHandOf, type InventoryRowIn} from './goldline-inventory';
import type {Shipment} from './goldline-supply';
import {forecastWindow, HOLD_REASONS, salesYear, type ForecastWindow, type MonthStatus} from './goldline-forecast';
import {runCycle, type Decision, type StoreCount} from './goldline-restock';
import {itemProjection, itemStoreLines, itemTotals, itemYear, sendOf, type ItemStoreLine, type ItemTotals, type ProjectionMonth, type SavedLine, type YearMonth} from './goldline-restock-item';

// Server-only reads behind the Restock product page (/stock/restock/<item>): the product's
// year of POS Sales Data (forecast_item_history), each store's latest count, holds, stock on
// the way, the warehouse, and the half month's saved run. Every store is read so the
// warehouse cap matches the run; what's shown is narrowed to a store-scoped role's stores.
// Company-fenced on every query.

const db = nichidoDb;
const firstOf = (month: string) => `${month}-01`;

export type RestockItemData = {
  item: {itemCode: string; name: string; productLine: string | null; skuLinked: boolean; retired: boolean};
  window: ForecastWindow;
  cycle: string;
  runSaved: boolean; // the half month's run exists
  stores: Array<{code: string; name: string | null}>; // stores in view with a line for this product
  store: string | null; // the store picked (null = all stores in view)
  year: YearMonth[];
  projection: ProjectionMonth[];
  lines: Array<ItemStoreLine & {name: string | null; send: number | null}>; // the picked store's line, or every store in view
  totals: ItemTotals;
  warehouse: {onHand: number | null; sample: boolean};
};

export async function getRestockItem(companyId: string, itemCode: string, runDate: string, store: string | null, storeScope?: string[] | null): Promise<RestockItemData | null> {
  if (!nichidoConfigured()) return null;
  const supa = db();
  const scope = storeScope ?? null;
  const settings = await getForecastSettings(companyId);
  const window = forecastWindow(runDate, settings);
  const yearMonths = salesYear(runDate);
  const cycle = runCycle(runDate);

  const [months, history, catalog, storeRows, scopeRows, supply, counts, snaps, flags, shipments, run] = await Promise.all([
    // pagination-ok: one row per requested month (12).
    supa.rpc('forecast_months', {p_company: companyId, p_months: yearMonths.map(firstOf)}),
    // pagination-ok: returns one jsonb value ({store: [units…]}), not rows.
    supa.rpc('forecast_item_history', {p_company: companyId, p_item: itemCode, p_months: yearMonths.map(firstOf), p_stores: null}),
    getGlCatalog(companyId),
    getGlStores(companyId),
    getStoreScope(companyId),
    getGlSupplyRef(companyId),
    fetchAllRows('inventory', (from, to) =>
      supa
        .from('inventory') // pagination-ok: paged by fetchAllRows (.range below)
        .select('id,store_code,item_code,period_end,stockroom,drawer,selling_area,delivery,ending_on_hand')
        .eq('company_id', companyId)
        .eq('item_code', itemCode)
        .order('id')
        .range(from, to),
    ) as unknown as Promise<Array<InventoryRowIn & {store_code: string; period_end: string}>>,
    // Each store's latest count of any item: a store whose latest form has no row for this
    // product is "blank on form", not "no count".
    fetchAllRows('inventory_snapshots', (from, to) =>
      supa
        .from('inventory_snapshots') // pagination-ok: paged by fetchAllRows (.range below)
        .select('store_code,period_end')
        .eq('company_id', companyId)
        .order('store_code')
        .order('period_end')
        .range(from, to),
    ) as unknown as Promise<Array<{store_code: string; period_end: string}>>,
    fetchAllRows('flags', (from, to) =>
      supa.from('flags').select('id,store_code').eq('company_id', companyId).eq('item_code', itemCode).eq('status', 'open').order('id').range(from, to), // pagination-ok: paged by fetchAllRows (.range below)
    ) as unknown as Promise<Array<{store_code: string}>>,
    fetchAllRows('shipments', (from, to) =>
      supa
        .from('shipments') // pagination-ok: paged by fetchAllRows (.range below)
        .select('id,store_code,item_code,qty,shipped_on,arrives_on')
        .eq('company_id', companyId)
        .eq('item_code', itemCode)
        .eq('status', 'in_transit')
        .order('id')
        .range(from, to),
    ) as unknown as Promise<Array<{id: string; store_code: string; item_code: string; qty: number; shipped_on: string; arrives_on: string}>>,
    // pagination-ok: one row by (company_id, cycle), unique.
    supa.from('restock_runs').select('id').eq('company_id', companyId).eq('cycle', cycle).maybeSingle(),
  ]);
  if (months.error) throw new Error(`forecast_months failed: ${months.error.message}`);
  if (history.error) throw new Error(`forecast_item_history failed: ${history.error.message}`);
  if (run.error) throw new Error(`restock_runs read failed: ${run.error.message}`);

  const p = catalog.find((x) => x.item_code === itemCode) ?? null;
  const hist = (history.data ?? {}) as Record<string, number[]>;
  if (!p && !counts.length && !Object.keys(hist).length) return null; // not this company's item

  const saved = new Map<string, SavedLine>();
  if (run.data) {
    const rows = (await fetchAllRows('recommendations', (from, to) =>
      supa
        .from('recommendations') // pagination-ok: paged by fetchAllRows (.range below)
        .select('id,store_code,raw_send,suggested,warehouse_short,holds,decision,final_qty,remark')
        .eq('company_id', companyId)
        .eq('run_id', run.data!.id)
        .eq('item_code', itemCode)
        .order('id')
        .range(from, to),
    )) as unknown as Array<{id: string; store_code: string; raw_send: number | null; suggested: number | null; warehouse_short: boolean; holds: string[] | null; decision: Decision; final_qty: number | null; remark: string | null}>;
    for (const r of rows) {
      saved.set(r.store_code, {
        id: r.id,
        rawSend: r.raw_send,
        suggested: r.suggested,
        warehouseShort: r.warehouse_short,
        holds: HOLD_REASONS.filter((h) => (r.holds ?? []).includes(h)),
        decision: r.decision,
        finalQty: r.final_qty,
        remark: r.remark,
      });
    }
  }

  const year: MonthStatus[] = ((months.data ?? []) as Array<{month: string; loaded: boolean; units: number | string; unlinked_units: number | string}>).map((m) => ({
    month: m.month.slice(0, 7),
    loaded: m.loaded,
    units: Number(m.units) || 0,
    unlinkedUnits: Number(m.unlinked_units) || 0,
  }));

  // Latest count per store; this product's on hand on it (null = blank row, absent = not on the form).
  const latestEnd = new Map<string, string>();
  for (const s of snaps) if ((latestEnd.get(s.store_code) ?? '') < s.period_end) latestEnd.set(s.store_code, s.period_end);
  const countMap = new Map<string, StoreCount>();
  for (const [storeCode, periodEnd] of latestEnd) countMap.set(storeCode, {periodEnd, onHand: new Map()});
  for (const r of counts) if (latestEnd.get(r.store_code) === r.period_end) countMap.get(r.store_code)!.onHand.set(itemCode, onHandOf(r).onHand);

  const winIdx = window.lastYear.map((m) => yearMonths.indexOf(m));
  const all = itemStoreLines({
    itemCode,
    window,
    months: year,
    history: Object.entries(hist).map(([storeCode, units]) => ({storeCode, units: winIdx.map((i) => Number(units[i]) || 0)})),
    inScope: new Set(scopeRows.filter((s) => s.in_scope).map((s) => s.store_code)),
    retired: Boolean(p?.retired_at),
    openFlagStores: new Set(flags.map((f) => f.store_code)),
    counts: countMap,
    shipments: shipments.map((s): Shipment => ({id: s.id, storeCode: s.store_code, itemCode: s.item_code, qty: s.qty, shippedOn: s.shipped_on, arrivesOn: s.arrives_on})),
    warehouse: supply.warehouse.find((w) => w.item_code === itemCode)?.on_hand ?? null,
    saved,
  });

  const nameOf = new Map(storeRows.map((s) => [s.store_code, s.name]));
  const visible = scope ? all.filter((l) => scope.includes(l.storeCode)) : all;
  const picked = store && visible.some((l) => l.storeCode === store) ? store : null;
  const shown = picked ? visible.filter((l) => l.storeCode === picked) : visible;

  // The year's bars and the totals cover the stores shown.
  const shownCodes = new Set(shown.map((l) => l.storeCode));
  const yearUnits = yearMonths.map((_, i) => Object.entries(hist).reduce((a, [s, u]) => a + (shownCodes.has(s) ? Number(u[i]) || 0 : 0), 0));
  const totals = itemTotals(shown, window.months.length);
  const loaded = new Set(year.filter((m) => m.loaded).map((m) => m.month));
  const yearUnitsAt = (month: string) => (loaded.has(month) ? (yearUnits[yearMonths.indexOf(month)] ?? 0) : null);
  const one = picked ? shown[0] : null;
  const have = one ? (one.state === 'held' ? null : Math.max(0, one.onHand ?? 0) + one.onTheWay) : totals.ready ? totals.onHand + totals.onTheWay : null;
  const send = one ? sendOf(one) : totals.ready ? totals.send : null;
  const w = supply.warehouse.find((x) => x.item_code === itemCode);

  return {
    item: {
      itemCode,
      name: p ? itemDisplayName(p.product_line, p.variant, itemCode) : itemCode,
      productLine: p?.product_line ?? null,
      skuLinked: Boolean(p?.sku_code?.trim()),
      retired: Boolean(p?.retired_at),
    },
    window,
    cycle,
    runSaved: Boolean(run.data),
    stores: visible.map((l) => ({code: l.storeCode, name: nameOf.get(l.storeCode) ?? null})),
    store: picked,
    year: itemYear(year, window, yearUnits),
    // Bars sell what every store shown sold; the stock line only follows stores with a number.
    projection: itemProjection({window, lastYearUnits: one ? one.lyUnits : totals.lyUnits, have, send}).map((m, i) => ({...m, units: yearUnitsAt(window.lastYear[i])})),
    lines: shown.map((l) => ({...l, name: nameOf.get(l.storeCode) ?? null, send: sendOf(l)})),
    totals,
    warehouse: {onHand: w?.on_hand ?? null, sample: Boolean(w?.is_sample)},
  };
}
