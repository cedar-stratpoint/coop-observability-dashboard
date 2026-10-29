import 'server-only';
import {nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {upsertSales} from './goldline-data';
import {categoryFromSubclass, itemCodeFromName, type Category, type WatsonsWorkbook} from './goldline-pos-xlsx';
import {matchSkus, type CatalogItem} from './goldline-sku-match';
import {getSalesRollup, readSalesRollup} from './goldline-ref-data';

// Apply one month of Watsons POS Sales Data (P1 · F2, F4) to Goldline's Nichido tables.
// The workbook is authoritative for Watsons:
//   * every store code it reports exists in `stores` (new ones are added as chain
//     'watsons', active, scope automatic); existing stores are never renamed here
//   * every SKU it reports is kept in `chain_skus` with its name, subclass and the
//     first/last month it appeared
//   * a catalog item whose code the Watsons name ends with gets that SKU linked
//     (products.sku_code), only when the item has no link yet and nothing else holds
//     the code. Everything else waits for an admin to link it
//   * then every still-unlinked SKU with sales is matched by name, price and the numbers
//     in its name (src/goldline-sku-match.ts): high-confidence pairs are linked
//     automatically, medium and low ones wait on chain_skus as suggestions to confirm
//   * linked items without a category get one from the Watsons subclass
//   * the month's sales are upserted, then any older rows for the same stores and
//     month are removed, so re-uploading a month replaces it
// Unlinked SKUs' sales are saved too; checks hold them out until they're linked.

const CHAIN = 'watsons';
const db = nichidoDb;

export type WatsonsLoadSummary = {
  month: {start: string; end: string};
  salesRows: number;
  replacedRows: number;
  stores: number;
  storesAdded: number;
  skus: number;
  skusNew: number;
  linkedNow: string[]; // item codes auto-linked by this upload
  suggested: number; // SKUs now waiting with a suggestion to confirm
  categorized: number;
  units: number;
  linkedUnits: number; // units on SKUs linked to a catalog item, after this upload
};

type ProductRow = {item_code: string; sku_code: string | null; category: Category | null};
type ChainSkuRow = {sku_code: string; first_month: string | null; last_month: string | null};

const minDate = (a: string | null, b: string) => (a && a < b ? a : b);
const maxDate = (a: string | null, b: string) => (a && a > b ? a : b);

export async function applyWatsonsMonth(
  companyId: string,
  wb: WatsonsWorkbook,
  uploadId: string,
): Promise<WatsonsLoadSummary> {
  if (!wb.month) throw new Error('applyWatsonsMonth needs the file month');
  const month = wb.month;
  const supa = db();

  // 1 · Stores: add the codes we haven't seen. Names of existing stores stay as they are.
  const known = (await fetchAllRows('stores', (from, to) =>
    supa.from('stores').select('store_code').eq('company_id', companyId).order('store_code').range(from, to),
  )) as unknown as Array<{store_code: string}>;
  const have = new Set(known.map((s) => s.store_code));
  const newStores = wb.stores.filter((s) => !have.has(s.storeCode));
  if (newStores.length) {
    const res = await supa.from('stores').upsert(
      newStores.map((s) => ({company_id: companyId, store_code: s.storeCode, name: s.name, chain: CHAIN, status: 'active'})),
      {onConflict: 'company_id,store_code', ignoreDuplicates: true},
    );
    if (res.error) throw new Error(`stores insert failed: ${res.error.message}`);
  }

  // 2 · The chain's SKU list, widening each SKU's first/last month.
  const prior = (await fetchAllRows('chain_skus', (from, to) =>
    supa
      .from('chain_skus')
      .select('sku_code,first_month,last_month')
      .eq('company_id', companyId)
      .eq('chain', CHAIN)
      .order('sku_code')
      .range(from, to),
  )) as unknown as ChainSkuRow[];
  const priorBy = new Map(prior.map((r) => [r.sku_code, r]));
  const skuRes = await supa.from('chain_skus').upsert(
    wb.skus.map((s) => {
      const p = priorBy.get(s.skuCode);
      return {
        company_id: companyId,
        chain: CHAIN,
        sku_code: s.skuCode,
        name: s.name || s.skuCode,
        subclass: s.subclass,
        first_month: minDate(p?.first_month ?? null, month.start),
        last_month: maxDate(p?.last_month ?? null, month.start),
        updated_at: new Date().toISOString(),
      };
    }),
    {onConflict: 'company_id,chain,sku_code'},
  );
  if (skuRes.error) throw new Error(`chain_skus upsert failed: ${skuRes.error.message}`);

  // 3 · Auto-link by the item code at the end of the Watsons name.
  const products = (await fetchAllRows('products', (from, to) =>
    supa.from('products').select('item_code,sku_code,category').eq('company_id', companyId).order('item_code').range(from, to),
  )) as unknown as ProductRow[];
  const byItem = new Map(products.map((p) => [p.item_code, p]));
  const linkedSkus = new Set(products.map((p) => p.sku_code?.trim()).filter((s): s is string => !!s));
  const codes = products.map((p) => p.item_code);
  const linkedNow: string[] = [];
  for (const s of wb.skus) {
    if (linkedSkus.has(s.skuCode)) continue;
    const item = itemCodeFromName(s.name, codes);
    const p = item ? byItem.get(item) : undefined;
    if (!p || p.sku_code?.trim()) continue;
    const res = await supa
      .from('products')
      .update({sku_code: s.skuCode, sku_linked_by: 'code', sku_linked_at: new Date().toISOString()})
      .eq('company_id', companyId)
      .eq('item_code', p.item_code)
      .is('sku_code', null);
    if (res.error) throw new Error(`product link failed: ${res.error.message}`);
    p.sku_code = s.skuCode;
    linkedSkus.add(s.skuCode);
    linkedNow.push(p.item_code);
  }

  // 4 · Sales: upsert the month, then drop older rows for these stores and month.
  const salesRows = await upsertSales(companyId, wb.rows, month, uploadId);
  let replacedRows = 0;
  const storeCodes = wb.stores.map((s) => s.storeCode);
  for (let i = 0; i < storeCodes.length; i += 200) {
    const res = await supa
      .from('sales')
      .delete({count: 'exact'})
      .eq('company_id', companyId)
      .eq('period_start', month.start)
      .eq('period_end', month.end)
      .in('store_code', storeCodes.slice(i, i + 200))
      .or(`source_upload_id.is.null,source_upload_id.neq.${uploadId}`);
    if (res.error) throw new Error(`sales replace failed: ${res.error.message}`);
    replacedRows += res.count ?? 0;
  }

  // 5 · Name/price/number matching for the rest, now that this month's sales count too.
  const matched = await relinkWatsons(companyId, {freshSales: true}); // this month's sales just changed
  for (const m of matched.linked) {
    const p = byItem.get(m.itemCode);
    if (p) p.sku_code = m.skuCode;
    linkedSkus.add(m.skuCode);
    linkedNow.push(m.itemCode);
  }

  // 6 · Categories for linked items, from the subclass Watsons gave each SKU in any month.
  const subclasses = (await fetchAllRows('chain_skus', (from, to) =>
    supa.from('chain_skus').select('sku_code,subclass').eq('company_id', companyId).eq('chain', CHAIN).order('sku_code').range(from, to),
  )) as unknown as Array<{sku_code: string; subclass: string | null}>;
  const subclassBySku = new Map(subclasses.map((s) => [s.sku_code, s.subclass]));
  for (const s of wb.skus) if (s.subclass) subclassBySku.set(s.skuCode, s.subclass);
  const toCategorize = new Map<Category, string[]>();
  for (const p of products) {
    if (p.category || !p.sku_code) continue;
    const c = categoryFromSubclass(subclassBySku.get(p.sku_code.trim()));
    if (c) toCategorize.set(c, [...(toCategorize.get(c) ?? []), p.item_code]);
  }
  let categorized = 0;
  for (const [category, items] of toCategorize) {
    const res = await supa.from('products').update({category}).eq('company_id', companyId).in('item_code', items).is('category', null);
    if (res.error) throw new Error(`product category failed: ${res.error.message}`);
    categorized += items.length;
  }

  const units = wb.rows.reduce((a, r) => a + (r.units ?? 0), 0);
  const linkedUnits = wb.rows.reduce((a, r) => a + (linkedSkus.has(r.skuCode) ? (r.units ?? 0) : 0), 0);
  return {
    month,
    salesRows,
    replacedRows,
    stores: wb.stores.length,
    storesAdded: newStores.length,
    skus: wb.skus.length,
    skusNew: wb.skus.filter((s) => !priorBy.has(s.skuCode)).length,
    linkedNow,
    suggested: matched.suggested,
    categorized,
    units,
    linkedUnits,
  };
}

/**
 * Match every Watsons SKU that has sales but no linked item. High-confidence pairs are
 * linked (products.sku_code, sku_linked_by 'match'); medium and low ones are saved on
 * chain_skus as suggestions. Pairs an admin turned down are never offered again.
 * Safe to run any time; existing links are never changed.
 */
export async function relinkWatsons(companyId: string, opts: {freshSales?: boolean} = {}): Promise<{linked: Array<{skuCode: string; itemCode: string}>; suggested: number}> {
  const supa = db();
  const [productsRes, skuRows, rollup] = await Promise.all([
    fetchAllRows('products', (from, to) =>
      supa
        .from('products')
        .select('item_code,product_line,variant,unit_price,sku_code,retired_at')
        .eq('company_id', companyId)
        .order('item_code')
        .range(from, to),
    ),
    fetchAllRows('chain_skus', (from, to) =>
      supa
        .from('chain_skus')
        .select('sku_code,name,dismissed_item_codes,suggested_item_code')
        .eq('company_id', companyId)
        .eq('chain', CHAIN)
        .order('sku_code')
        .range(from, to),
    ),
    // Cached totals for a decision; straight from the database right after a sales upload.
    opts.freshSales ? readSalesRollup(companyId) : getSalesRollup(companyId),
  ]);
  const products = productsRes as unknown as Array<CatalogItem & {sku_code: string | null; retired_at: string | null}>;
  const skus = skuRows as unknown as Array<{sku_code: string; name: string; dismissed_item_codes: string[] | null; suggested_item_code: string | null}>;
  const totals = new Map(
    (rollup.bySku ?? []).map((r) => [
      r.sku_code,
      {units: Number(r.units) || 0, gross: Number(r.gross) || 0},
    ]),
  );

  const taken = products.filter((p) => p.sku_code?.trim()).map((p) => ({skuCode: p.sku_code!.trim(), itemCode: p.item_code}));
  const blocked = new Set(skus.flatMap((s) => (s.dismissed_item_codes ?? []).map((item) => `${s.sku_code}|${item}`)));
  const catalog = products.filter((p) => !p.retired_at).map(({item_code, product_line, variant, unit_price}) => ({
    item_code,
    product_line,
    variant,
    unit_price: unit_price == null ? null : Number(unit_price),
  }));
  const stats = skus.map((s) => ({sku_code: s.sku_code, name: s.name, ...(totals.get(s.sku_code) ?? {units: 0, gross: 0})}));
  const matches = matchSkus(stats, catalog, taken, blocked);

  const now = new Date().toISOString();
  const linked: Array<{skuCode: string; itemCode: string}> = [];
  for (const m of matches.filter((x) => x.tier === 'high')) {
    const res = await supa
      .from('products')
      .update({sku_code: m.skuCode, sku_linked_by: 'match', sku_linked_at: now})
      .eq('company_id', companyId)
      .eq('item_code', m.itemCode)
      .is('sku_code', null);
    if (res.error) throw new Error(`product match link failed: ${res.error.message}`);
    linked.push({skuCode: m.skuCode, itemCode: m.itemCode});
  }

  // Suggestions: set the current ones, clear any that no longer apply.
  const suggestions = new Map(matches.filter((x) => x.tier !== 'high').map((m) => [m.skuCode, m]));
  const rows = skus
    .filter((s) => suggestions.has(s.sku_code) || s.suggested_item_code)
    .map((s) => {
      const m = suggestions.get(s.sku_code);
      return {
        company_id: companyId,
        chain: CHAIN,
        sku_code: s.sku_code,
        name: s.name,
        suggested_item_code: m?.itemCode ?? null,
        match_score: m?.score ?? null,
        match_tier: m?.tier ?? null,
      };
    });
  for (let i = 0; i < rows.length; i += 500) {
    const res = await supa.from('chain_skus').upsert(rows.slice(i, i + 500), {onConflict: 'company_id,chain,sku_code'});
    if (res.error) throw new Error(`chain_skus suggestions failed: ${res.error.message}`);
  }
  return {linked, suggested: suggestions.size};
}
