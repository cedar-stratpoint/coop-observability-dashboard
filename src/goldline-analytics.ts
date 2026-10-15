import 'server-only';
import {createClient, type SupabaseClient} from '@supabase/supabase-js';
import {fetchAllRows} from './pos-fetch-paginate';
import {getGlCatalog, getGlStores} from './goldline-ref-data';
import {buildOverview, type GoldlineOverview, type OverviewSaleRow} from './goldline-overview';

// Read-only analytics for a Goldline-style tenant: store + SKU rollups derived
// from gl_sales, joined to gl_stores for names. Company-scoped on every read (the
// service-role key bypasses RLS, so the company_id filter is the tenant fence) and
// paginated via fetchAllRows so a large gl_sales is never silently capped. v1 does
// the aggregation in JS — fine at the ~150k-rows/cycle scale; an RPC/view is the
// later optimization (same path the pos_* reads will take).

const url = process.env.SUPABASE_URL_ARCHIVE;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY_ARCHIVE;

function configured(): boolean {
  return Boolean(url && key);
}
function db(): SupabaseClient {
  return createClient(url as string, key as string, {auth: {persistSession: false}});
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export type GlStore = {
  store_code: string;
  name: string;
  region: string | null;
  area: string | null;
  status: string;
};

export type StoreRollup = {
  store_code: string;
  name: string;
  region: string | null;
  units: number;
  gross: number;
  net: number;
  skuCount: number;
};

export type SkuRollup = {sku_code: string; units: number; gross: number; net: number};

export type SalesSummary = {
  gross: number;
  units: number;
  net: number;
  storeCount: number; // stores with at least one sale
  skuCount: number;
  periodStart: string | null;
  periodEnd: string | null;
};

export type GoldlineAnalytics = {
  stores: GlStore[];
  byStore: StoreRollup[]; // every store (incl. zero-sale), gross desc
  bySku: SkuRollup[]; // gross desc
  summary: SalesSummary;
};

const EMPTY: GoldlineAnalytics = {
  stores: [],
  byStore: [],
  bySku: [],
  summary: {gross: 0, units: 0, net: 0, storeCount: 0, skuCount: 0, periodStart: null, periodEnd: null},
};


/** One company's store + SKU sales rollups and headline summary. */
export async function getGoldlineAnalytics(companyId: string): Promise<GoldlineAnalytics> {
  if (!configured()) return EMPTY;
  const supa = db();

  // Sums are done in the database (gl_sales_rollup) — never the whole sales history
  // shipped to the app. The store list comes from the per-company cache.
  const [cachedStores, rollup] = await Promise.all([getGlStores(companyId), supa.rpc('gl_sales_rollup', {p_company: companyId})]);
  if (rollup.error) throw new Error(`gl_sales_rollup failed: ${rollup.error.message}`);
  const storeRows: GlStore[] = cachedStores.map((s) => ({store_code: s.store_code, name: s.name, region: s.region, area: s.area, status: s.status}));
  const r = (rollup.data ?? {}) as {
    byStore?: Array<{store_code: string; units: unknown; gross: unknown; net: unknown; sku_count: unknown}>;
    bySku?: Array<{sku_code: string; units: unknown; gross: unknown; net: unknown}>;
    periodStart?: string | null;
    periodEnd?: string | null;
  };
  const perStore = new Map((r.byStore ?? []).map((x) => [x.store_code, {units: num(x.units), gross: num(x.gross), net: num(x.net), skuCount: num(x.sku_count)}]));
  const perSku = new Map((r.bySku ?? []).map((x) => [x.sku_code, {units: num(x.units), gross: num(x.gross), net: num(x.net)}]));
  let gross = 0;
  let units = 0;
  let net = 0;
  for (const a of perStore.values()) {
    gross += a.gross;
    units += a.units;
    net += a.net;
  }
  const periodStart = r.periodStart ?? null;
  const periodEnd = r.periodEnd ?? null;

  const nameByStore = new Map(storeRows.map((s) => [s.store_code, s.name]));
  const regionByStore = new Map(storeRows.map((s) => [s.store_code, s.region]));

  // Every known store, plus any store that only appears in sales (defensive).
  const storeCodes = new Set<string>([...storeRows.map((s) => s.store_code), ...perStore.keys()]);
  const byStore: StoreRollup[] = [...storeCodes]
    .map((code) => {
      const a = perStore.get(code) ?? {units: 0, gross: 0, net: 0, skuCount: 0};
      return {
        store_code: code,
        name: nameByStore.get(code) ?? code,
        region: regionByStore.get(code) ?? null,
        units: a.units,
        gross: a.gross,
        net: a.net,
        skuCount: a.skuCount,
      };
    })
    .sort((a, b) => b.gross - a.gross);

  const bySku: SkuRollup[] = [...perSku.entries()]
    .map(([sku_code, a]) => ({sku_code, units: a.units, gross: a.gross, net: a.net}))
    .sort((a, b) => b.gross - a.gross);

  return {
    stores: storeRows,
    byStore,
    bySku,
    summary: {
      gross,
      units,
      net,
      storeCount: [...perStore.values()].filter((a) => a.units > 0 || a.gross > 0).length,
      skuCount: perSku.size,
      periodStart,
      periodEnd,
    },
  };
}

export type GoldlineOverviewData = {
  companyName: string;
  storesLive: number; // gl_stores with status 'active'
  overview: GoldlineOverview;
};

/** Everything the Overview page needs for one company: name, live-store count,
 *  and the window/delta/category rollups (see goldline-overview.ts). */
export async function getGoldlineOverviewData(companyId: string): Promise<GoldlineOverviewData> {
  const empty = buildOverview([], new Map());
  if (!configured()) return {companyName: companyId, storesLive: 0, overview: empty};
  const supa = db();

  // Independent reads run together; reference data (stores, catalog) is cached.
  type Period = {period_start: string; period_end: string};
  const [company, stores, products, latest] = await Promise.all([
    // pagination-ok: single row by primary key.
    supa.from('companies').select('name').eq('id', companyId).maybeSingle(),
    getGlStores(companyId),
    getGlCatalog(companyId),
    // Only the two periods the page shows: the latest one, and the latest one that ends
    // before it starts (the comparison). Reading all of gl_sales on every render would
    // grow with each upload (~150k rows per period at 300 stores).
    // pagination-ok: single row (latest period marker).
    supa
      .from('gl_sales')
      .select('period_start,period_end')
      .eq('company_id', companyId)
      .order('period_end', {ascending: false})
      .order('period_start', {ascending: false})
      .limit(1)
      .maybeSingle(),
  ]);
  const companyName = (company.data?.name as string | undefined) ?? companyId;
  if (latest.error) throw new Error(`gl_sales latest period failed: ${latest.error.message}`);
  const cur = latest.data as Period | null;

  const salesFor = async (p: Period) =>
    (await fetchAllRows(
      'gl_sales',
      (from, to) =>
        supa
          .from('gl_sales')
          .select('sku_code,gross_retail,units,net_of_vat,period_start,period_end')
          .eq('company_id', companyId)
          .eq('period_start', p.period_start)
          .eq('period_end', p.period_end)
          .order('id', {ascending: true})
          .range(from, to),
      undefined,
      {concurrency: 4},
    )) as unknown as Array<Record<string, unknown>>;

  // The current period's rows and the comparison period's marker together, then its rows.
  let sales: Array<Record<string, unknown>> = [];
  if (cur?.period_start) {
    const [curRows, prev] = await Promise.all([
      salesFor(cur),
      // pagination-ok: single row (previous period marker).
      supa
        .from('gl_sales')
        .select('period_start,period_end')
        .eq('company_id', companyId)
        .lt('period_end', cur.period_start)
        .order('period_end', {ascending: false})
        .order('period_start', {ascending: false})
        .limit(1)
        .maybeSingle(),
    ]);
    if (prev.error) throw new Error(`gl_sales previous period failed: ${prev.error.message}`);
    const prior = prev.data as Period | null;
    sales = [...curRows, ...(prior ? await salesFor(prior) : [])];
  }

  const lineBySku = new Map<string, string>();
  for (const p of products) if (p.sku_code && p.product_line) lineBySku.set(p.sku_code, p.product_line);

  const rows: OverviewSaleRow[] = sales.map((r) => ({
    sku_code: String(r.sku_code ?? ''),
    gross: num(r.gross_retail),
    units: num(r.units),
    net: num(r.net_of_vat),
    period_start: (r.period_start as string | null) ?? null,
    period_end: (r.period_end as string | null) ?? null,
  }));

  return {
    companyName,
    storesLive: stores.filter((s) => s.status === 'active').length,
    overview: buildOverview(rows, lineBySku),
  };
}
