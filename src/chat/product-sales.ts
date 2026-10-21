// lookup_product show "sales": ONE product's offline sales over the owner's dates, in one result: direct sales, units picked inside bundles
// with the bundle's paid price shared out (equal share per unit, the owner's rule; list-price weighted alongside), and the combined total.
// Pure: orders and prices are injected. Money is summed in whole centavos.
import {bundlePickRows} from '../pos-bundle-compute';
import {buildPriceHistory} from '../pos-price-history';
import {manilaDayKey} from '../pos-sales-compute';
import {bundleRevenueByPet} from '../pos-bundle-compute';
import {isCompletedOrder} from './order-status';
import {rangeLabel} from './range';
import type {Check, MeasureDecl, MetricData, MetricResult, MetricRow, ResultColumn} from './result-types';

const col = (key: string, label: string, unit: ResultColumn['unit'], role: ResultColumn['role']): ResultColumn => ({key, label, unit, role});
const C = (n: number): number => Math.round(n * 100);
const peso = (c: number): string => `₱${(c / 100).toLocaleString('en-US', {minimumFractionDigits: 0, maximumFractionDigits: 2})}`;

const COLUMNS: ResultColumn[] = [
  col('name', 'Product', 'text', 'category'),
  col('direct_orders', 'Direct orders', 'count', 'measure'),
  col('direct_units', 'Direct units', 'units', 'measure'),
  col('direct_revenue', 'Direct revenue', 'PHP', 'measure'),
  col('bundle_orders', 'Orders with it in a bundle', 'count', 'measure'),
  col('bundle_units', 'Units in bundles', 'units', 'measure'),
  col('bundle_revenue', 'Bundle revenue (equal share per unit)', 'PHP', 'measure'),
  col('bundle_revenue_by_list_price', 'Bundle revenue (shared by list price)', 'PHP', 'measure'),
  col('total_units', 'Total units', 'units', 'measure'),
  col('total_revenue', 'Total revenue (direct + equal share)', 'PHP', 'measure'),
];
const MEASURE: MeasureDecl = {
  key: 'total_revenue',
  label: 'Product sales',
  kind: 'allocated',
  unit: 'PHP',
  method: "Direct revenue is the product's own sale lines. A bundle's paid price is shared out per unit picked inside it (equal share per unit: the bundle's price divided by all units in it, times this product's units). The list-price column shares the same price by each pick's list price on the sale day. Both are allocations, not receipts.",
};

export function productSales(sku: string, name: string, data: MetricData, from: string, to: string): MetricResult {
  const orders = data.orders.filter((o) => isCompletedOrder(o) && !Number.isNaN(Date.parse(o.created_at)) && manilaDayKey(o.created_at) >= from && manilaDayKey(o.created_at) <= to);
  let directC = 0;
  let directUnits = 0;
  const directOrders = new Set<string>();
  for (const o of orders) {
    for (const l of o.items) {
      if (l.product_id !== sku || l.bundle_group) continue;
      directUnits += l.qty;
      directC += C(l.line_total);
      directOrders.add(o.id);
    }
  }

  const picks = bundlePickRows(orders, buildPriceHistory(data.prices, data.priceChanges));
  const groupUnits = new Map<string, number>();
  const groupPaidC = new Map<string, number>();
  for (const r of picks.rows) {
    const k = `${r.order_id}|${r.bundle_group}`;
    groupUnits.set(k, (groupUnits.get(k) ?? 0) + r.qty);
    groupPaidC.set(k, (groupPaidC.get(k) ?? 0) + C(r.allocated));
  }
  let bundleUnits = 0;
  let equalC = 0;
  let listC = 0;
  const bundleOrders = new Set<string>();
  for (const r of picks.rows) {
    if (r.product_id !== sku) continue;
    const k = `${r.order_id}|${r.bundle_group}`;
    bundleUnits += r.qty;
    bundleOrders.add(r.order_id);
    listC += C(r.allocated);
    equalC += Math.round(((groupPaidC.get(k) ?? 0) / (groupUnits.get(k) || 1)) * r.qty);
  }

  const row: MetricRow = {
    name,
    direct_orders: directOrders.size,
    direct_units: directUnits,
    direct_revenue: directC / 100,
    bundle_orders: bundleOrders.size,
    bundle_units: bundleUnits,
    bundle_revenue: equalC / 100,
    bundle_revenue_by_list_price: listC / 100,
    total_units: directUnits + bundleUnits,
    total_revenue: (directC + equalC) / 100,
  };

  const bundleRevenue = bundleRevenueByPet(orders).bundleRevenue;
  const noDetailC = C(bundleRevenue) - C(picks.paidTotal) - C(picks.unallocatedPaid);
  const checks: Check[] = [
    {code: 'partial_coverage', status: 'info', text: `Bundle revenue here is an allocation: each bundle's price divided by the units in it, times this product's units (equal share per unit). The list-price column shares the same prices by list price. Say the method with the figure.`},
  ];
  if (noDetailC >= 100) {
    checks.push({code: 'partial_coverage', status: 'warn', text: `${peso(noDetailC)} of bundle revenue in these dates (${((noDetailC / C(bundleRevenue)) * 100).toFixed(1)}%) has no pick detail (older sales), so the bundle figures for this product leave those bundles out.`});
  }
  if (data.source === 'mock') checks.push({code: 'mock_source', status: 'warn', text: 'This is sample data, not real sales.'});
  const label = rangeLabel(from, to);
  return {
    id: '',
    metric: 'product_lookup',
    dimension: 'sales',
    columns: COLUMNS,
    rows: [row],
    meta: {
      source: data.source, range: {from, to, label}, dataFrom: from, dataTo: to, rowCount: 1, coverage: noDetailC >= 100 ? 'partial' : 'full', coveredFrom: from, coveredTo: to,
      caveats: checks.map((c) => c.text), share_basis: null, measure: MEASURE.key, measures: [MEASURE], insights: [], checks, reliable: true,
    },
  };
}
