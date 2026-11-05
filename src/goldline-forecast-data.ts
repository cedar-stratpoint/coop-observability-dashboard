import 'server-only';
import {gunzipSync, gzipSync} from 'node:zlib';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {cachedSalesView, getForecastSettings, getGlCatalog, getGlStores, getStoreScope} from './goldline-ref-data';
import {itemDisplayName} from './goldline-item-name';
import type {InventoryRowIn} from './goldline-inventory';
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
// Settings, catalog, stores and scope come from the cached reference data.

const db = nichidoDb;

// The sales reads (forecast_months, forecast_history, forecast_item_history) decrypt
// every sales row they touch, 2 to 5 s a call on Staging, so they're cached like the
// sales totals: under the committed sales files (cachedSalesView), expired by a sales
// write and by SKU linking (the catalog tag: they split units by product).

export type ForecastMonthRow = {month: string; loaded: boolean; units: number | string; unlinked_units: number | string};

/** forecast_months for these months (first-of-month dates), cached. */
export function forecastMonths(companyId: string, months: string[]): Promise<ForecastMonthRow[]> {
  return cachedSalesView(
    companyId,
    ['forecast-months', months.join(',')],
    async () => {
      // pagination-ok: one row per requested month (12).
      const {data, error} = await db().rpc('forecast_months', {p_company: companyId, p_months: months});
      if (error) throw new Error(`forecast_months failed: ${error.message}`);
      return (data ?? []) as ForecastMonthRow[];
    },
    ['sales', 'catalog'],
  );
}

/** forecast_history ({store: {item: [units…]}}), cached. Every store's history is about
 *  2.7 MB of JSON, over the data cache's 2 MB an entry, so it's kept gzipped. */
export async function forecastHistory(companyId: string, months: string[], stores: string[] | null): Promise<Record<string, Record<string, number[]>>> {
  const packed = await cachedSalesView(
    companyId,
    ['forecast-history', months.join(','), stores ? stores.join(',') : '*'],
    async () => {
      // pagination-ok: returns one jsonb value ({store: {item: [units…]}}), not rows.
      const {data, error} = await db().rpc('forecast_history', {p_company: companyId, p_months: months, p_stores: stores});
      if (error) throw new Error(`forecast_history failed: ${error.message}`);
      return gzipSync(JSON.stringify(data ?? {})).toString('base64');
    },
    ['sales', 'catalog'],
  );
  return JSON.parse(gunzipSync(Buffer.from(packed, 'base64')).toString('utf8'));
}

/** forecast_item_history ({store: [units…]}) for one product, cached. */
export function forecastItemHistory(companyId: string, itemCode: string, months: string[]): Promise<Record<string, number[]>> {
  return cachedSalesView(
    companyId,
    ['forecast-item-history', itemCode, months.join(',')],
    async () => {
      // pagination-ok: returns one jsonb value ({store: [units…]}), not rows.
      const {data, error} = await db().rpc('forecast_item_history', {p_company: companyId, p_item: itemCode, p_months: months, p_stores: null});
      if (error) throw new Error(`forecast_item_history failed: ${error.message}`);
      return (data ?? {}) as Record<string, number[]>;
    },
    ['sales', 'catalog'],
  );
}

export type ForecastData = {
  configured: boolean;
  settings: ForecastSettings;
  window: ForecastWindow;
  year: MonthStatus[]; // the 12 months before the run, for the month strip
  storeYear: number[] | null; // the picked store's units in those months (linked SKUs), else null
  summary: ForecastSummary;
  stores: Array<StoreRollup & {name: string | null}>;
  store: string | null; // the store picked, if any
  lines: Array<ForecastLine & {name: string}>; // that store's lines (empty for all stores)
};

const firstOf = (month: string) => `${month}-01`;

/** F10's inputs for a run, before any store is picked. Shared with the restock (F11). */
export type ForecastBase = {
  settings: ForecastSettings;
  window: ForecastWindow;
  year: MonthStatus[];
  lines: ForecastLine[]; // every store × item, holds included
  inScope: Set<string>;
  latestCounts: Array<InventoryRowIn & {store_code: string; period_end: string}>; // each store's latest count
  storeName: Map<string, string | null>;
  itemName: Map<string, string>;
};

/** Reads and builds F10's lines. Nichido must be configured (callers check first). */
export async function loadForecastBase(companyId: string, runDate: string, storeScope?: string[] | null): Promise<ForecastBase> {
  const settings = await getForecastSettings(companyId);
  const window = forecastWindow(runDate, settings);
  const yearMonths = salesYear(runDate);
  const supa = db();
  const scope = storeScope ?? null;
  const [months, hist, scopeRows, catalog, storeRows, flags, counts] = await Promise.all([
    forecastMonths(companyId, yearMonths.map(firstOf)),
    forecastHistory(companyId, window.lastYear.map(firstOf), scope),
    getStoreScope(companyId),
    getGlCatalog(companyId),
    getGlStores(companyId),
    fetchAllRows('flags', (from, to) => {
      let q = supa.from('flags').select('id,store_code,item_code').eq('company_id', companyId).eq('status', 'open'); // pagination-ok: paged by fetchAllRows (.range below)
      if (scope) q = q.in('store_code', scope);
      return q.order('id').range(from, to);
    }),
    fetchAllRows('inventory', (from, to) => {
      let q = supa
        .from('inventory') // pagination-ok: paged by fetchAllRows (.range below)
        .select('id,store_code,item_code,period_end,stockroom,drawer,selling_area,delivery,ending_on_hand')
        .eq('company_id', companyId);
      if (scope) q = q.in('store_code', scope);
      return q.order('id').range(from, to);
    }),
  ]);
  const year: MonthStatus[] = months.map((m) => ({
    month: m.month.slice(0, 7),
    loaded: m.loaded,
    units: Number(m.units) || 0,
    unlinkedUnits: Number(m.unlinked_units) || 0,
  }));

  const historyRows = Object.entries(hist).flatMap(([storeCode, items]) => Object.entries(items).map(([itemCode, units]) => ({storeCode, itemCode, units})));

  // Each store's latest count (F9): its rows give on hand, and its pairs show up even when
  // the product didn't sell last year.
  type CountRow = InventoryRowIn & {store_code: string; period_end: string};
  const latestEnd = new Map<string, string>();
  for (const r of counts as unknown as CountRow[]) {
    if ((latestEnd.get(r.store_code) ?? '') < r.period_end) latestEnd.set(r.store_code, r.period_end);
  }
  const latestCounts = (counts as unknown as CountRow[]).filter((r) => latestEnd.get(r.store_code) === r.period_end);
  const counted = latestCounts.map((r) => ({storeCode: r.store_code, itemCode: r.item_code}));

  const inScope = new Set(scopeRows.filter((s) => s.in_scope).map((s) => s.store_code));
  const retired = new Set(catalog.filter((p) => p.retired_at).map((p) => p.item_code));
  const openFlags = new Set((flags as Array<{store_code: string; item_code: string}>).map((f) => `${f.store_code}|${f.item_code}`));
  const lines = buildForecastLines({window, months: year, history: historyRows, inScope, retired, openFlags, counted});

  return {
    settings,
    window,
    year,
    lines,
    inScope,
    latestCounts,
    storeName: new Map(storeRows.map((s) => [s.store_code, s.name])),
    itemName: new Map(catalog.map((p) => [p.item_code, itemDisplayName(p.product_line, p.variant, p.item_code)])),
  };
}

export async function getForecastData(companyId: string, runDate: string, store: string | null, storeScope?: string[] | null): Promise<ForecastData> {
  if (!nichidoConfigured()) {
    const settings = DEFAULT_FORECAST_SETTINGS;
    const window = forecastWindow(runDate, settings);
    const emptyYear = salesYear(runDate).map((month) => ({month, loaded: false, units: 0, unlinkedUnits: 0}));
    return {configured: false, settings, window, year: emptyYear, storeYear: null, summary: forecastSummary([], window, emptyYear), stores: [], store: null, lines: []};
  }
  const scope = storeScope ?? null;
  const {settings, window, year, lines: all, inScope, storeName, itemName} = await loadForecastBase(companyId, runDate, scope);
  const picked = store && (!scope || scope.includes(store)) ? store : null;

  // The month strip for one store: its own units per month, every product added up.
  let storeYear: number[] | null = null;
  if (picked) {
    const months = salesYear(runDate);
    const items = Object.values((await forecastHistory(companyId, months.map(firstOf), [picked]))[picked] ?? {});
    storeYear = months.map((_, i) => items.reduce((a, u) => a + (Number(u[i]) || 0), 0));
  }

  return {
    configured: true,
    settings,
    window,
    year,
    storeYear,
    summary: forecastSummary(all, window, year),
    stores: storeRollup(all, inScope).map((r) => ({...r, name: storeName.get(r.storeCode) ?? null})),
    store: picked,
    lines: picked ? all.filter((l) => l.storeCode === picked).map((l) => ({...l, name: itemName.get(l.itemCode) ?? l.itemCode})) : [],
  };
}
