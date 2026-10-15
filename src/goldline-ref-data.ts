import 'server-only';
import {unstable_cache} from 'next/cache';
import {createClient, type SupabaseClient} from '@supabase/supabase-js';
import {fetchAllRows} from './pos-fetch-paginate';

// Cached Goldline reference data — the small, rarely-changing tables nearly every
// Goldline page reads: the catalog, the store list, and the supply side (settings,
// lead times, warehouse stock). Cached per company across requests (Next data cache)
// for up to REVALIDATE_SECONDS, and expired immediately by the writes that change them
// (see glTags + app/stock/actions.ts), so an edit shows on the next load.
//
// Never cached here: counts, sales, uploads, shipments — they change with every
// upload / action and are big; they're read fresh.

const url = process.env.SUPABASE_URL_ARCHIVE;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY_ARCHIVE;
const REVALIDATE_SECONDS = 600;

let client: SupabaseClient | null = null;
function db(): SupabaseClient {
  client ??= createClient(url as string, key as string, {auth: {persistSession: false}});
  return client;
}

export const glTags = {
  catalog: (companyId: string) => `gl-catalog:${companyId}`,
  stores: (companyId: string) => `gl-stores:${companyId}`,
  supply: (companyId: string) => `gl-supply:${companyId}`,
};

export type GlProduct = {
  item_code: string;
  sku_code: string | null;
  product_line: string | null;
  variant: string | null;
  unit_price: string | number | null;
  is_bestseller: boolean | null;
  hidden: boolean | null;
};
export type GlStoreRow = {store_code: string; name: string; status: string; region: string | null; area: string | null};
export type GlSupplyRef = {
  settings: {default_production_days: number; default_transit_days: number; is_sample: boolean} | null;
  lines: Array<{product_line: string; production_days: number; is_sample: boolean}>;
  transit: Array<{store_code: string; transit_days: number; is_sample: boolean}>;
  warehouse: Array<{item_code: string; on_hand: number; is_sample: boolean}>;
};

const configured = () => Boolean(url && key);

export function getGlCatalog(companyId: string): Promise<GlProduct[]> {
  if (!configured()) return Promise.resolve([]);
  return unstable_cache(
    async () =>
      (await fetchAllRows('gl_products', (from, to) =>
        db()
          .from('gl_products')
          .select('item_code,sku_code,product_line,variant,unit_price,is_bestseller,hidden')
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
      (await fetchAllRows('gl_stores', (from, to) =>
        db().from('gl_stores').select('store_code,name,status,region,area').eq('company_id', companyId).order('store_code').range(from, to),
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
        supa.from('gl_supply_settings').select('default_production_days,default_transit_days,is_sample').eq('company_id', companyId).maybeSingle(),
        fetchAllRows('gl_line_lead_times', (from, to) =>
          supa.from('gl_line_lead_times').select('product_line,production_days,is_sample').eq('company_id', companyId).order('product_line').range(from, to),
        ),
        fetchAllRows('gl_store_transit', (from, to) =>
          supa.from('gl_store_transit').select('store_code,transit_days,is_sample').eq('company_id', companyId).order('store_code').range(from, to),
        ),
        fetchAllRows('gl_warehouse_stock', (from, to) =>
          supa.from('gl_warehouse_stock').select('item_code,on_hand,is_sample').eq('company_id', companyId).order('item_code').range(from, to),
        ),
      ]);
      if (settings.error) throw new Error(`gl_supply_settings read failed: ${settings.error.message}`);
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
