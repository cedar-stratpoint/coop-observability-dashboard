import 'server-only';
import {createClient, type SupabaseClient} from '@supabase/supabase-js';

// Server-only writes for the Goldline supply side (warehouse stock, lead times,
// shipments, price, hidden). Callers (app/stock/actions.ts) have already authorized
// the company, role and store scope; every statement here is still company-fenced.
// Anything edited by a person stops being sample data (is_sample = false).

const url = process.env.SUPABASE_URL_ARCHIVE;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY_ARCHIVE;

function db(): SupabaseClient {
  return createClient(url as string, key as string, {auth: {persistSession: false}});
}

export class SupplyError extends Error {
  constructor(public code: 'not_enough_stock' | 'not_in_transit' | 'already_arrived' | 'item_not_found', public detail?: number) {
    super(code);
  }
}

const now = () => new Date().toISOString();

export async function recordShipment(companyId: string, store: string, item: string, qty: number, by: string | null, today: string): Promise<string> {
  const {data, error} = await db().rpc('gl_record_shipment', {p_company: companyId, p_store: store, p_item: item, p_qty: qty, p_by: by, p_today: today});
  if (error) {
    const m = /not_enough_stock:(\d+)/.exec(error.message ?? '');
    if (m) throw new SupplyError('not_enough_stock', Number(m[1]));
    throw new Error(`gl_record_shipment failed: ${error.message}`);
  }
  return data as string;
}

export async function cancelShipment(companyId: string, id: string, by: string | null, today: string): Promise<void> {
  const {error} = await db().rpc('gl_cancel_shipment', {p_company: companyId, p_id: id, p_by: by, p_today: today});
  if (error) {
    if ((error.message ?? '').includes('not_in_transit')) throw new SupplyError('not_in_transit');
    if ((error.message ?? '').includes('already_arrived')) throw new SupplyError('already_arrived');
    throw new Error(`gl_cancel_shipment failed: ${error.message}`);
  }
}

/** The store a shipment goes to (for the caller's store-scope check), or null. */
export async function shipmentStore(companyId: string, id: string): Promise<string | null> {
  // pagination-ok: one row by primary key.
  const {data, error} = await db().from('gl_shipments').select('store_code').eq('company_id', companyId).eq('id', id).maybeSingle();
  if (error) throw new Error(`gl_shipments read failed: ${error.message}`);
  return (data as {store_code: string} | null)?.store_code ?? null;
}

/** Which of `items` are this company's catalog items. */
export async function existingItems(companyId: string, items: string[]): Promise<Set<string>> {
  if (!items.length) return new Set();
  // pagination-ok: bounded by the (≤ 500) codes asked about.
  const {data, error} = await db().from('gl_products').select('item_code').eq('company_id', companyId).in('item_code', items.slice(0, 500));
  if (error) throw new Error(`gl_products read failed: ${error.message}`);
  return new Set(((data ?? []) as Array<{item_code: string}>).map((r) => r.item_code));
}

/** Which of `stores` are this company's stores. */
export async function existingStores(companyId: string, stores: string[]): Promise<Set<string>> {
  if (!stores.length) return new Set();
  // pagination-ok: bounded by the (≤ 1000) codes asked about.
  const {data, error} = await db().from('gl_stores').select('store_code').eq('company_id', companyId).in('store_code', stores.slice(0, 1000));
  if (error) throw new Error(`gl_stores read failed: ${error.message}`);
  return new Set(((data ?? []) as Array<{store_code: string}>).map((r) => r.store_code));
}

/** Which of `lines` are product lines in this company's catalog. */
export async function existingLines(companyId: string, lines: string[]): Promise<Set<string>> {
  if (!lines.length) return new Set();
  // pagination-ok: bounded by the (≤ 500) lines asked about.
  const {data, error} = await db().from('gl_products').select('product_line').eq('company_id', companyId).in('product_line', lines.slice(0, 500));
  if (error) throw new Error(`gl_products read failed: ${error.message}`);
  return new Set(((data ?? []) as Array<{product_line: string}>).map((r) => r.product_line));
}

export async function setWarehouseStock(companyId: string, item: string, onHand: number, by: string | null): Promise<void> {
  const {error} = await db()
    .from('gl_warehouse_stock')
    .upsert({company_id: companyId, item_code: item, on_hand: onHand, is_sample: false, updated_by: by, updated_at: now()}, {onConflict: 'company_id,item_code'});
  if (error) throw new Error(`gl_warehouse_stock upsert failed: ${error.message}`);
}

export async function setPrice(companyId: string, item: string, price: number, by: string | null): Promise<void> {
  const {error} = await db().rpc('gl_set_price', {p_company: companyId, p_item: item, p_price: price, p_by: by});
  if (error) {
    if ((error.message ?? '').includes('item_not_found')) throw new SupplyError('item_not_found');
    throw new Error(`gl_set_price failed: ${error.message}`);
  }
}

export async function setHidden(companyId: string, item: string, hidden: boolean): Promise<void> {
  // pagination-ok: one row by primary key (company_id, item_code).
  const {data, error} = await db().from('gl_products').update({hidden}).eq('company_id', companyId).eq('item_code', item).select('item_code');
  if (error) throw new Error(`gl_products update failed: ${error.message}`);
  if (!data?.length) throw new SupplyError('item_not_found');
}

export async function saveSupplySettings(
  companyId: string,
  input: {
    defaults: {productionDays: number; transitDays: number} | null; // null = leave as is
    lines: Array<{line: string; days: number}>;
    stores: Array<{store: string; days: number}>;
  },
  by: string | null,
): Promise<void> {
  const supa = db();
  const at = now();
  if (input.defaults) {
    const {error} = await supa.from('gl_supply_settings').upsert(
      {
        company_id: companyId,
        default_production_days: input.defaults.productionDays,
        default_transit_days: input.defaults.transitDays,
        is_sample: false,
        updated_by: by,
        updated_at: at,
      },
      {onConflict: 'company_id'},
    );
    if (error) throw new Error(`gl_supply_settings upsert failed: ${error.message}`);
  }
  if (input.lines.length) {
    const {error} = await supa
      .from('gl_line_lead_times')
      .upsert(
        input.lines.map((l) => ({company_id: companyId, product_line: l.line, production_days: l.days, is_sample: false, updated_by: by, updated_at: at})),
        {onConflict: 'company_id,product_line'},
      );
    if (error) throw new Error(`gl_line_lead_times upsert failed: ${error.message}`);
  }
  if (input.stores.length) {
    const {error} = await supa
      .from('gl_store_transit')
      .upsert(
        input.stores.map((s) => ({company_id: companyId, store_code: s.store, transit_days: s.days, is_sample: false, updated_by: by, updated_at: at})),
        {onConflict: 'company_id,store_code'},
      );
    if (error) throw new Error(`gl_store_transit upsert failed: ${error.message}`);
  }
}
