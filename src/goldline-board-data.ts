import 'server-only';
import type {SupabaseClient} from '@supabase/supabase-js';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {salesUnits} from './goldline-sales-units';
import {getGlCatalog, getGlStores, getGlSupplyRef} from './goldline-ref-data';
import type {InventoryRowIn} from './goldline-inventory';
import {addDays, storeMovement, type Count} from './goldline-movement';
import {deliveredFrom, receivedBetween, type Receipt} from './goldline-po';
import {countedSoldByMonth, type ItemCount} from './goldline-product';
import {manilaDate, SHIPMENT_COLS, SHIPMENT_OPEN, shipmentOf, type CatalogItem, type Shipment, type ShipmentRow, type StoreBlock, type SupplyConfig} from './goldline-supply';

// Server-only reads behind the combined Goldline Inventory board: every store's recent
// counts (enough for this month, last month, the month before, and the movement
// estimate), the catalog, linked sales, and the supply side (warehouse, lead times,
// shipments). Company-scoped on every query (the service-role key bypasses RLS) and
// narrowed to a store-scoped role's stores.
//
// Reads ~4 months of counts for the caller's stores. At the 300-store ramp that's the
// point to move this rollup into a SQL function / materialized view.

const HISTORY_DAYS = 130;

const db = nichidoDb;

export type BoardData = {
  stores: StoreBlock[];
  storeList: Array<{code: string; name: string | null}>;
  catalog: Record<string, CatalogItem>;
  productLines: string[];
  warehouse: Record<string, number>;
  config: SupplyConfig;
  shipments: Shipment[];
  currentMonth: string;
  today: string;
};

type Row = ItemCount & {store_code: string};

export async function getBoardData(companyId: string, storeScope?: string[] | null, now = new Date()): Promise<BoardData> {
  const today = manilaDate(now);
  const empty: BoardData = {
    stores: [],
    storeList: [],
    catalog: {},
    productLines: [],
    warehouse: {},
    config: {defaultProductionDays: 30, defaultTransitDays: 3, lineProductionDays: {}, storeTransitDays: {}, isSample: true},
    shipments: [],
    currentMonth: today.slice(0, 7),
    today,
  };
  if (!nichidoConfigured()) return empty;
  const supa = db();
  const since = addDays(today, -HISTORY_DAYS);
  const scope = storeScope ? new Set(storeScope) : null;

  // Reference data (catalog, stores, supply) comes from the per-company cache; counts
  // and shipments are read fresh, the big counts read in parallel pages.
  const productsP = getGlCatalog(companyId);
  // The counts are small; the board only shows stores that have them, so linked sales
  // are read for those stores alone once the counts are in. Reading every store's sales
  // would grow with each linked SKU (a Watsons month is ~40k rows across ~300 stores).
  const countsP = fetchAllRows(
    'inventory',
    (from, to) => {
      let q = supa
        .from('inventory') // pagination-ok: paged by fetchAllRows (.range below)
        .select('store_code,item_code,period_start,period_end,stockroom,drawer,selling_area,delivery,ending_on_hand')
        .eq('company_id', companyId)
        .gte('period_end', since);
      if (storeScope) q = q.in('store_code', storeScope);
      return q.order('id').range(from, to);
    },
    undefined,
    {concurrency: 4},
  ) as unknown as Promise<Row[]>;
  const salesP = Promise.all([productsP, countsP]).then(([products, rows]) => {
    const counted = [...new Set(rows.map((r) => r.store_code))];
    return counted.length ? linkedSales(supa, companyId, products, since, counted) : [];
  });
  const [storesRows, products, supply, counts, shipments, sales, received] = await Promise.all([
    getGlStores(companyId),
    productsP,
    getGlSupplyRef(companyId),
    countsP,
    fetchAllRows('shipments', (from, to) => {
      let q = supa
        .from('shipments') // pagination-ok: paged by fetchAllRows (.range below)
        .select(SHIPMENT_COLS)
        .eq('company_id', companyId)
        .in('status', SHIPMENT_OPEN)
        .gte('arrives_on', since);
      if (storeScope) q = q.in('store_code', storeScope);
      return q.order('arrives_on').order('id').range(from, to);
    }) as unknown as Promise<ShipmentRow[]>,
    salesP,
    // What arrived on purchase orders (F12): it replaces a count's Delivery column.
    fetchAllRows('po_lines', (from, to) => {
      let q = supa
        .from('po_lines') // pagination-ok: paged by fetchAllRows (.range below)
        .select('store_code,item_code,received_qty,received_on')
        .eq('company_id', companyId)
        .not('received_qty', 'is', null)
        .gte('received_on', since);
      if (storeScope) q = q.in('store_code', storeScope);
      return q.order('id').range(from, to);
    }) as unknown as Promise<Array<{store_code: string; item_code: string; received_qty: number; received_on: string}>>,
  ]);
  const receiptsBy = new Map<string, Receipt[]>(); // store|item → receipts
  for (const r of received) {
    const k = `${r.store_code}|${r.item_code}`;
    receiptsBy.set(k, [...(receiptsBy.get(k) ?? []), {storeCode: r.store_code, itemCode: r.item_code, qty: r.received_qty, receivedOn: r.received_on}]);
  }
  const {settings, lines, transit, warehouse: wh} = supply;

  const itemBySku = new Map(products.filter((p) => p.sku_code?.trim()).map((p) => [p.sku_code!.trim(), p.item_code]));

  const catalog: Record<string, CatalogItem> = {};
  for (const p of products) {
    catalog[p.item_code] = {
      name: p.variant?.trim() || p.item_code,
      productLine: p.product_line,
      price: p.unit_price == null ? null : Number(p.unit_price),
      bestseller: Boolean(p.is_bestseller),
      hidden: Boolean(p.hidden),
      retired: Boolean(p.retired_at),
    };
  }

  // store → rows
  const byStore = new Map<string, Row[]>();
  for (const c of counts) {
    if (scope && !scope.has(c.store_code)) continue;
    // Delivered = what the store received on POs during the count's period, else the form's column.
    const mine = receiptsBy.get(`${c.store_code}|${c.item_code}`);
    const got = mine ? receivedBetween(mine, c.store_code, c.item_code, c.period_start, c.period_end) : undefined;
    const r = got === undefined ? c : {...c, delivery: deliveredFrom(c.delivery ?? 0, got)};
    const list = byStore.get(r.store_code);
    if (list) list.push(r);
    else byStore.set(r.store_code, [r]);
  }
  const salesBy = new Map<string, Map<string, number>>(); // store|item → month → units
  for (const s of sales) {
    if (scope && !scope.has(s.store_code)) continue;
    const item = itemBySku.get(s.sku_code);
    if (!item) continue;
    const k = `${s.store_code}|${item}`;
    const m = salesBy.get(k) ?? new Map<string, number>();
    const month = s.period_end.slice(0, 7);
    m.set(month, (m.get(month) ?? 0) + (Number(s.units) || 0));
    salesBy.set(k, m);
  }

  const nameOf = new Map(storesRows.map((s) => [s.store_code, s.name]));
  const stores: StoreBlock[] = [...byStore.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, {numeric: true}))
    .map(([storeCode, rows]) => {
      const periods = new Map<string, Count>();
      const byItem = new Map<string, ItemCount[]>();
      for (const r of rows) {
        const k = `${r.period_start}|${r.period_end}`;
        const c = periods.get(k) ?? {period_start: r.period_start, period_end: r.period_end, rows: []};
        c.rows.push(r as InventoryRowIn);
        periods.set(k, c);
        const list = byItem.get(r.item_code);
        if (list) list.push(r);
        else byItem.set(r.item_code, [r]);
      }
      const mv = storeMovement([...periods.values()]);
      const latestRows = new Map((mv.latest?.rows ?? []).map((r) => [r.item_code, r]));
      return {
        storeCode,
        storeName: nameOf.get(storeCode) ?? null,
        latestEnd: mv.latest?.period_end ?? null,
        cycleDays: mv.cycleDays,
        items: mv.items.map((m) => {
          const monthly = countedSoldByMonth(byItem.get(m.item_code) ?? []);
          for (const [month, units] of salesBy.get(`${storeCode}|${m.item_code}`) ?? []) monthly.set(month, units);
          return {itemCode: m.item_code, movement: m, row: latestRows.get(m.item_code) ?? null, monthly};
        }),
      };
    });

  const latest = stores.map((s) => s.latestEnd).filter((d): d is string => !!d).sort().pop();
  const sample =
    Boolean(settings?.is_sample) || lines.some((l) => l.is_sample) || transit.some((t) => t.is_sample) || wh.some((w) => w.is_sample);
  const activeCodes = storesRows.filter((s) => s.status !== 'closed' && (!scope || scope.has(s.store_code))).map((s) => s.store_code);
  const listCodes = [...new Set([...activeCodes, ...byStore.keys()])].sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));

  return {
    stores,
    storeList: listCodes.map((code) => ({code, name: nameOf.get(code) ?? null})),
    catalog,
    productLines: [...new Set(products.map((p) => p.product_line).filter((l): l is string => !!l))].sort(),
    warehouse: Object.fromEntries(wh.map((w) => [w.item_code, w.on_hand])),
    config: {
      defaultProductionDays: settings?.default_production_days ?? 30,
      defaultTransitDays: settings?.default_transit_days ?? 3,
      lineProductionDays: Object.fromEntries(lines.map((l) => [l.product_line, l.production_days])),
      storeTransitDays: Object.fromEntries(transit.map((t) => [t.store_code, t.transit_days])),
      isSample: sample,
    },
    shipments: shipments.map(shipmentOf).filter((s): s is Shipment => s != null),
    currentMonth: (latest ?? today).slice(0, 7),
    today,
  };
}

/** Sales-report units for items with a linked POS SKU, chunked so a big catalog
 *  doesn't overflow the request URL. */
async function linkedSales(
  supa: SupabaseClient,
  companyId: string,
  products: Array<{item_code: string; sku_code: string | null}>,
  since: string,
  storeScope?: string[] | null,
): Promise<Array<{store_code: string; sku_code: string; period_end: string; units: number}>> {
  const skus = [...new Set(products.map((p) => p.sku_code?.trim()).filter((s): s is string => !!s))];
  const chunks: string[][] = [];
  for (let i = 0; i < skus.length; i += 100) chunks.push(skus.slice(i, i + 100));
  const pages = await Promise.all(
    chunks.map((chunk) => salesUnits(companyId, {fromEnd: since, skus: chunk, stores: storeScope})),
  );
  return pages.flat().map((r) => ({store_code: r.store_code, sku_code: r.sku_code, period_end: r.period_end, units: Number(r.units) || 0}));
}
