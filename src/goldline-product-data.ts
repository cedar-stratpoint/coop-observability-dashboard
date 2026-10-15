import 'server-only';
import {createClient, type SupabaseClient} from '@supabase/supabase-js';
import {fetchAllRows} from './pos-fetch-paginate';
import {getGlCatalog, getGlStores} from './goldline-ref-data';
import {addDays} from './goldline-movement';
import type {ItemCount, ProductInfo, SalesRow, StoreInput} from './goldline-product';

export type {ProductInfo};

// Server-only reads behind the Goldline product page: ONE item's counts across the
// caller's stores for the last ~15 months (enough for "vs last year" on the forecast
// months), plus its sales-report units when the item's POS SKU is linked. Company
// scoped on every query (the service-role key bypasses RLS; company_id is the fence),
// and narrowed to a store-scoped role's stores.

const url = process.env.SUPABASE_URL_ARCHIVE;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY_ARCHIVE;
const HISTORY_DAYS = 470; // 3 real + 3 forecast months, plus the same months a year back

function db(): SupabaseClient {
  return createClient(url as string, key as string, {auth: {persistSession: false}});
}

export type ProductData = {item: ProductInfo; stores: StoreInput[]};

export async function getProductData(companyId: string, itemCode: string, storeScope?: string[] | null, today = new Date()): Promise<ProductData | null> {
  if (!url || !key) return null;
  const supa = db();
  const since = addDays(today.toISOString().slice(0, 10), -HISTORY_DAYS);
  const scope = storeScope ? new Set(storeScope) : null;

  const [catalog, storesRows, counts, snaps] = await Promise.all([
    getGlCatalog(companyId),
    getGlStores(companyId),
    fetchAllRows('gl_inventory', (from, to) => {
      let q = supa
        .from('gl_inventory') // pagination-ok: paged by fetchAllRows (.range below)
        .select('store_code,item_code,period_start,period_end,stockroom,drawer,selling_area,delivery,ending_on_hand')
        .eq('company_id', companyId)
        .eq('item_code', itemCode)
        .gte('period_end', since);
      if (storeScope) q = q.in('store_code', storeScope);
      return q.order('id').range(from, to);
    }) as unknown as Promise<Array<ItemCount & {store_code: string}>>,
    // Each store's latest count of any item — to tell "not on the latest count" from current.
    fetchAllRows('gl_inventory_snapshots', (from, to) => {
      let q = supa
        .from('gl_inventory_snapshots') // pagination-ok: paged by fetchAllRows (.range below)
        .select('store_code,period_end')
        .eq('company_id', companyId)
        .gte('period_end', since);
      if (storeScope) q = q.in('store_code', storeScope);
      return q.order('period_end', {ascending: false}).order('store_code').range(from, to);
    }) as unknown as Promise<Array<{store_code: string; period_end: string}>>,
  ]);
  const p = catalog.find((x) => x.item_code === itemCode) ?? null;
  if (!p && !counts.length) return null; // not this company's item

  const sku = p?.sku_code?.trim() || null;
  const sales = sku
    ? ((await fetchAllRows('gl_sales', (from, to) => {
        let q = supa
          .from('gl_sales') // pagination-ok: paged by fetchAllRows (.range below)
          .select('store_code,period_start,period_end,units')
          .eq('company_id', companyId)
          .eq('sku_code', sku)
          .gte('period_end', since);
        if (storeScope) q = q.in('store_code', storeScope);
        return q.order('id').range(from, to);
      })) as unknown as Array<SalesRow & {store_code: string}>)
    : [];

  const countsBy = new Map<string, ItemCount[]>();
  for (const r of counts) {
    if (scope && !scope.has(r.store_code)) continue;
    const list = countsBy.get(r.store_code);
    if (list) list.push(r);
    else countsBy.set(r.store_code, [r]);
  }
  const salesBy = new Map<string, SalesRow[]>();
  for (const r of sales) {
    if (scope && !scope.has(r.store_code)) continue;
    salesBy.set(r.store_code, [...(salesBy.get(r.store_code) ?? []), {period_start: r.period_start, period_end: r.period_end, units: Number(r.units) || 0}]);
  }
  const nameOf = new Map(storesRows.map((s) => [s.store_code, s.name]));
  const storeLatest = new Map<string, string>();
  for (const s of snaps) if (!storeLatest.has(s.store_code) || s.period_end > (storeLatest.get(s.store_code) as string)) storeLatest.set(s.store_code, s.period_end);
  const codes = [...countsBy.keys()].sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));

  return {
    item: {
      itemCode,
      name: p?.variant?.trim() || itemCode,
      productLine: p?.product_line ?? null,
      price: p?.unit_price == null ? null : Number(p.unit_price),
      bestseller: Boolean(p?.is_bestseller),
      skuLinked: Boolean(sku),
    },
    stores: codes.map((storeCode) => ({
      storeCode,
      storeName: nameOf.get(storeCode) ?? null,
      counts: countsBy.get(storeCode) ?? [],
      sales: sku ? (salesBy.get(storeCode) ?? []) : null,
      storeLatestEnd: storeLatest.get(storeCode) ?? null,
    })),
  };
}
