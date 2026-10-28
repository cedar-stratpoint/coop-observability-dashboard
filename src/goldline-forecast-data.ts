import 'server-only';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {getForecastSettings, getGlCatalog, getGlStores, getStoreScope} from './goldline-ref-data';
import {itemDisplayName} from './goldline-item-name';
import {
  buildForecastLines,
  DEFAULT_FORECAST_SETTINGS,
  forecastSummary,
  forecastWindow,
  salesYear,
  storeRollup,
  type ForecastLine,
  type ForecastSettings,
  type ForecastSummary,
  type ForecastWindow,
  type MonthStatus,
  type StoreRollup,
} from './goldline-forecast';

// Server-only reads behind the Restock page's forecast inputs (F10): last year's sales
// for the run's window (forecast_history, one jsonb value), which months are loaded
// (forecast_months), and what holds a line: store scope, retired products, open flags.
// Company-fenced on every query and narrowed to a store-scoped role's stores.
// Sales are read fresh (they change with every Watsons upload); settings, catalog,
// stores and scope come from the cached reference data.

const db = nichidoDb;

export type ForecastData = {
  configured: boolean;
  settings: ForecastSettings;
  window: ForecastWindow;
  year: MonthStatus[]; // the 12 months before the run, for the month strip
  summary: ForecastSummary;
  stores: Array<StoreRollup & {name: string | null}>;
  store: string | null; // the store picked, if any
  lines: Array<ForecastLine & {name: string}>; // that store's lines (empty for all stores)
};

const firstOf = (month: string) => `${month}-01`;

export async function getForecastData(companyId: string, runDate: string, store: string | null, storeScope?: string[] | null): Promise<ForecastData> {
  const settings = nichidoConfigured() ? await getForecastSettings(companyId) : DEFAULT_FORECAST_SETTINGS;
  const window = forecastWindow(runDate, settings);
  const yearMonths = salesYear(runDate);
  const emptyYear = yearMonths.map((month) => ({month, loaded: false, units: 0, unlinkedUnits: 0}));
  if (!nichidoConfigured()) {
    return {configured: false, settings, window, year: emptyYear, summary: forecastSummary([], window, emptyYear), stores: [], store: null, lines: []};
  }

  const supa = db();
  const scope = storeScope ?? null;
  const [months, history, scopeRows, catalog, storeRows, flags, counts] = await Promise.all([
    // pagination-ok: one row per requested month (12).
    supa.rpc('forecast_months', {p_company: companyId, p_months: yearMonths.map(firstOf)}),
    // pagination-ok: returns one jsonb value ({store: {item: [units…]}}), not rows.
    supa.rpc('forecast_history', {p_company: companyId, p_months: window.lastYear.map(firstOf), p_stores: scope}),
    getStoreScope(companyId),
    getGlCatalog(companyId),
    getGlStores(companyId),
    fetchAllRows('flags', (from, to) => {
      let q = supa.from('flags').select('id,store_code,item_code').eq('company_id', companyId).eq('status', 'open'); // pagination-ok: paged by fetchAllRows (.range below)
      if (scope) q = q.in('store_code', scope);
      return q.order('id').range(from, to);
    }),
    fetchAllRows('inventory', (from, to) => {
      let q = supa.from('inventory').select('id,store_code,item_code,period_end').eq('company_id', companyId); // pagination-ok: paged by fetchAllRows (.range below)
      if (scope) q = q.in('store_code', scope);
      return q.order('id').range(from, to);
    }),
  ]);
  if (months.error) throw new Error(`forecast_months failed: ${months.error.message}`);
  if (history.error) throw new Error(`forecast_history failed: ${history.error.message}`);

  const year: MonthStatus[] = ((months.data ?? []) as Array<{month: string; loaded: boolean; units: number | string; unlinked_units: number | string}>).map((m) => ({
    month: m.month.slice(0, 7),
    loaded: m.loaded,
    units: Number(m.units) || 0,
    unlinkedUnits: Number(m.unlinked_units) || 0,
  }));

  const hist = (history.data ?? {}) as Record<string, Record<string, number[]>>;
  const historyRows = Object.entries(hist).flatMap(([storeCode, items]) => Object.entries(items).map(([itemCode, units]) => ({storeCode, itemCode, units})));

  // Pairs on each store's latest count (F9), so a product that didn't sell last year shows up.
  const latestEnd = new Map<string, string>();
  for (const r of counts as Array<{store_code: string; period_end: string}>) {
    if ((latestEnd.get(r.store_code) ?? '') < r.period_end) latestEnd.set(r.store_code, r.period_end);
  }
  const counted = (counts as Array<{store_code: string; item_code: string; period_end: string}>)
    .filter((r) => latestEnd.get(r.store_code) === r.period_end)
    .map((r) => ({storeCode: r.store_code, itemCode: r.item_code}));

  const inScope = new Set(scopeRows.filter((s) => s.in_scope).map((s) => s.store_code));
  const retired = new Set(catalog.filter((p) => p.retired_at).map((p) => p.item_code));
  const openFlags = new Set((flags as Array<{store_code: string; item_code: string}>).map((f) => `${f.store_code}|${f.item_code}`));
  const all = buildForecastLines({window, months: year, history: historyRows, inScope, retired, openFlags, counted});

  const storeName = new Map(storeRows.map((s) => [s.store_code, s.name]));
  const itemName = new Map(catalog.map((p) => [p.item_code, itemDisplayName(p.product_line, p.variant, p.item_code)]));
  const picked = store && (!scope || scope.includes(store)) ? store : null;

  return {
    configured: true,
    settings,
    window,
    year,
    summary: forecastSummary(all, window, year),
    stores: storeRollup(all, inScope).map((r) => ({...r, name: storeName.get(r.storeCode) ?? null})),
    store: picked,
    lines: picked ? all.filter((l) => l.storeCode === picked).map((l) => ({...l, name: itemName.get(l.itemCode) ?? l.itemCode})) : [],
  };
}
