import {describe, it, expect} from 'vitest';
import {
  boundsFromMax,
  bundleSalesSummary,
  computeKpis,
  eventRollups,
  effectiveEventId,
  resolveOrderEvents,
  overlappingEvent,
  currentEventIds,
  untaggedOnEventDays,
  eventFilterScope,
  eventsCoveringOrder,
  DEFAULT_ORDERS_FILTER,
  featuredEvent,
  eventTimeState,
  eventMatchesQuery,
  filterAndSortEvents,
  paymentBreakdown,
  eventRevenueSeries,
  eventDayPacingSeries,
  manilaMinuteOfDay,
  datesInRange,
  paymentMethodOptions,
  manilaDayKey,
  orderMethod,
  petMix,
  presentMethods,
  salesByDayAndMethod,
  topBundles,
  filterOrders,
  filterOrdersByRange,
  isBundleOrder,
  orderToEntries,
  isFilterActive,
  isSalesRange,
  offlineChannelFacts,
  offlineCompareMetrics,
  paginate,
  parseOrdersFilter,
  parsePage,
  priceBounds,
  rangeStart,
  salesByDay,
  stockAlerts,
  topProducts,
} from '../src/pos-sales-compute';
import type {EventRollup, PosEvent, PosOrder} from '../src/pos-sales-types';
import type {PosProductRow} from '../src/pos-types';

const NOW = new Date('2026-09-07T12:00:00.000Z');

function order(over: Partial<PosOrder> & {id: string; created_at: string}): PosOrder {
  return {
    client_uuid: `${over.id}-uuid`,
    subtotal: 100,
    discount: null,
    total: 100,
    oversold: false,
    device_id: 'pos',
    payment_method: 'cash',
    customer_handle: null,
    status: 'completed',
    remarks: null,
    edited_at: null,
    event_id: null,
    pet_type: null,
    items: [{product_id: 'A', name: 'A', qty: 1, unit_price: 100, line_total: 100}],
    ...over,
  };
}

describe('isSalesRange / rangeStart', () => {
  it('validates range strings', () => {
    expect(isSalesRange('7d')).toBe(true);
    expect(isSalesRange('nope')).toBe(false);
    expect(isSalesRange(undefined)).toBe(false);
  });
  it('computes an inclusive start, null for all', () => {
    expect(rangeStart('all', NOW)).toBeNull();
    // 'today' is the Manila calendar day: NOW is Sep 7 20:00 Manila, so the day
    // began Sep 7 00:00 Manila = Sep 6 16:00 UTC.
    expect(rangeStart('today', NOW)).toBe('2026-09-06T16:00:00.000Z');
    expect(rangeStart('7d', NOW)).toBe('2026-08-31T12:00:00.000Z');
    expect(rangeStart('30d', NOW)).toBe('2026-08-08T12:00:00.000Z');
  });
});

describe('filterOrdersByRange', () => {
  const orders = [
    order({id: '1', created_at: '2026-09-07T09:00:00.000Z'}), // today
    order({id: '2', created_at: '2026-09-02T09:00:00.000Z'}), // ~5d
    order({id: '3', created_at: '2026-07-01T09:00:00.000Z'}), // old
  ];
  it('today keeps only today', () => {
    expect(filterOrdersByRange(orders, 'today', NOW).map((o) => o.id)).toEqual(['1']);
  });
  it('7d keeps the last week', () => {
    expect(filterOrdersByRange(orders, '7d', NOW).map((o) => o.id)).toEqual(['1', '2']);
  });
  it('all keeps everything', () => {
    expect(filterOrdersByRange(orders, 'all', NOW)).toHaveLength(3);
  });
});

describe('computeKpis', () => {
  it('sums revenue, counts orders/units/oversells', () => {
    const orders = [
      order({id: '1', created_at: NOW.toISOString(), total: 540, items: [
        {product_id: 'A', name: 'A', qty: 2, unit_price: 200, line_total: 400},
        {product_id: 'B', name: 'B', qty: 1, unit_price: 140, line_total: 140},
      ]}),
      order({id: '2', created_at: NOW.toISOString(), total: 300, oversold: true, items: [
        {product_id: 'C', name: 'C', qty: 1, unit_price: 300, line_total: 300},
      ]}),
    ];
    expect(computeKpis(orders)).toEqual({revenue: 840, orders: 2, units: 4, oversells: 1});
  });
  it('handles no orders', () => {
    expect(computeKpis([])).toEqual({revenue: 0, orders: 0, units: 0, oversells: 0});
  });
  it('excludes voided sales from every total', () => {
    const orders = [
      order({id: '1', created_at: NOW.toISOString(), total: 500, items: [{product_id: 'A', name: 'A', qty: 2, unit_price: 250, line_total: 500}]}),
      order({id: '2', created_at: NOW.toISOString(), total: 900, status: 'voided', items: [{product_id: 'B', name: 'B', qty: 3, unit_price: 300, line_total: 900}]}),
    ];
    expect(computeKpis(orders)).toEqual({revenue: 500, orders: 1, units: 2, oversells: 0});
  });
});

describe('isBundleOrder', () => {
  it('flags an order whose total exceeds its product-line sum (bundle premium)', () => {
    // A "Buy Any 4 for ₱570" sale: ₱0 component picks, premium on the header.
    const o = order({
      id: 'b1', created_at: '2026-09-07T00:00:00.000Z', total: 570,
      items: [{product_id: 'CGC', name: 'Cat Grass Cubes', qty: 4, unit_price: 0, line_total: 0}],
    });
    expect(isBundleOrder(o)).toBe(true);
  });
  it('does not flag a plain order where total equals the line sum', () => {
    const o = order({
      id: 'p1', created_at: '2026-09-07T00:00:00.000Z', total: 400,
      items: [{product_id: 'A', name: 'A', qty: 2, unit_price: 200, line_total: 400}],
    });
    expect(isBundleOrder(o)).toBe(false);
  });
  it('does not flag a discounted order (total below the line sum)', () => {
    const o = order({
      id: 'd1', created_at: '2026-09-07T00:00:00.000Z', total: 350, discount: 50,
      items: [{product_id: 'A', name: 'A', qty: 2, unit_price: 200, line_total: 400}],
    });
    expect(isBundleOrder(o)).toBe(false);
  });
});

describe('orderToEntries', () => {
  const L = (over: Partial<PosOrder['items'][number]>): PosOrder['items'][number] => ({
    product_id: null, bundle_id: null, bundle_group: null, name: 'x', qty: 1, unit_price: 0, line_total: 0, ...over,
  });

  it('rebuilds a bundle group (header + ₱0 picks) alongside an individual item', () => {
    const o = order({
      id: 'm1', created_at: '2026-09-07T00:00:00.000Z', total: 800,
      items: [
        L({product_id: 'BEEF', qty: 1, unit_price: 200, line_total: 200}),
        L({bundle_id: 'B3', bundle_group: '1', unit_price: 600, line_total: 600}),
        L({product_id: 'CGC', bundle_group: '1', qty: 1}),
        L({product_id: 'SLM', bundle_group: '1', qty: 1}),
      ],
    });
    expect(orderToEntries(o)).toEqual([
      {kind: 'item', product_id: 'BEEF', qty: 1, unit_price: 200},
      {kind: 'bundle', bundle_id: 'B3', price: 600, picks: [{product_id: 'CGC', qty: 1}, {product_id: 'SLM', qty: 1}]},
    ]);
  });

  it('treats a legacy fixed-bundle header (no group) as a bundle with no picks', () => {
    const o = order({
      id: 'm2', created_at: '2026-09-07T00:00:00.000Z', total: 300,
      items: [L({bundle_id: 'FIX', unit_price: 300, line_total: 300})],
    });
    expect(orderToEntries(o)).toEqual([{kind: 'bundle', bundle_id: 'FIX', price: 300, picks: []}]);
  });

  it('keeps an orphan group (picks, no header) as its own custom bundle', () => {
    const o = order({
      id: 'm3', created_at: '2026-09-07T00:00:00.000Z', total: 0,
      items: [L({product_id: 'CGC', bundle_group: '9', qty: 2})],
    });
    expect(orderToEntries(o)).toEqual([{kind: 'bundle', bundle_id: '', price: 0, picks: [{product_id: 'CGC', qty: 2}]}]);
  });

  it('folds a legacy bundle (₱0 picks + premium on total) into a bundle, auto-linked by pick_count', () => {
    // A "Buy Any 4 for ₱570" recorded the old way: 4 ₱0 picks, premium on total,
    // plus a ₱170 individual item. Total 740; premium = 740 - 170 = 570.
    const o = order({
      id: 'm4', created_at: '2026-09-07T00:00:00.000Z', total: 740,
      items: [
        L({product_id: 'SLM', qty: 1}), L({product_id: 'CHK', qty: 1}),
        L({product_id: 'BEEF', qty: 1}), L({product_id: 'STICK', qty: 1}),
        L({product_id: 'CGC', qty: 1, unit_price: 170, line_total: 170}),
      ],
    });
    const defs = [{bundle_id: 'B4', bundle_type: 'pick' as const, pick_count: 4, price: 650}, {bundle_id: 'B3', bundle_type: 'pick' as const, pick_count: 3, price: 500}];
    expect(orderToEntries(o, defs)).toEqual([
      {kind: 'item', product_id: 'CGC', qty: 1, unit_price: 170},
      {kind: 'bundle', bundle_id: 'B4', price: 570, picks: [
        {product_id: 'SLM', qty: 1}, {product_id: 'CHK', qty: 1}, {product_id: 'BEEF', qty: 1}, {product_id: 'STICK', qty: 1},
      ]},
    ]);
  });

  it('leaves a legacy bundle unlinked (empty bundle_id) when no pick_count matches', () => {
    const o = order({
      id: 'm5', created_at: '2026-09-07T00:00:00.000Z', total: 500,
      items: [L({product_id: 'A', qty: 1}), L({product_id: 'B', qty: 1})],
    });
    const out = orderToEntries(o, [{bundle_id: 'B4', bundle_type: 'pick', pick_count: 4, price: 650}]);
    expect(out).toEqual([{kind: 'bundle', bundle_id: '', price: 500, picks: [{product_id: 'A', qty: 1}, {product_id: 'B', qty: 1}]}]);
  });

  it('shows two orphan bundle groups (no headers) as two separate bundles, not one merged', () => {
    // A sale of two bundles whose Coop ids didn\'t resolve: picks grouped but no
    // header, premium (1120) on the total. Group 1 (4 picks) auto-links to B4 and
    // takes its list price (650); the remainder (470) lands on the unlinked group 2.
    const o = order({
      id: 'm6', created_at: '2026-09-07T00:00:00.000Z', total: 1120,
      items: [
        L({product_id: 'A', bundle_group: '1', qty: 1}), L({product_id: 'B', bundle_group: '1', qty: 1}),
        L({product_id: 'C', bundle_group: '1', qty: 1}), L({product_id: 'D', bundle_group: '1', qty: 1}),
        L({product_id: 'E', bundle_group: '2', qty: 1}), L({product_id: 'F', bundle_group: '2', qty: 1}),
      ],
    });
    const defs = [{bundle_id: 'B4', bundle_type: 'pick' as const, pick_count: 4, price: 650}];
    expect(orderToEntries(o, defs)).toEqual([
      {kind: 'bundle', bundle_id: 'B4', price: 650, picks: [{product_id: 'A', qty: 1}, {product_id: 'B', qty: 1}, {product_id: 'C', qty: 1}, {product_id: 'D', qty: 1}]},
      {kind: 'bundle', bundle_id: '', price: 470, picks: [{product_id: 'E', qty: 1}, {product_id: 'F', qty: 1}]},
    ]);
  });
});

describe('void exclusion in aggregations', () => {
  it('drops voided sales from salesByDay and topProducts', () => {
    const orders = [
      order({id: '1', created_at: '2026-09-07T09:00:00.000Z', total: 100, items: [{product_id: 'A', name: 'A', qty: 1, unit_price: 100, line_total: 100}]}),
      order({id: '2', created_at: '2026-09-07T10:00:00.000Z', total: 900, status: 'voided', items: [{product_id: 'A', name: 'A', qty: 9, unit_price: 100, line_total: 900}]}),
    ];
    expect(salesByDay(orders)).toEqual([{day: '2026-09-07', revenue: 100, orders: 1}]);
    expect(topProducts(orders)).toEqual([{product_id: 'A', name: 'A', revenue: 100, units: 1, bundledUnits: 0}]);
  });
});

describe('payment-method breakdown', () => {
  it('normalizes null/legacy payment_method to cash', () => {
    expect(orderMethod(order({id: '1', created_at: NOW.toISOString(), payment_method: null}))).toBe('cash');
    expect(orderMethod(order({id: '2', created_at: NOW.toISOString(), payment_method: 'gcash'}))).toBe('gcash');
  });

  it('lists present methods in canonical order, excluding voided', () => {
    const orders = [
      order({id: '1', created_at: NOW.toISOString(), payment_method: 'gcash'}),
      order({id: '2', created_at: NOW.toISOString(), payment_method: null}), // cash
      order({id: '3', created_at: NOW.toISOString(), payment_method: 'card'}),
      order({id: '4', created_at: NOW.toISOString(), payment_method: 'maya', status: 'voided'}),
    ];
    expect(presentMethods(orders)).toEqual(['cash', 'gcash', 'card']);
  });

  it('splits revenue by Manila day and method, excluding voided', () => {
    const orders = [
      order({id: '1', created_at: '2026-09-07T09:00:00Z', total: 100, payment_method: 'cash'}), // Sep 7 Manila
      order({id: '2', created_at: '2026-09-07T10:00:00Z', total: 200, payment_method: 'gcash'}), // Sep 7 Manila
      order({id: '3', created_at: '2026-09-07T20:00:00Z', total: 50, payment_method: 'cash'}), // Sep 8 Manila (crosses midnight)
      order({id: '4', created_at: '2026-09-07T11:00:00Z', total: 999, payment_method: 'cash', status: 'voided'}),
    ];
    expect(salesByDayAndMethod(orders)).toEqual([
      {day: '2026-09-07', byMethod: {cash: 100, gcash: 200}},
      {day: '2026-09-08', byMethod: {cash: 50}},
    ]);
  });
});

describe('manilaDayKey', () => {
  it('returns the Manila calendar day for an instant', () => {
    expect(manilaDayKey('2026-09-07T09:00:00Z')).toBe('2026-09-07'); // 17:00 Manila
    expect(manilaDayKey('2026-09-07T20:00:00Z')).toBe('2026-09-08'); // 04:00 Manila next day
  });
});

describe('salesByDay', () => {
  it('groups by Manila calendar day ascending', () => {
    const orders = [
      order({id: '1', created_at: '2026-09-07T09:00:00.000Z', total: 100}), // Sep 7 17:00 Manila
      order({id: '2', created_at: '2026-09-07T20:00:00.000Z', total: 50}), // Sep 8 04:00 Manila (crosses midnight)
      order({id: '3', created_at: '2026-09-05T09:00:00.000Z', total: 200}), // Sep 5 17:00 Manila
    ];
    expect(salesByDay(orders)).toEqual([
      {day: '2026-09-05', revenue: 200, orders: 1},
      {day: '2026-09-07', revenue: 100, orders: 1},
      {day: '2026-09-08', revenue: 50, orders: 1},
    ]);
  });
});

describe('topProducts', () => {
  it('ranks by revenue, skips SKU-less lines, respects limit', () => {
    const orders = [
      order({id: '1', created_at: NOW.toISOString(), items: [
        {product_id: 'A', name: 'Alpha', qty: 1, unit_price: 100, line_total: 100},
        {product_id: null, name: 'Bundle', qty: 1, unit_price: 0, line_total: 0},
      ]}),
      order({id: '2', created_at: NOW.toISOString(), items: [
        {product_id: 'A', name: 'Alpha', qty: 2, unit_price: 100, line_total: 200},
        {product_id: 'B', name: 'Beta', qty: 5, unit_price: 50, line_total: 250},
      ]}),
    ];
    const top = topProducts(orders, 5);
    expect(top).toEqual([
      {product_id: 'B', name: 'Beta', revenue: 250, units: 5, bundledUnits: 0},
      {product_id: 'A', name: 'Alpha', revenue: 300, units: 3, bundledUnits: 0},
    ].sort((a, b) => b.revenue - a.revenue));
    expect(topProducts(orders, 1)).toHaveLength(1);
  });

  it('ranks by units when sortBy is "units" (revenue as tiebreak)', () => {
    const orders = [
      order({id: '1', created_at: NOW.toISOString(), items: [
        {product_id: 'A', name: 'Alpha', qty: 1, unit_price: 1000, line_total: 1000}, // high revenue, low units
        {product_id: 'B', name: 'Beta', qty: 10, unit_price: 50, line_total: 500}, // low revenue, high units
      ]}),
    ];
    expect(topProducts(orders, 5, 'revenue').map((t) => t.product_id)).toEqual(['A', 'B']);
    expect(topProducts(orders, 5, 'units').map((t) => t.product_id)).toEqual(['B', 'A']);
  });

  it('counts ₱0 (bundle-pick) lines as units but not revenue', () => {
    // The Cat Grass case from prod: 5 sold at 170 (real revenue) + 4 given as
    // bundle picks at 0 -> 9 units, 850 revenue, 4 of them bundled.
    const orders = [
      order({id: '1', created_at: NOW.toISOString(), items: [
        {product_id: 'CG', name: 'Cat Grass', qty: 5, unit_price: 170, line_total: 850},
      ]}),
      order({id: '2', created_at: NOW.toISOString(), total: 570, items: [
        {product_id: 'CG', name: 'Cat Grass', qty: 4, unit_price: 0, line_total: 0},
      ]}),
    ];
    expect(topProducts(orders)).toEqual([{product_id: 'CG', name: 'Cat Grass', revenue: 850, units: 9, bundledUnits: 4}]);
  });
});

describe('bundleSalesSummary', () => {
  it('reconciles itemized product revenue with the Revenue KPI', () => {
    const orders = [
      // à la carte: order total equals its line sum -> no bundle revenue
      order({id: '1', created_at: NOW.toISOString(), total: 850, items: [
        {product_id: 'CG', name: 'Cat Grass', qty: 5, unit_price: 170, line_total: 850},
      ]}),
      // a "Buy Any 4" bundle: 570 on the header, all component lines ₱0
      order({id: '2', created_at: NOW.toISOString(), total: 570, items: [
        {product_id: 'CG', name: 'Cat Grass', qty: 1, unit_price: 0, line_total: 0},
        {product_id: 'BL', name: 'Beef Liver', qty: 1, unit_price: 0, line_total: 0},
        {product_id: 'DB', name: 'Duck Breast', qty: 1, unit_price: 0, line_total: 0},
        {product_id: 'CH', name: 'Chicken', qty: 1, unit_price: 0, line_total: 0},
      ]}),
    ];
    const s = bundleSalesSummary(orders);
    expect(s).toEqual({itemizedRevenue: 850, bundleRevenue: 570, bundleOrders: 1, totalRevenue: 1420});
    // The invariant the reconciliation line relies on:
    expect(s.itemizedRevenue + s.bundleRevenue).toBe(s.totalRevenue);
  });

  it('excludes voided orders and reports no bundle revenue for pure à-la-carte data', () => {
    const orders = [
      order({id: '1', created_at: NOW.toISOString(), total: 200, items: [
        {product_id: 'A', name: 'A', qty: 1, unit_price: 200, line_total: 200},
      ]}),
      order({id: '2', created_at: NOW.toISOString(), total: 570, status: 'voided', items: [
        {product_id: 'A', name: 'A', qty: 1, unit_price: 0, line_total: 0},
      ]}),
    ];
    expect(bundleSalesSummary(orders)).toEqual({itemizedRevenue: 200, bundleRevenue: 0, bundleOrders: 0, totalRevenue: 200});
  });

  it('keeps bundle-line revenue out of itemized (post write-path fix)', () => {
    // A bundle recorded the new way: a bundle_id line carries the price, picks ride at ₱0.
    const orders = [
      order({id: '1', created_at: NOW.toISOString(), total: 570, items: [
        {product_id: null, bundle_id: 'buy-any-4', name: 'Buy Any 4', qty: 1, unit_price: 570, line_total: 570},
        {product_id: 'A', name: 'A', qty: 1, unit_price: 0, line_total: 0},
        {product_id: 'B', name: 'B', qty: 1, unit_price: 0, line_total: 0},
      ]}),
    ];
    // itemized excludes the bundle line, so bundleRevenue lands on the bundle, not products.
    expect(bundleSalesSummary(orders)).toEqual({itemizedRevenue: 0, bundleRevenue: 570, bundleOrders: 1, totalRevenue: 570});
  });
});

describe('topBundles', () => {
  it('ranks bundles by revenue from bundle_id lines, ignoring product and voided lines', () => {
    const orders = [
      order({id: '1', created_at: NOW.toISOString(), total: 570, items: [
        {product_id: null, bundle_id: 'buy-any-4', name: 'Buy Any 4', qty: 1, unit_price: 570, line_total: 570},
        {product_id: 'A', name: 'A', qty: 1, unit_price: 0, line_total: 0},
      ]}),
      order({id: '2', created_at: NOW.toISOString(), total: 550, items: [
        {product_id: null, bundle_id: 'buy-any-2', name: 'Buy Any 2', qty: 1, unit_price: 550, line_total: 550},
      ]}),
      order({id: '3', created_at: NOW.toISOString(), total: 570, items: [
        {product_id: null, bundle_id: 'buy-any-4', name: 'Buy Any 4', qty: 1, unit_price: 570, line_total: 570},
      ]}),
      order({id: '4', created_at: NOW.toISOString(), total: 570, status: 'voided', items: [
        {product_id: null, bundle_id: 'buy-any-4', name: 'Buy Any 4', qty: 1, unit_price: 570, line_total: 570},
      ]}),
    ];
    expect(topBundles(orders)).toEqual([
      {bundle_id: 'buy-any-4', name: 'Buy Any 4', revenue: 1140, orders: 2},
      {bundle_id: 'buy-any-2', name: 'Buy Any 2', revenue: 550, orders: 1},
    ]);
  });

  it('is empty when no order has a bundle line (pre-fix / offline data)', () => {
    const orders = [
      order({id: '1', created_at: NOW.toISOString(), total: 850, items: [
        {product_id: 'CG', name: 'Cat Grass', qty: 5, unit_price: 170, line_total: 850},
      ]}),
    ];
    expect(topBundles(orders)).toEqual([]);
  });
});

describe('paginate', () => {
  it('derives clamped page + range indices', () => {
    expect(paginate(60, 1, 25)).toEqual({page: 1, pageSize: 25, totalPages: 3, from: 0, to: 24, total: 60});
    expect(paginate(60, 2, 25)).toEqual({page: 2, pageSize: 25, totalPages: 3, from: 25, to: 49, total: 60});
    expect(paginate(60, 3, 25)).toEqual({page: 3, pageSize: 25, totalPages: 3, from: 50, to: 74, total: 60});
  });
  it('clamps out-of-range pages into [1, totalPages]', () => {
    expect(paginate(60, 99, 25).page).toBe(3);
    expect(paginate(60, 0, 25).page).toBe(1);
    expect(paginate(60, -5, 25).page).toBe(1);
  });
  it('always has at least one page, even with zero rows', () => {
    expect(paginate(0, 1, 25)).toEqual({page: 1, pageSize: 25, totalPages: 1, from: 0, to: 24, total: 0});
  });
});

describe('parsePage', () => {
  it('parses positive integers, defaults to 1 otherwise', () => {
    expect(parsePage('3')).toBe(3);
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage('0')).toBe(1);
    expect(parsePage('-2')).toBe(1);
    expect(parsePage('abc')).toBe(1);
  });
});

describe('offlineChannelFacts', () => {
  it('builds a Website-shaped offline channel (no ROAS, no platform fee, ₱0 event cost, 0 buyers)', () => {
    const orders = [
      order({id: '1', created_at: NOW.toISOString(), total: 540}),
      order({id: '2', created_at: NOW.toISOString(), total: 300}),
    ];
    expect(offlineChannelFacts(orders)).toEqual({
      channel: 'offline',
      orders: 2,
      buyers: 0,
      revenue: 840,
      adSpend: null,
      adRevenue: null,
      platformFeeApplies: false,
      defaults: {cogsPct: 0.35, platformFeePct: 0, promos: 0, acqCost: 0},
    });
  });
  it('returns null when there are no orders', () => {
    expect(offlineChannelFacts([])).toBeNull();
  });
});

describe('offlineCompareMetrics', () => {
  it('builds compare-chart metrics with AOV, null adSpend/roas', () => {
    const orders = [
      order({id: '1', created_at: NOW.toISOString(), total: 400, items: [{product_id: 'A', name: 'A', qty: 2, unit_price: 200, line_total: 400}]}),
      order({id: '2', created_at: NOW.toISOString(), total: 200, items: [{product_id: 'B', name: 'B', qty: 1, unit_price: 200, line_total: 200}]}),
    ];
    expect(offlineCompareMetrics(orders)).toEqual({revenue: 600, orders: 2, aov: 300, units: 3, adSpend: null, roas: null});
  });
  it('returns null when there are no orders', () => {
    expect(offlineCompareMetrics([])).toBeNull();
  });
});

describe('stockAlerts', () => {
  const p = (over: Partial<PosProductRow> & {product_id: string; stock: number}): PosProductRow => ({
    name: over.product_id,
    product_line: 'FDR',
    category: 'Freeze Dried',
    subcategory: null,
    emoji: null,
    active: true,
    price: 170,
    next_expiry: null,
    ...over,
  });
  it('buckets out / low / near-expiry', () => {
    const products = [
      p({product_id: 'OUT', stock: 0}),
      p({product_id: 'LOW', stock: 5}),
      p({product_id: 'OK', stock: 50}),
      p({product_id: 'EXP', stock: 20, next_expiry: '2026-09-20'}), // within 30d of NOW
      p({product_id: 'FAR', stock: 20, next_expiry: '2027-01-01'}), // beyond
    ];
    const a = stockAlerts(products, NOW);
    expect(a.out.map((x) => x.product_id)).toEqual(['OUT']);
    expect(a.low.map((x) => x.product_id)).toEqual(['LOW']);
    expect(a.nearExpiry.map((x) => x.product_id)).toEqual(['EXP']);
  });
  it('does not flag an out-of-stock item as near-expiry', () => {
    const products = [p({product_id: 'OUT', stock: 0, next_expiry: '2026-09-10'})];
    const a = stockAlerts(products, NOW);
    expect(a.nearExpiry).toHaveLength(0);
    expect(a.out.map((x) => x.product_id)).toEqual(['OUT']);
  });
});

describe('parseOrdersFilter', () => {
  it('defaults unknown/blank params to no filter', () => {
    expect(parseOrdersFilter({})).toEqual({method: 'all', status: 'all', event: 'all', startDate: null, endDate: null, minPrice: null, maxPrice: null});
    expect(parseOrdersFilter({method: 'bitcoin', status: 'huh', from: 'never'})).toEqual({
      method: 'all',
      status: 'all',
      event: 'all',
      startDate: null,
      endDate: null,
      minPrice: null,
      maxPrice: null,
    });
  });
  it('keeps a valid method, status, date range, and prices', () => {
    expect(parseOrdersFilter({
      method: 'gcash',
      status: 'voided',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-09T23:59:59.999Z',
      min: '50',
      max: '500',
    })).toEqual({
      method: 'gcash',
      status: 'voided',
      event: 'all',
      startDate: '2026-09-01T00:00:00.000Z',
      endDate: '2026-09-09T23:59:59.999Z',
      minPrice: 50,
      maxPrice: 500,
    });
  });
  it('rejects malformed dates', () => {
    const f = parseOrdersFilter({from: 'not-a-date', to: 'nope'});
    expect(f.startDate).toBeNull();
    expect(f.endDate).toBeNull();
  });
  it('swaps a reversed instant range', () => {
    const f = parseOrdersFilter({from: '2026-09-09T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z'});
    expect(f.startDate).toBe('2026-09-01T00:00:00.000Z');
    expect(f.endDate).toBe('2026-09-09T00:00:00.000Z');
  });
  it('swaps a reversed price range', () => {
    const f = parseOrdersFilter({min: '500', max: '50'});
    expect(f.minPrice).toBe(50);
    expect(f.maxPrice).toBe(500);
  });
  it('ignores negative or non-numeric prices', () => {
    const f = parseOrdersFilter({min: '-10', max: 'abc'});
    expect(f.minPrice).toBeNull();
    expect(f.maxPrice).toBeNull();
  });
});

describe('isFilterActive', () => {
  it('is false only for the all-defaults filter', () => {
    expect(isFilterActive({method: 'all', status: 'all', event: 'all', startDate: null, endDate: null, minPrice: null, maxPrice: null})).toBe(false);
    expect(isFilterActive({method: 'cash', status: 'all', event: 'all', startDate: null, endDate: null, minPrice: null, maxPrice: null})).toBe(true);
    expect(isFilterActive({method: 'all', status: 'voided', event: 'all', startDate: null, endDate: null, minPrice: null, maxPrice: null})).toBe(true);
    expect(isFilterActive({method: 'all', status: 'all', event: 'all', startDate: '2026-09-01T00:00:00.000Z', endDate: null, minPrice: null, maxPrice: null})).toBe(true);
    expect(isFilterActive({method: 'all', status: 'all', event: 'all', startDate: null, endDate: null, minPrice: 20, maxPrice: null})).toBe(true);
    expect(isFilterActive({method: 'all', status: 'all', event: 'untagged', startDate: null, endDate: null, minPrice: null, maxPrice: null})).toBe(true);
  });
});

describe('filterOrders', () => {
  const orders = [
    order({id: 'cash', created_at: '2026-09-07T10:00:00.000Z', total: 100, payment_method: 'cash'}),
    order({id: 'gcash', created_at: '2026-09-06T10:00:00.000Z', total: 300, payment_method: 'gcash'}),
    order({id: 'legacy', created_at: '2026-08-01T10:00:00.000Z', total: 500, payment_method: null}),
    order({id: 'card', created_at: '2026-09-07T09:00:00.000Z', total: 900, payment_method: 'card'}),
  ];
  const base = {method: 'all', status: 'all', event: 'all', startDate: null, endDate: null, minPrice: null, maxPrice: null};

  it('matches cash including legacy null rows', () => {
    const ids = filterOrders(orders, {...base, method: 'cash'}).map((o) => o.id);
    expect(ids.sort()).toEqual(['cash', 'legacy']);
  });
  it('filters by status (voided only)', () => {
    const withVoid = [...orders, order({id: 'void', created_at: '2026-09-07T11:00:00.000Z', total: 200, status: 'voided'})];
    expect(filterOrders(withVoid, {...base, status: 'voided'}).map((o) => o.id)).toEqual(['void']);
    expect(filterOrders(withVoid, {...base, status: 'completed'}).map((o) => o.id).sort()).toEqual(['card', 'cash', 'gcash', 'legacy']);
  });
  it('filters by a specific method', () => {
    const ids = filterOrders(orders, {...base, method: 'card'}).map((o) => o.id);
    expect(ids).toEqual(['card']);
  });
  it('filters by price range (inclusive)', () => {
    const ids = filterOrders(orders, {...base, minPrice: 100, maxPrice: 500}).map((o) => o.id);
    expect(ids.sort()).toEqual(['cash', 'gcash', 'legacy']);
  });
  it('filters by an inclusive instant range', () => {
    const ids = filterOrders(orders, {
      ...base,
      startDate: '2026-09-06T00:00:00.000Z',
      endDate: '2026-09-07T23:59:59.999Z',
    }).map((o) => o.id);
    expect(ids.sort()).toEqual(['card', 'cash', 'gcash']);
    expect(ids).not.toContain('legacy');
  });
  it('includes an order at the end-of-day boundary', () => {
    const ids = filterOrders(orders, {
      ...base,
      startDate: '2026-09-07T00:00:00.000Z',
      endDate: '2026-09-07T23:59:59.999Z',
    }).map((o) => o.id);
    expect(ids.sort()).toEqual(['card', 'cash']);
  });
  it('combines filters (AND)', () => {
    const ids = filterOrders(orders, {...base, minPrice: 200, maxPrice: 400}).map((o) => o.id);
    expect(ids).toEqual(['gcash']);
  });
});

describe('event filter (Transactions)', () => {
  function evt(over: Partial<PosEvent> & {event_id: string}): PosEvent {
    return {
      name: over.event_id, venue: null, city: null, organizer: null,
      starts_on: null, ends_on: null, opening_cash: null, cash_note: null,
      closing_cash: null, status: 'active', created_by: null, created_at: null,
      updated_at: null, ...over,
    };
  }
  const day17 = '2026-09-17T04:00:00.000Z'; // Manila 2026-09-17

  it('parseOrdersFilter reads the event param (uuid / untagged / default all)', () => {
    expect(parseOrdersFilter({event: 'A'}).event).toBe('A');
    expect(parseOrdersFilter({event: 'untagged'}).event).toBe('untagged');
    expect(parseOrdersFilter({}).event).toBe('all');
    expect(parseOrdersFilter({event: '  '}).event).toBe('all');
  });

  it('filterOrders filters by event_id and by untagged', () => {
    const orders = [
      order({id: 'a1', created_at: day17, event_id: 'A'}),
      order({id: 'b1', created_at: day17, event_id: 'B'}),
      order({id: 'none', created_at: day17, event_id: null}),
    ];
    expect(filterOrders(orders, {...DEFAULT_ORDERS_FILTER, event: 'A'}).map((o) => o.id)).toEqual(['a1']);
    expect(filterOrders(orders, {...DEFAULT_ORDERS_FILTER, event: 'untagged'}).map((o) => o.id)).toEqual(['none']);
    expect(filterOrders(orders, {...DEFAULT_ORDERS_FILTER, event: 'all'}).map((o) => o.id)).toEqual(['a1', 'b1', 'none']);
  });

  it('eventFilterScope: todays live events by default, selected range when a date is set', () => {
    const events = [
      evt({event_id: 'live1', starts_on: '2026-09-17', ends_on: '2026-09-17'}),
      evt({event_id: 'live2', starts_on: '2026-09-17', ends_on: '2026-09-18'}),
      evt({event_id: 'past', starts_on: '2026-09-10', ends_on: '2026-09-10'}),
    ];
    // Default (no date filter): events covering today.
    expect(eventFilterScope(events, DEFAULT_ORDERS_FILTER, '2026-09-17').map((e) => e.event_id).sort())
      .toEqual(['live1', 'live2']);
    // A date range selected: events overlapping that range (by Manila day).
    const ranged = {...DEFAULT_ORDERS_FILTER, startDate: '2026-09-10T00:00:00.000Z', endDate: '2026-09-10T15:59:59.000Z'};
    expect(eventFilterScope(events, ranged, '2026-09-17').map((e) => e.event_id)).toEqual(['past']);
  });

  it('eventsCoveringOrder returns the events whose range covers the order day', () => {
    const events = [
      evt({event_id: 'A', starts_on: '2026-09-17', ends_on: '2026-09-17'}),
      evt({event_id: 'B', starts_on: '2026-09-17', ends_on: '2026-09-17'}),
      evt({event_id: 'other', starts_on: '2026-09-18', ends_on: '2026-09-18'}),
    ];
    expect(eventsCoveringOrder({created_at: day17}, events).map((e) => e.event_id).sort()).toEqual(['A', 'B']);
  });
});

describe('price bounds', () => {
  it('rounds the max up to a clean ceiling', () => {
    expect(boundsFromMax(6767)).toEqual({min: 0, max: 6800});
    expect(boundsFromMax(0)).toEqual({min: 0, max: 100});
    expect(boundsFromMax(100)).toEqual({min: 0, max: 100});
  });
  it('derives bounds from the highest order total', () => {
    expect(priceBounds([order({id: 'a', created_at: '2026-09-07T10:00:00.000Z', total: 250})])).toEqual({min: 0, max: 300});
  });
});

describe('petMix', () => {
  const at = '2026-09-07T10:00:00.000Z';
  it('splits revenue and orders 4 ways, untagged catching null', () => {
    const orders = [
      order({id: '1', created_at: at, total: 100, pet_type: 'dog'}),
      order({id: '2', created_at: at, total: 50, pet_type: 'dog'}),
      order({id: '3', created_at: at, total: 200, pet_type: 'cat'}),
      order({id: '4', created_at: at, total: 70, pet_type: 'both'}),
      order({id: '5', created_at: at, total: 30, pet_type: null}),
    ];
    expect(petMix(orders)).toEqual({
      dog: {revenue: 150, orders: 2},
      cat: {revenue: 200, orders: 1},
      both: {revenue: 70, orders: 1},
      untagged: {revenue: 30, orders: 1},
    });
  });
  it('excludes voided sales', () => {
    const orders = [
      order({id: '1', created_at: at, total: 100, pet_type: 'dog'}),
      order({id: '2', created_at: at, total: 999, pet_type: 'dog', status: 'voided'}),
    ];
    expect(petMix(orders).dog).toEqual({revenue: 100, orders: 1});
  });
  it('returns zeroed segments for no orders', () => {
    expect(petMix([])).toEqual({
      dog: {revenue: 0, orders: 0},
      cat: {revenue: 0, orders: 0},
      both: {revenue: 0, orders: 0},
      untagged: {revenue: 0, orders: 0},
    });
  });
});

describe('eventRollups', () => {
  const at = '2026-09-07T10:00:00.000Z';
  function event(over: Partial<PosEvent> & {event_id: string}): PosEvent {
    return {
      name: over.event_id, venue: null, city: null, organizer: null,
      starts_on: null, ends_on: null, opening_cash: null, cash_note: null,
      closing_cash: null, status: 'active', created_by: null, created_at: null,
      updated_at: null, ...over,
    };
  }
  it('rolls sales into their event, cash reconciliation from opening_cash', () => {
    const events = [event({event_id: 'e1', opening_cash: 500}), event({event_id: 'e2'})];
    const orders = [
      order({id: '1', created_at: at, total: 300, payment_method: 'cash', event_id: 'e1'}),
      order({id: '2', created_at: at, total: 200, payment_method: 'gcash', event_id: 'e1'}),
      order({id: '3', created_at: at, total: 999, payment_method: 'cash', event_id: 'e1', status: 'voided'}),
      order({id: '4', created_at: at, total: 50, payment_method: 'cash', event_id: null}), // non-event day
    ];
    const rolls = eventRollups(events, orders);
    expect(rolls[0]).toEqual({
      event: events[0], revenue: 500, orders: 2, cashSales: 300, expectedCash: 800,
    });
    // e2 has no sales; opening_cash null -> expectedCash null.
    expect(rolls[1]).toEqual({event: events[1], revenue: 0, orders: 0, cashSales: 0, expectedCash: null});
  });
  it('null payment_method counts as cash', () => {
    const events = [event({event_id: 'e1', opening_cash: 0})];
    const orders = [order({id: '1', created_at: at, total: 120, payment_method: null, event_id: 'e1'})];
    expect(eventRollups(events, orders)[0]).toMatchObject({cashSales: 120, expectedCash: 120});
  });
});

describe('effectiveEventId / resolveOrderEvents', () => {
  function event(over: Partial<PosEvent> & {event_id: string}): PosEvent {
    return {
      name: over.event_id, venue: null, city: null, organizer: null,
      starts_on: null, ends_on: null, opening_cash: null, cash_note: null,
      closing_cash: null, status: 'active', created_by: null, created_at: null,
      updated_at: null, ...over,
    };
  }
  // 2026-09-17 04:00Z = 2026-09-17 12:00 Manila; 2026-09-16 20:00Z = 2026-09-17 04:00 Manila.
  const day17 = '2026-09-17T04:00:00.000Z';
  const day18 = '2026-09-18T04:00:00.000Z';
  const day20 = '2026-09-20T04:00:00.000Z';
  const events = [event({event_id: 'e1', starts_on: '2026-09-17', ends_on: '2026-09-18'})];

  it('keeps a POS-stamped event_id untouched (authoritative)', () => {
    expect(effectiveEventId({event_id: 'ePOS', created_at: day20}, events)).toBe('ePOS');
  });
  it('attributes an untagged sale to the event covering its Manila date', () => {
    expect(effectiveEventId({event_id: null, created_at: day17}, events)).toBe('e1');
    expect(effectiveEventId({event_id: null, created_at: day18}, events)).toBe('e1');
  });
  it('leaves an untagged sale outside every event as a walk-in (null)', () => {
    expect(effectiveEventId({event_id: null, created_at: day20}, events)).toBeNull();
  });
  it('a single-bound event covers exactly that one day', () => {
    const oneDay = [event({event_id: 'e9', starts_on: '2026-09-18', ends_on: null})];
    expect(effectiveEventId({event_id: null, created_at: day18}, oneDay)).toBe('e9');
    expect(effectiveEventId({event_id: null, created_at: day17}, oneDay)).toBeNull();
  });
  it('the scenario: extending an event to cover day 1 folds in the day-1 sales', () => {
    // Day-1 (Sep 17) sale was logged untagged; the event now spans Sep 17-18.
    const orders = [
      order({id: '1', created_at: day17, event_id: null}), // day 1, was a "normal day"
      order({id: '2', created_at: day18, event_id: 'e1'}), // day 2, tagged live by the POS
      order({id: '3', created_at: day20, event_id: null}), // genuinely outside -> stays walk-in
    ];
    const resolved = resolveOrderEvents(orders, events);
    expect(resolved.map((o) => o.event_id)).toEqual(['e1', 'e1', null]);
    expect(resolved[1]).toBe(orders[1]); // unchanged orders keep their identity (no needless copy)
  });
  it('with no dated events, returns the input array as-is', () => {
    const orders = [order({id: '1', created_at: day17, event_id: null})];
    expect(resolveOrderEvents(orders, [event({event_id: 'x'})])).toBe(orders);
  });

  it('overlappingEvent flags a clashing range and excludes self when editing', () => {
    const existing = [event({event_id: 'a', name: 'Bazaar A', starts_on: '2026-09-17', ends_on: '2026-09-18'})];
    // A new range that intersects -> clash.
    expect(overlappingEvent(existing, '2026-09-18', '2026-09-19')?.event_id).toBe('a');
    // A range that abuts but does not intersect -> free.
    expect(overlappingEvent(existing, '2026-09-19', '2026-09-20')).toBeNull();
    // Editing event 'a' itself never clashes with itself.
    expect(overlappingEvent(existing, '2026-09-17', '2026-09-18', 'a')).toBeNull();
    // No dates proposed -> nothing to clash.
    expect(overlappingEvent(existing, null, null)).toBeNull();
    // Single-bound existing event counts as that one day.
    const oneDay = [event({event_id: 'b', starts_on: '2026-09-20', ends_on: null})];
    expect(overlappingEvent(oneDay, '2026-09-20', '2026-09-20')?.event_id).toBe('b');
    expect(overlappingEvent(oneDay, '2026-09-21', '2026-09-21')).toBeNull();
  });
});

describe('multi-event attribution, pinning, and untagged bucket', () => {
  function ev(over: Partial<PosEvent> & {event_id: string}): PosEvent {
    return {
      name: over.event_id, venue: null, city: null, organizer: null,
      starts_on: null, ends_on: null, opening_cash: null, cash_note: null,
      closing_cash: null, status: 'active', created_by: null, created_at: null,
      updated_at: null, ...over,
    };
  }
  const day17 = '2026-09-17T04:00:00.000Z'; // 2026-09-17 Manila
  const twoSameDay = [
    ev({event_id: 'a', starts_on: '2026-09-17', ends_on: '2026-09-17'}),
    ev({event_id: 'b', starts_on: '2026-09-17', ends_on: '2026-09-17'}),
  ];

  it('effectiveEventId does NOT guess when two events cover the day (stays null)', () => {
    expect(effectiveEventId({event_id: null, created_at: day17}, twoSameDay)).toBeNull();
  });
  it('effectiveEventId still auto-attributes on an unambiguous (single-event) day', () => {
    const one = [ev({event_id: 'a', starts_on: '2026-09-17', ends_on: '2026-09-17'})];
    expect(effectiveEventId({event_id: null, created_at: day17}, one)).toBe('a');
  });
  it('resolveOrderEvents leaves an ambiguous-day untagged sale untagged', () => {
    const orders = [order({id: '1', created_at: day17, event_id: null})];
    expect(resolveOrderEvents(orders, twoSameDay)[0].event_id).toBeNull();
  });

  it('currentEventIds returns every live event, newest start first', () => {
    const events = [
      ev({event_id: 'early', starts_on: '2026-09-15', ends_on: '2026-09-18'}),
      ev({event_id: 'late', starts_on: '2026-09-17', ends_on: '2026-09-17'}),
      ev({event_id: 'past', starts_on: '2026-09-10', ends_on: '2026-09-11'}),
    ];
    // Both 'early' and 'late' cover the 17th; the later-starting one sorts first.
    expect(currentEventIds(events, '2026-09-17')).toEqual(['late', 'early']);
    expect(currentEventIds(events, '2026-09-20')).toEqual([]);
  });

  it('untaggedOnEventDays collects only null-event sales on event-covered days', () => {
    const events = [ev({event_id: 'a', starts_on: '2026-09-17', ends_on: '2026-09-17'})];
    const orders = [
      order({id: 'onDayUntagged', created_at: day17, event_id: null}),       // counts
      order({id: 'onDayTagged', created_at: day17, event_id: 'a'}),          // tagged, skip
      order({id: 'offDay', created_at: '2026-09-20T04:00:00.000Z', event_id: null}), // walk-in, skip
      {...order({id: 'voided', created_at: day17, event_id: null}), status: 'voided'}, // voided, skip
    ];
    expect(untaggedOnEventDays(orders, events).map((o) => o.id)).toEqual(['onDayUntagged']);
  });
  it('untaggedOnEventDays returns nothing when there are no dated events', () => {
    expect(untaggedOnEventDays([order({id: '1', created_at: day17, event_id: null})], [])).toEqual([]);
  });
});

describe('featuredEvent', () => {
  function event(over: Partial<PosEvent> & {event_id: string}): PosEvent {
    return {
      name: over.event_id, venue: null, city: null, organizer: null,
      starts_on: null, ends_on: null, opening_cash: null, cash_note: null,
      closing_cash: null, status: 'active', created_by: null, created_at: null,
      updated_at: null, ...over,
    };
  }
  const TODAY = '2026-09-17';

  it('prefers the event running today (current), inclusive of both bounds', () => {
    const events = [
      event({event_id: 'past', starts_on: '2026-09-10', ends_on: '2026-09-12'}),
      event({event_id: 'now', starts_on: '2026-09-16', ends_on: '2026-09-18'}),
      event({event_id: 'future', starts_on: '2026-09-25', ends_on: '2026-09-26'}),
    ];
    expect(featuredEvent(events, TODAY)).toEqual({event: events[1], state: 'current'});
  });

  it('falls back to the nearest upcoming event when none is current', () => {
    const events = [
      event({event_id: 'soon', starts_on: '2026-09-20', ends_on: '2026-09-21'}),
      event({event_id: 'later', starts_on: '2026-10-01', ends_on: '2026-10-02'}),
      event({event_id: 'past', starts_on: '2026-09-01', ends_on: '2026-09-02'}),
    ];
    expect(featuredEvent(events, TODAY)).toEqual({event: events[0], state: 'upcoming'});
  });

  it('returns null when there is no current or upcoming event', () => {
    const events = [event({event_id: 'past', starts_on: '2026-09-01', ends_on: '2026-09-02'})];
    expect(featuredEvent(events, TODAY)).toBeNull();
  });

  it('ignores events with no dates', () => {
    const events = [event({event_id: 'undated'})];
    expect(featuredEvent(events, TODAY)).toBeNull();
  });
});

describe('event search / time / sort', () => {
  function event(over: Partial<PosEvent> & {event_id: string}): PosEvent {
    return {
      name: over.event_id, venue: null, city: null, organizer: null,
      starts_on: null, ends_on: null, opening_cash: null, cash_note: null,
      closing_cash: null, status: 'active', created_by: null, created_at: null,
      updated_at: null, ...over,
    };
  }
  function roll(over: Partial<PosEvent> & {event_id: string}, revenue = 0): EventRollup {
    return {event: event(over), revenue, orders: 0, cashSales: 0, expectedCash: null};
  }
  const TODAY = '2026-09-17';

  it('eventTimeState buckets by dates vs today (dateless = ongoing)', () => {
    expect(eventTimeState(event({event_id: 'a', starts_on: '2026-09-20', ends_on: '2026-09-21'}), TODAY)).toBe('upcoming');
    expect(eventTimeState(event({event_id: 'b', starts_on: '2026-09-16', ends_on: '2026-09-18'}), TODAY)).toBe('ongoing');
    expect(eventTimeState(event({event_id: 'c', starts_on: '2026-09-10', ends_on: '2026-09-12'}), TODAY)).toBe('past');
    expect(eventTimeState(event({event_id: 'd'}), TODAY)).toBe('ongoing');
  });

  it('eventMatchesQuery matches name/venue/city/organizer, case-insensitively', () => {
    const e = event({event_id: 'x', name: 'Creative Market', venue: 'Espacio', city: 'Makati', organizer: 'Circuit'});
    expect(eventMatchesQuery(e, 'creative')).toBe(true);
    expect(eventMatchesQuery(e, 'espac')).toBe(true);
    expect(eventMatchesQuery(e, 'makati')).toBe(true);
    expect(eventMatchesQuery(e, 'circuit')).toBe(true);
    expect(eventMatchesQuery(e, 'davao')).toBe(false);
    expect(eventMatchesQuery(e, '   ')).toBe(true); // blank matches all
  });

  it('filterAndSortEvents filters by query + when, then sorts', () => {
    const rolls = [
      roll({event_id: 'past', name: 'Old Fair', starts_on: '2026-09-10', ends_on: '2026-09-11'}, 500),
      roll({event_id: 'now', name: 'Live Bazaar', city: 'Makati', starts_on: '2026-09-16', ends_on: '2026-09-18'}, 300),
      roll({event_id: 'soon', name: 'Makati Pop-up', starts_on: '2026-09-25', ends_on: '2026-09-26'}, 900),
    ];
    // Recent = latest start first.
    expect(filterAndSortEvents(rolls, {query: '', when: 'all', sort: 'recent'}, TODAY).map((r) => r.event.event_id))
      .toEqual(['soon', 'now', 'past']);
    // Oldest reverses it.
    expect(filterAndSortEvents(rolls, {query: '', when: 'all', sort: 'oldest'}, TODAY).map((r) => r.event.event_id))
      .toEqual(['past', 'now', 'soon']);
    // Top revenue.
    expect(filterAndSortEvents(rolls, {query: '', when: 'all', sort: 'revenue'}, TODAY).map((r) => r.event.event_id))
      .toEqual(['soon', 'past', 'now']);
    // When = past only.
    expect(filterAndSortEvents(rolls, {query: '', when: 'past', sort: 'recent'}, TODAY).map((r) => r.event.event_id))
      .toEqual(['past']);
    // Query matches name or city (Makati → 'now' via city, 'soon' via name).
    expect(filterAndSortEvents(rolls, {query: 'makati', when: 'all', sort: 'recent'}, TODAY).map((r) => r.event.event_id))
      .toEqual(['soon', 'now']);
  });
});

describe('paymentBreakdown', () => {
  const at = '2026-09-07T10:00:00.000Z';
  it('sums revenue + orders per method, richest first, voided excluded', () => {
    const orders = [
      order({id: '1', created_at: at, total: 300, payment_method: 'cash'}),
      order({id: '2', created_at: at, total: 600, payment_method: 'gcash'}),
      order({id: '3', created_at: at, total: 200, payment_method: 'cash'}),
      order({id: '4', created_at: at, total: 999, payment_method: 'cash', status: 'voided'}),
    ];
    expect(paymentBreakdown(orders)).toEqual([
      {method: 'gcash', revenue: 600, orders: 1},
      {method: 'cash', revenue: 500, orders: 2},
    ]);
  });
});

describe('paymentMethodOptions', () => {
  const at = '2026-09-07T10:00:00.000Z';
  it('lists methods with sales first (enabled), then the rest greyed (disabled)', () => {
    const orders = [
      order({id: '1', created_at: at, payment_method: 'gcash'}),
      order({id: '2', created_at: at, payment_method: 'cash'}),
    ];
    const opts = paymentMethodOptions(orders);
    // enabled group in canonical order (cash before gcash), then disabled rest.
    expect(opts.filter((o) => o.enabled).map((o) => o.method)).toEqual(['cash', 'gcash']);
    expect(opts.filter((o) => !o.enabled).map((o) => o.method)).toEqual(['qrph', 'maya', 'card', 'bpi', 'bank_transfer']);
    // enabled all come before any disabled
    const firstDisabled = opts.findIndex((o) => !o.enabled);
    expect(opts.slice(0, firstDisabled).every((o) => o.enabled)).toBe(true);
  });
  it('marks everything disabled when there are no sales', () => {
    expect(paymentMethodOptions([]).every((o) => !o.enabled)).toBe(true);
  });
});

describe('datesInRange', () => {
  it('lists inclusive days for a multi-day range', () => {
    expect(datesInRange('2026-09-15', '2026-09-17')).toEqual(['2026-09-15', '2026-09-16', '2026-09-17']);
  });
  it('yields the single day when start equals end or only one bound is set', () => {
    expect(datesInRange('2026-09-15', '2026-09-15')).toEqual(['2026-09-15']);
    expect(datesInRange('2026-09-15', null)).toEqual(['2026-09-15']);
    expect(datesInRange(null, '2026-09-15')).toEqual(['2026-09-15']);
  });
  it('returns [] for a reversed or empty range', () => {
    expect(datesInRange('2026-09-17', '2026-09-15')).toEqual([]);
    expect(datesInRange(null, null)).toEqual([]);
  });
});

describe('eventRevenueSeries', () => {
  it('builds a cumulative series oldest-first, voided excluded', () => {
    const orders = [
      order({id: '2', created_at: '2026-09-07T11:00:00.000Z', total: 200}),
      order({id: '1', created_at: '2026-09-07T10:00:00.000Z', total: 300}),
      order({id: '3', created_at: '2026-09-07T12:00:00.000Z', total: 999, status: 'voided'}),
      order({id: '4', created_at: '2026-09-07T13:00:00.000Z', total: 100}),
    ];
    expect(eventRevenueSeries(orders)).toEqual([
      {t: '2026-09-07T10:00:00.000Z', revenue: 300},
      {t: '2026-09-07T11:00:00.000Z', revenue: 500},
      {t: '2026-09-07T13:00:00.000Z', revenue: 600},
    ]);
  });
  it('is empty when there are no (non-voided) orders', () => {
    expect(eventRevenueSeries([])).toEqual([]);
  });
});

describe('manilaMinuteOfDay', () => {
  it('converts a UTC instant to Manila (UTC+8) minutes since midnight', () => {
    expect(manilaMinuteOfDay('2026-09-11T02:00:00.000Z')).toBe(600); // 10:00 Manila
    expect(manilaMinuteOfDay('2026-09-11T06:00:00.000Z')).toBe(840); // 14:00 Manila
    expect(manilaMinuteOfDay('2026-09-10T16:00:00.000Z')).toBe(0); // Manila midnight
  });
});

describe('eventDayPacingSeries', () => {
  const orders = [
    // Sep 11 (Manila): 10:00 → 100, 12:00 → cumulative 150
    order({id: 'a', created_at: '2026-09-11T02:00:00.000Z', total: 100}),
    order({id: 'b', created_at: '2026-09-11T04:00:00.000Z', total: 50}),
    // Sep 12 (Manila): 10:00 → 200, 11:00 → 260 (resets, does not carry Sep 11)
    order({id: 'c', created_at: '2026-09-12T02:00:00.000Z', total: 200}),
    order({id: 'e', created_at: '2026-09-12T03:00:00.000Z', total: 60}),
    // voided Sep 12 sale is excluded
    order({id: 'd', created_at: '2026-09-12T05:00:00.000Z', total: 999, status: 'voided'}),
  ];

  it('gives each day an hourly running total, aligned by clock hour, resetting daily', () => {
    const {days, rows} = eventDayPacingSeries(orders);
    expect(days).toEqual(['2026-09-11', '2026-09-12']);
    // One row per clock-hour mark 10:00–12:00 (tod = hour*60). Each holds the total
    // BY that mark (inclusive); these sales all land exactly on the hour, so the
    // values match their marks. Sep 11 holds 100 at 11:00 (no 11:00 sale), Sep 12
    // is null at 12:00 (past its last sale mark of 11:00).
    expect(rows).toEqual([
      {tod: 600, '2026-09-11': 100, '2026-09-12': 200},
      {tod: 660, '2026-09-11': 100, '2026-09-12': 260},
      {tod: 720, '2026-09-11': 150, '2026-09-12': null},
    ]);
  });

  it('attributes an off-hour sale to the next clock mark, with a ₱0 baseline', () => {
    // A single 9:37 sale of 1,200 must read "₱0 by 9 AM, ₱1,200 by 10 AM" — not
    // ₱1,200 sitting on the 9 AM mark (the bug this guards against).
    const {days, rows} = eventDayPacingSeries([
      order({id: 'x', created_at: '2026-09-11T01:37:00.000Z', total: 1200}), // 09:37 Manila
    ]);
    expect(days).toEqual(['2026-09-11']);
    expect(rows).toEqual([
      {tod: 540, '2026-09-11': 0}, // 9 AM: nothing yet
      {tod: 600, '2026-09-11': 1200}, // 10 AM: the 9:37 sale so far
    ]);
  });

  it('spans a completed day across the full window: 0 before its first sale, total after its last', () => {
    // Sep 11 (completed, earlier day) sells 11:00 → 12:00; Sep 12 (latest) sells
    // 10:00 → 13:00 and defines the window. Sep 11 must read 0 at the 10 AM edge
    // (before its first sale) and hold its 150 total out to the 1 PM edge.
    const {rows} = eventDayPacingSeries([
      order({id: 'a', created_at: '2026-09-11T03:00:00.000Z', total: 100}), // 11:00
      order({id: 'b', created_at: '2026-09-11T04:00:00.000Z', total: 50}), // 12:00 → 150
      order({id: 'c', created_at: '2026-09-12T02:00:00.000Z', total: 200}), // 10:00
      order({id: 'd', created_at: '2026-09-12T05:00:00.000Z', total: 60}), // 13:00 → 260
    ]);
    expect(rows).toEqual([
      {tod: 600, '2026-09-11': 0, '2026-09-12': 200}, // 10 AM: Sep 11 baseline
      {tod: 660, '2026-09-11': 100, '2026-09-12': 200},
      {tod: 720, '2026-09-11': 150, '2026-09-12': 200},
      {tod: 780, '2026-09-11': 150, '2026-09-12': 260}, // 1 PM: Sep 11 holds its total
    ]);
  });

  it('never flat-lines the latest (maybe in-progress) day past its last sale', () => {
    // Sep 11 (completed) runs 10:00 → 13:00; Sep 12 (latest) stops at 11:00. Sep 12
    // must go null after 11:00 rather than holding its total, so it isn't drawn as
    // if it kept selling.
    const {rows} = eventDayPacingSeries([
      order({id: 'a', created_at: '2026-09-11T02:00:00.000Z', total: 100}), // 10:00
      order({id: 'b', created_at: '2026-09-11T05:00:00.000Z', total: 50}), // 13:00 → 150
      order({id: 'c', created_at: '2026-09-12T02:00:00.000Z', total: 200}), // 10:00
      order({id: 'd', created_at: '2026-09-12T03:00:00.000Z', total: 60}), // 11:00 → 260
    ]);
    expect(rows).toEqual([
      {tod: 600, '2026-09-11': 100, '2026-09-12': 200},
      {tod: 660, '2026-09-11': 100, '2026-09-12': 260},
      {tod: 720, '2026-09-11': 100, '2026-09-12': null}, // Sep 12 stops, Sep 11 continues
      {tod: 780, '2026-09-11': 150, '2026-09-12': null},
    ]);
  });

  it('is empty when there are no (non-voided) orders', () => {
    expect(eventDayPacingSeries([])).toEqual({days: [], rows: []});
  });
});
