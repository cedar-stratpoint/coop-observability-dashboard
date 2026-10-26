// Pure adapters from each source's rows to the `ChannelRead` that src/sku-compare.ts takes. No I/O: the data is passed in (the server-side loaders are in
// src/sku-compare-data.ts; the CRM call is made by the wiring step, which hands each week's response body to `websiteReader`).
import {productSales} from './chat/product-sales';
import type {MetricData} from './chat/result-types';
import {isMonday, weekContaining, type AliasRow, type AliasType, type ChannelReader, type RawSkuRow} from './sku-compare';

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

// ---------- POS: the canonical channel; one row per week for the asked SKU, direct sales plus the bundle allocation ----------
export function posReader(data: MetricData, name = ''): ChannelReader {
  return async ({sku, weeks}) => {
    const rows: RawSkuRow[] = weeks.map((w) => {
      const {from, to} = weekContaining(w);
      const r = productSales(sku, name || sku, data, from, to).rows[0];
      return {week_from: w, keys: [{type: 'sku', value: sku}], units: num(r.total_units), revenue: num(r.total_revenue), allocated: num(r.bundle_units) > 0};
    });
    return {rows, weeksWithData: weeks, notes: data.source === 'mock' ? ['POS is sample data, not real sales.'] : []};
  };
}

// ---------- Shopee: marketplace_sku_weekly rows ----------
export interface ShopeeSkuRow {
  period_from: string;
  period_to: string;
  item_id: string;
  product: string;
  variation_id: string | null;
  sku: string | null;
  sales_confirmed: number;
  units_confirmed: number;
}
/**
 * One row per product per week. A product with variation rows is counted by its variations (they carry the SKU) and its own row is dropped, so a variation is
 * never added to the product row above it. `shopWeekTotals` (confirmed shop sales per Monday) gives the coverage; without it coverage is unknown.
 * A week that is not a Monday-to-Sunday week is left out with a note.
 */
export function shopeeReader(rows: readonly ShopeeSkuRow[], shopWeekTotals: Record<string, number> = {}): ChannelReader {
  return async ({weeks}) => {
    const notes: string[] = [];
    const byWeek = new Map<string, Map<string, ShopeeSkuRow[]>>();
    for (const r of rows) {
      const week = r.period_from;
      if (!weeks.includes(week)) continue;
      if (!isMonday(week) || weekContaining(week).to !== r.period_to) {
        if (!notes.length) notes.push('A Shopee SKU report that is not a Monday to Sunday week was left out.');
        continue;
      }
      const items = byWeek.get(week) ?? new Map<string, ShopeeSkuRow[]>();
      items.set(r.item_id, [...(items.get(r.item_id) ?? []), r]);
      byWeek.set(week, items);
    }
    const out: RawSkuRow[] = [];
    const coveragePct: Record<string, number | null> = {};
    for (const [week, items] of byWeek) {
      let sales = 0;
      for (const group of items.values()) {
        const variations = group.filter((g) => g.variation_id !== null);
        for (const g of variations.length ? variations : group) {
          const keys: {type: AliasType; value: string}[] = [];
          if (g.sku) keys.push({type: 'sku', value: g.sku});
          if (g.variation_id) keys.push({type: 'item_id+variation_id', value: `${g.item_id}+${g.variation_id}`});
          keys.push({type: 'title', value: g.product});
          out.push({week_from: week, keys, label: g.product, units: g.units_confirmed, revenue: g.sales_confirmed});
          sales += g.sales_confirmed;
        }
      }
      const total = shopWeekTotals[week];
      coveragePct[week] = total && total > 0 ? Math.min(100, (sales / total) * 100) : null;
    }
    return {rows: out, weeksWithData: [...byWeek.keys()].sort(), coveragePct, complete: false, notes};
  };
}

// ---------- Website: the CRM's GET /api/products/sales body, one call per week ----------
/** `{products: [{sku, variant_id, product_id, title, units, gross, discounts, net, orders}], truncated, unmapped}` (zoomy-crm docs/api-sales.md). */
export function websiteRowsFromCrm(body: unknown, weekFrom: string): {rows: RawSkuRow[]; truncated: boolean} {
  const b = body as {products?: unknown; truncated?: unknown} | null;
  if (!b || !Array.isArray(b.products)) throw new Error('bad_shape');
  const rows = b.products.map((p: Record<string, unknown>): RawSkuRow => {
    const keys: {type: AliasType; value: string}[] = [];
    if (str(p.sku)) keys.push({type: 'sku', value: str(p.sku)});
    if (str(p.variant_id)) keys.push({type: 'variant_id', value: str(p.variant_id)});
    if (str(p.title)) keys.push({type: 'title', value: str(p.title)});
    return {week_from: weekFrom, keys, label: str(p.title), units: num(p.units), revenue: num(p.net)};
  });
  return {rows, truncated: b.truncated === true};
}
/** `fetchWeek(from, to)` returns the parsed CRM body for that Monday-to-Sunday week (the wiring step owns the CRM call and its limits). */
export function websiteReader(fetchWeek: (from: string, to: string) => Promise<unknown>): ChannelReader {
  return async ({weeks}) => {
    const rows: RawSkuRow[] = [];
    let truncated = false;
    for (const w of weeks) {
      const {from, to} = weekContaining(w);
      const r = websiteRowsFromCrm(await fetchWeek(from, to), w);
      rows.push(...r.rows);
      truncated = truncated || r.truncated;
    }
    return {rows, weeksWithData: weeks, complete: !truncated, notes: truncated ? ['The website ranking was cut at its limit, so a low-selling SKU may be missing.'] : []};
  };
}

// ---------- the alias table ----------
export function aliasRowsFromDb(rows: readonly Record<string, unknown>[]): AliasRow[] {
  return rows.map((r) => ({
    channel: r.channel as AliasRow['channel'],
    alias_type: r.alias_type as AliasType,
    alias_value: str(r.alias_value),
    product_id: str(r.product_id),
    bundle_id: r.bundle_id === null || r.bundle_id === undefined ? null : str(r.bundle_id),
    component_qty: r.component_qty === undefined ? 1 : num(r.component_qty),
    valid_from: r.valid_from ? str(r.valid_from) : null,
    valid_to: r.valid_to ? str(r.valid_to) : null,
    source: r.source === 'auto' ? 'auto' : 'manual',
    confirmed_at: r.confirmed_at ? str(r.confirmed_at) : null,
  }));
}
