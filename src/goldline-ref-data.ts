import 'server-only';
import {unstable_cache} from 'next/cache';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {clampSettings, DEFAULT_FORECAST_SETTINGS, type ForecastSettings} from './goldline-forecast';

// Cached Goldline reference data — the small, rarely-changing tables nearly every
// Goldline page reads: the catalog, the store list, and the supply side (settings,
// lead times, warehouse stock). Cached per company across requests (Next data cache)
// for up to REVALIDATE_SECONDS, and expired immediately by the writes that change them
// (see glTags + app/stock/actions.ts), so an edit shows on the next load.
//
// Never cached here: counts, sales, uploads, shipments — they change with every
// upload / action and are big; they're read fresh.

const REVALIDATE_SECONDS = 600;

const db = nichidoDb;

export const glTags = {
  catalog: (companyId: string) => `gl-catalog:${companyId}`,
  stores: (companyId: string) => `gl-stores:${companyId}`,
  supply: (companyId: string) => `gl-supply:${companyId}`,
  forecast: (companyId: string) => `gl-forecast:${companyId}`,
};

export type GlProduct = {
  item_code: string;
  sku_code: string | null;
  product_line: string | null;
  variant: string | null;
  unit_price: string | number | null;
  is_bestseller: boolean | null;
  hidden: boolean | null;
  retired_at: string | null;
};
export type GlStoreRow = {store_code: string; name: string; status: string; region: string | null; area: string | null};
export type GlSupplyRef = {
  settings: {default_production_days: number; default_transit_days: number; is_sample: boolean} | null;
  lines: Array<{product_line: string; production_days: number; is_sample: boolean}>;
  transit: Array<{store_code: string; transit_days: number; is_sample: boolean}>;
  warehouse: Array<{item_code: string; on_hand: number; is_sample: boolean}>;
};

const configured = nichidoConfigured;

export function getGlCatalog(companyId: string): Promise<GlProduct[]> {
  if (!configured()) return Promise.resolve([]);
  return unstable_cache(
    async () =>
      (await fetchAllRows('products', (from, to) =>
        db()
          .from('products')
          .select('item_code,sku_code,product_line,variant,unit_price,is_bestseller,hidden,retired_at')
          .eq('company_id', companyId)
          .order('item_code')
          .range(from, to),
      )) as unknown as GlProduct[],
    ['gl-catalog', companyId],
    {tags: [glTags.catalog(companyId)], revalidate: REVALIDATE_SECONDS},
  )();
}

export function getGlStores(companyId: string): Promise<GlStoreRow[]> {
  if (!configured()) return Promise.resolve([]);
  return unstable_cache(
    async () =>
      (await fetchAllRows('stores', (from, to) =>
        db().from('stores').select('store_code,name,status,region,area').eq('company_id', companyId).order('store_code').range(from, to),
      )) as unknown as GlStoreRow[],
    ['gl-stores', companyId],
    {tags: [glTags.stores(companyId)], revalidate: REVALIDATE_SECONDS},
  )();
}

export function getGlSupplyRef(companyId: string): Promise<GlSupplyRef> {
  if (!configured()) return Promise.resolve({settings: null, lines: [], transit: [], warehouse: []});
  return unstable_cache(
    async (): Promise<GlSupplyRef> => {
      const supa = db();
      const [settings, lines, transit, warehouse] = await Promise.all([
        // pagination-ok: one row by primary key (company_id).
        supa.from('supply_settings').select('default_production_days,default_transit_days,is_sample').eq('company_id', companyId).maybeSingle(),
        fetchAllRows('line_lead_times', (from, to) =>
          supa.from('line_lead_times').select('product_line,production_days,is_sample').eq('company_id', companyId).order('product_line').range(from, to),
        ),
        fetchAllRows('store_transit', (from, to) =>
          supa.from('store_transit').select('store_code,transit_days,is_sample').eq('company_id', companyId).order('store_code').range(from, to),
        ),
        fetchAllRows('warehouse_stock', (from, to) =>
          supa.from('warehouse_stock').select('item_code,on_hand,is_sample').eq('company_id', companyId).order('item_code').range(from, to),
        ),
      ]);
      if (settings.error) throw new Error(`supply_settings read failed: ${settings.error.message}`);
      return {
        settings: settings.data as GlSupplyRef['settings'],
        lines: lines as unknown as GlSupplyRef['lines'],
        transit: transit as unknown as GlSupplyRef['transit'],
        warehouse: warehouse as unknown as GlSupplyRef['warehouse'],
      };
    },
    ['gl-supply', companyId],
    {tags: [glTags.supply(companyId)], revalidate: REVALIDATE_SECONDS},
  )();
}

/** Restock window and safety months (F10). Defaults (3 + 1) when unset or Nichido is off. */
export function getForecastSettings(companyId: string): Promise<ForecastSettings> {
  if (!configured()) return Promise.resolve(DEFAULT_FORECAST_SETTINGS);
  return unstable_cache(
    async (): Promise<ForecastSettings> => {
      // pagination-ok: one row by primary key (company_id).
      const {data, error} = await db().from('forecast_settings').select('window_months,safety_months').eq('company_id', companyId).maybeSingle();
      if (error) throw new Error(`forecast_settings read failed: ${error.message}`);
      return clampSettings(data ? {windowMonths: data.window_months, safetyMonths: data.safety_months} : null);
    },
    ['gl-forecast-settings', companyId],
    {tags: [glTags.forecast(companyId)], revalidate: REVALIDATE_SECONDS},
  )();
}

export type StoreScope = {store_code: string; last_sale_month: string | null; sold_recently: boolean; override: boolean | null; in_scope: boolean};

/**
 * Which stores count (F2, S2): in scope when it sold anything in the latest 3 loaded
 * months of POS Sales Data, unless an admin switched it (stores.in_scope). Cached with
 * the store list; a Watsons upload or a scope change refreshes it.
 */
export function getStoreScope(companyId: string): Promise<StoreScope[]> {
  if (!configured()) return Promise.resolve([]);
  return unstable_cache(
    async () => {
      const res = await db().rpc('store_scope', {p_company: companyId}); // pagination-ok: one row per store (≈330), under the cap
      if (res.error) throw new Error(`store_scope failed: ${res.error.message}`);
      return (res.data ?? []) as StoreScope[];
    },
    ['gl-store-scope', companyId],
    {tags: [glTags.stores(companyId)], revalidate: REVALIDATE_SECONDS},
  )();
}

/** Store codes in scope, for the restock (P3) and anything that should skip quiet stores. */
export async function inScopeStores(companyId: string): Promise<Set<string>> {
  return new Set((await getStoreScope(companyId)).filter((s) => s.in_scope).map((s) => s.store_code));
}
