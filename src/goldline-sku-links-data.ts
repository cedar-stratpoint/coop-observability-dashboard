import 'server-only';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {categoryFromSubclass} from './goldline-pos-xlsx';
import {relinkWatsons} from './goldline-watsons-data';
import type {MatchTier} from './goldline-sku-match';
import {formSpots, type FormSpot} from './goldline-sku-tags';
import {MANIFESTS} from './goldline-extract';

// Watsons SKU links (P1 · F2): which Watsons SKU code is which Nichido item. The link
// lives on products.sku_code (every sales reader joins on it); chain_skus holds the
// Watsons list with any suggestion still waiting for an admin; sku_link_reviews keeps
// the latest decision (approve, reject, link, unlink) and the latest remark per SKU.
// Company-wide data, so the actions behind this only let roles that see every store
// change it.

const CHAIN = 'watsons';
const db = nichidoDb;

export type LinkSource = 'code' | 'match' | 'admin';
export type SkuLinkItem = {itemCode: string; productLine: string | null; variant: string | null; price: number | null; formSpot: FormSpot | null};
export type ReviewAction = 'approved' | 'rejected' | 'linked' | 'unlinked';
export type SkuReview = {
  action: ReviewAction | null;
  itemCode: string | null;
  actionBy: string | null;
  actionAt: string | null;
  remark: string | null;
  remarkBy: string | null;
  remarkAt: string | null;
};
export type SkuLinkRow = {
  skuCode: string;
  name: string;
  subclass: string | null;
  units: number;
  avgPrice: number | null;
  lastMonth: string | null;
  linked: (SkuLinkItem & {source: LinkSource | null}) | null;
  suggestion: (SkuLinkItem & {tier: MatchTier; score: number}) | null;
  review: SkuReview | null;
};
/** One printed line of the inventory form, with the Watsons SKU it is linked to (if any). */
export type FormLine = {row: number; itemCode: string; productLine: string | null; name: string; sku: string | null};
export type FormPage = {page: number; lines: FormLine[]};

/** One of our form items marked as no longer made or sold, with who did it and why. */
export type DecommissionedItem = SkuLinkItem & {at: string | null; by: string | null; remark: string | null};

export type SkuLinkData = {
  rows: SkuLinkRow[];
  unlinkedItems: SkuLinkItem[]; // catalog items with no Watsons SKU yet (for the manual picker)
  decommissioned: DecommissionedItem[]; // retired items with no Watsons SKU (f2c)
  formPages: FormPage[]; // the printed inventory form, page by page, for "show on the form"
  totals: {units: number; linkedUnits: number; suggestedUnits: number};
};

type ProductRow = {item_code: string; product_line: string | null; variant: string | null; unit_price: unknown; sku_code: string | null; sku_linked_by: LinkSource | null; retired_at: string | null; retired_by?: string | null; retired_remark?: string | null};
type ReviewRow = {sku_code: string; action: ReviewAction | null; item_code: string | null; action_by: string | null; action_at: string | null; remark: string | null; remark_by: string | null; remark_at: string | null};
type ChainRow = {sku_code: string; name: string; subclass: string | null; last_month: string | null; suggested_item_code: string | null; match_tier: MatchTier | null; match_score: unknown};

// Printed order of the inventory form (fixed template), so each item shows its page and row.
const SPOTS = formSpots();

const item = (p: ProductRow): SkuLinkItem => ({
  itemCode: p.item_code,
  productLine: p.product_line,
  variant: p.variant,
  price: p.unit_price == null ? null : Number(p.unit_price),
  formSpot: SPOTS.get(p.item_code) ?? null,
});

export async function getSkuLinkData(companyId: string): Promise<SkuLinkData> {
  const empty: SkuLinkData = {rows: [], unlinkedItems: [], decommissioned: [], formPages: [], totals: {units: 0, linkedUnits: 0, suggestedUnits: 0}};
  if (!nichidoConfigured()) return empty;
  const supa = db();
  const [products, chain, rollup, reviews] = await Promise.all([
    fetchAllRows('products', (from, to) =>
      supa
        .from('products')
        .select('item_code,product_line,variant,unit_price,sku_code,sku_linked_by,retired_at,retired_by,retired_remark')
        .eq('company_id', companyId)
        .order('item_code')
        .range(from, to),
    ) as unknown as Promise<ProductRow[]>,
    fetchAllRows('chain_skus', (from, to) =>
      supa
        .from('chain_skus')
        .select('sku_code,name,subclass,last_month,suggested_item_code,match_tier,match_score')
        .eq('company_id', companyId)
        .eq('chain', CHAIN)
        .order('sku_code')
        .range(from, to),
    ) as unknown as Promise<ChainRow[]>,
    supa.rpc('sales_rollup', {p_company: companyId}),
    fetchAllRows('sku_link_reviews', (from, to) =>
      supa
        .from('sku_link_reviews')
        .select('sku_code,action,item_code,action_by,action_at,remark,remark_by,remark_at')
        .eq('company_id', companyId)
        .eq('chain', CHAIN)
        .order('sku_code')
        .range(from, to),
    ) as unknown as Promise<ReviewRow[]>,
  ]);
  const reviewBySku = new Map(
    reviews.map((r) => [
      r.sku_code,
      {action: r.action, itemCode: r.item_code, actionBy: r.action_by, actionAt: r.action_at, remark: r.remark, remarkBy: r.remark_by, remarkAt: r.remark_at} satisfies SkuReview,
    ]),
  );
  if (rollup.error) throw new Error(`sales_rollup failed: ${rollup.error.message}`);
  const totalsBySku = new Map(
    ((rollup.data as {bySku?: Array<{sku_code: string; units: unknown; gross: unknown}>} | null)?.bySku ?? []).map((r) => [
      r.sku_code,
      {units: Number(r.units) || 0, gross: Number(r.gross) || 0},
    ]),
  );
  const byItem = new Map(products.map((p) => [p.item_code, p]));
  const bySku = new Map(products.filter((p) => p.sku_code?.trim()).map((p) => [p.sku_code!.trim(), p]));

  const rows: SkuLinkRow[] = chain.map((c) => {
    const t = totalsBySku.get(c.sku_code) ?? {units: 0, gross: 0};
    const linked = bySku.get(c.sku_code);
    const sug = !linked && c.suggested_item_code ? byItem.get(c.suggested_item_code) : undefined;
    return {
      skuCode: c.sku_code,
      name: c.name,
      subclass: c.subclass,
      units: t.units,
      avgPrice: t.units > 0 ? Math.round(t.gross / t.units) : null,
      lastMonth: c.last_month,
      linked: linked ? {...item(linked), source: linked.sku_linked_by} : null,
      suggestion: sug && !sug.sku_code ? {...item(sug), tier: c.match_tier ?? 'low', score: Number(c.match_score) || 0} : null,
      review: reviewBySku.get(c.sku_code) ?? null,
    };
  });
  rows.sort((a, b) => b.units - a.units || a.skuCode.localeCompare(b.skuCode));

  const units = rows.reduce((a, r) => a + r.units, 0);
  return {
    rows,
    unlinkedItems: products
      .filter((p) => !p.sku_code?.trim() && !p.retired_at)
      .map(item)
      .sort((a, b) => (a.productLine ?? '').localeCompare(b.productLine ?? '') || (a.variant ?? '').localeCompare(b.variant ?? '')),
    decommissioned: products
      .filter((p) => !p.sku_code?.trim() && p.retired_at)
      .map((p) => ({...item(p), at: p.retired_at, by: p.retired_by ?? null, remark: p.retired_remark ?? null}))
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')),
    // The form in printed order (fixed template), named from the catalog where it can be.
    formPages: Object.entries(MANIFESTS)
      .map(([page, items]) => ({
        page: Number(page),
        lines: items.map((it, i) => {
          const p = byItem.get(it.code);
          return {row: i + 1, itemCode: it.code, productLine: p?.product_line ?? null, name: p?.variant?.trim() || it.product, sku: p?.sku_code?.trim() || null};
        }),
      }))
      .sort((a, b) => a.page - b.page),
    totals: {
      units,
      linkedUnits: rows.reduce((a, r) => a + (r.linked ? r.units : 0), 0),
      suggestedUnits: rows.reduce((a, r) => a + (r.suggestion ? r.units : 0), 0),
    },
  };
}

export class LinkError extends Error {}

/** Link a Watsons SKU to an item (an admin's confirm or pick). Both must be free. */
export async function linkSku(companyId: string, skuCode: string, itemCode: string): Promise<void> {
  const supa = db();
  const [sku, p, holder] = await Promise.all([
    supa.from('chain_skus').select('sku_code,subclass').eq('company_id', companyId).eq('chain', CHAIN).eq('sku_code', skuCode).maybeSingle(),
    supa.from('products').select('item_code,sku_code,category').eq('company_id', companyId).eq('item_code', itemCode).maybeSingle(),
    supa.from('products').select('item_code').eq('company_id', companyId).eq('sku_code', skuCode).limit(1),
  ]);
  if (sku.error || p.error || holder.error) throw new Error(sku.error?.message ?? p.error?.message ?? holder.error?.message);
  if (!sku.data) throw new LinkError(`Watsons SKU ${skuCode} isn’t in the Watsons list.`);
  if (!p.data) throw new LinkError(`Item ${itemCode} isn’t in the catalog.`);
  if (p.data.sku_code) throw new LinkError(`${itemCode} is already linked to Watsons SKU ${p.data.sku_code}. Unlink it first.`);
  if (holder.data?.length) throw new LinkError(`Watsons SKU ${skuCode} is already linked to ${holder.data[0].item_code}.`);

  const category = p.data.category ?? categoryFromSubclass(sku.data.subclass);
  const res = await supa
    .from('products')
    .update({sku_code: skuCode, sku_linked_by: 'admin', sku_linked_at: new Date().toISOString(), ...(category ? {category} : {})})
    .eq('company_id', companyId)
    .eq('item_code', itemCode)
    .is('sku_code', null);
  if (res.error) throw new Error(`link failed: ${res.error.message}`);
  const clear = await supa
    .from('chain_skus')
    .update({suggested_item_code: null, match_score: null, match_tier: null})
    .eq('company_id', companyId)
    .eq('chain', CHAIN)
    .eq('sku_code', skuCode);
  if (clear.error) throw new Error(`suggestion clear failed: ${clear.error.message}`);
}

/** Turn a suggestion down: it is never offered again, and the next best is looked for. */
export async function dismissSuggestion(companyId: string, skuCode: string, expected?: string): Promise<string> {
  const supa = db();
  const cur = await supa.from('chain_skus').select('suggested_item_code,dismissed_item_codes').eq('company_id', companyId).eq('chain', CHAIN).eq('sku_code', skuCode).maybeSingle();
  if (cur.error) throw new Error(cur.error.message);
  if (!cur.data?.suggested_item_code) throw new LinkError('There’s no suggestion to turn down.');
  const rejected = cur.data.suggested_item_code as string;
  // The page may be stale: never turn down an item the person didn't see.
  if (expected && expected !== rejected) throw new LinkError('Coop’s suggestion for this SKU changed. Refresh and check it again.');
  const res = await supa
    .from('chain_skus')
    .update({
      dismissed_item_codes: [...new Set([...((cur.data.dismissed_item_codes as string[] | null) ?? []), cur.data.suggested_item_code])],
      suggested_item_code: null,
      match_score: null,
      match_tier: null,
    })
    .eq('company_id', companyId)
    .eq('chain', CHAIN)
    .eq('sku_code', skuCode);
  if (res.error) throw new Error(`dismiss failed: ${res.error.message}`);
  await relinkWatsons(companyId);
  return rejected;
}

/**
 * Mark one of our form items as decommissioned (no longer made or sold), or bring it back.
 * Uses the same retired_at as the Inventory board's Retire, so it leaves SKU matching and
 * restock; also keeps who and why (f2c). Only items with no Watsons SKU: a linked item is
 * still selling at Watsons, so unlink it first.
 */
export async function setDecommissioned(companyId: string, itemCode: string, on: boolean, by: string | null, remark: string | null): Promise<void> {
  const supa = db();
  // pagination-ok: one row by primary key (company_id, item_code).
  const p = await supa.from('products').select('item_code,sku_code').eq('company_id', companyId).eq('item_code', itemCode).maybeSingle();
  if (p.error) throw new Error(p.error.message);
  if (!p.data) throw new LinkError(`Item ${itemCode} isn’t in the catalog.`);
  if (on && p.data.sku_code) throw new LinkError(`${itemCode} is linked to Watsons SKU ${p.data.sku_code}. Unlink it first.`);
  const res = await supa
    .from('products')
    .update(on ? {retired_at: new Date().toISOString(), retired_by: by, retired_remark: remark} : {retired_at: null, retired_by: null, retired_remark: null})
    .eq('company_id', companyId)
    .eq('item_code', itemCode);
  if (res.error) throw new Error(`decommission failed: ${res.error.message}`);
}

/** Undo a link. The pair is remembered as turned down so matching won't redo it. */
export async function unlinkSku(companyId: string, skuCode: string): Promise<string> {
  const supa = db();
  const p = await supa.from('products').select('item_code').eq('company_id', companyId).eq('sku_code', skuCode).limit(1);
  if (p.error) throw new Error(p.error.message);
  const itemCode = p.data?.[0]?.item_code;
  if (!itemCode) throw new LinkError(`Watsons SKU ${skuCode} isn’t linked.`);
  const res = await supa
    .from('products')
    .update({sku_code: null, sku_linked_by: null, sku_linked_at: null})
    .eq('company_id', companyId)
    .eq('item_code', itemCode);
  if (res.error) throw new Error(`unlink failed: ${res.error.message}`);
  const prior = await supa.from('chain_skus').select('dismissed_item_codes').eq('company_id', companyId).eq('chain', CHAIN).eq('sku_code', skuCode).maybeSingle();
  if (prior.error) throw new Error(prior.error.message);
  const mark = await supa
    .from('chain_skus')
    .update({dismissed_item_codes: [...new Set([...((prior.data?.dismissed_item_codes as string[] | null) ?? []), itemCode])]})
    .eq('company_id', companyId)
    .eq('chain', CHAIN)
    .eq('sku_code', skuCode);
  if (mark.error) throw new Error(`unlink note failed: ${mark.error.message}`);
  return itemCode;
}

/**
 * Keep the latest decision and remark for a SKU. A decision replaces the last one; a
 * remark replaces the last remark only when one is given, so approving without a note
 * keeps an earlier note. `action: null` saves just the remark.
 */
export async function saveReview(
  companyId: string,
  skuCode: string,
  input: {action: ReviewAction | null; itemCode?: string | null; remark?: string | null; by: string | null},
): Promise<void> {
  const now = new Date().toISOString();
  const remark = input.remark?.trim() || null;
  const row: Record<string, unknown> = {company_id: companyId, chain: CHAIN, sku_code: skuCode};
  if (input.action) Object.assign(row, {action: input.action, item_code: input.itemCode ?? null, action_by: input.by, action_at: now});
  if (remark) Object.assign(row, {remark, remark_by: input.by, remark_at: now});
  if (!input.action && !remark) return;
  const res = await db().from('sku_link_reviews').upsert(row, {onConflict: 'company_id,chain,sku_code'});
  if (res.error) throw new Error(`review save failed: ${res.error.message}`);
}
