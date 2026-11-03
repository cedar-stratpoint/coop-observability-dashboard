// Shapes for Phase 5 Offline (POS) reporting. An order plus its line items,
// with product names resolved from pos_products.

export type SalesRange = 'today' | '7d' | '30d' | 'all';

/** The pet a sale was tagged for at the POS. null on an order = untagged. */
export type PetType = 'dog' | 'cat' | 'both';

export interface PosOrderLine {
  product_id: string | null; // SKU; null for a bundle header line
  bundle_id?: string | null; // set on a bundle header line (product_id is then null)
  bundle_group?: string | null; // ties a bundle's header + its ₱0 pick lines into one instance
  name: string; // resolved product or bundle name, or the raw id if unknown
  qty: number;
  unit_price: number;
  line_total: number;
}

export interface PosOrder {
  id: string;
  client_uuid: string; // idempotency key; passed to void_pos_order when voiding here
  subtotal: number;
  discount: number | null;
  total: number;
  oversold: boolean;
  device_id: string | null;
  payment_method: string | null; // 'cash' | 'gcash' | 'card' | ...; null = legacy/cash
  customer_handle: string | null; // optional furbaby / IG handle from the POS sale
  status: string; // 'completed' | 'voided'; voided sales are excluded from revenue
  remarks: string | null; // free-text note set from the POS
  created_at: string; // ISO
  edited_at: string | null; // ISO; set when the order was edited (null = never)
  event_id: string | null; // POS event this sale belongs to; null = a normal non-event day
  pet_type: PetType | null; // pet the sale was tagged for; null = untagged
  items: PosOrderLine[];
}

/**
 * A bazaar / market event the POS ran, from pos_events. Sales made during the
 * event carry its event_id. opening_cash + cash sales during the event reconciles
 * against the counted closing_cash when the event is closed.
 */
export interface PosEvent {
  event_id: string;
  name: string | null;
  venue: string | null;
  city: string | null;
  organizer: string | null;
  starts_on: string | null; // YYYY-MM-DD
  ends_on: string | null; // YYYY-MM-DD
  opening_cash: number | null; // float cash on hand at open
  cash_note: string | null;
  closing_cash: number | null; // counted cash at close (set by close_pos_event)
  status: string; // 'active' | 'closed'
  created_by: string | null;
  created_at: string | null; // ISO
  updated_at: string | null; // ISO
}

/** Slim catalog entry for the edit-order product picker. */
export interface PosCatalogItem {
  product_id: string;
  name: string;
  price: number | null;
  category: string | null; // POS display tab; used to filter a bundle's eligible picks
}

/** One editable entry on an order: an individual product line, or a bundle group
 *  (its price + picked products; picks are empty for a fixed bundle). Sent to
 *  edit_pos_order and reconstructed from an order's stored lines. */
export type EditEntry =
  | {kind: 'item'; product_id: string; qty: number; unit_price: number}
  | {kind: 'bundle'; bundle_id: string; price: number; picks: {product_id: string; qty: number}[]};

/** Slim bundle definition for the edit-order editor (rules + fixed components). */
export interface PosBundleDef {
  bundle_id: string;
  name: string;
  price: number;
  bundle_type: 'pick' | 'fixed';
  pick_count: number | null; // exact number of picks a 'pick' bundle needs
  line_categories: string[] | null; // eligible product categories for picks
  items: {product_id: string; name: string; qty: number}[]; // fixed bundle components
}

/** Active filters for the transactions list. `all`/null values mean no filter. */
export interface PosOrdersFilter {
  method: string; // 'all' | 'cash' | 'gcash' | 'maya' | 'card' | ...
  status: string; // 'all' | 'completed' | 'voided'
  event: string; // 'all' | an event_id | 'untagged' (null event_id). Only surfaced when a day has 2+ events.
  // Inclusive from/to instants (ISO). The client converts the picked calendar
  // days into absolute instants using the viewer's timezone (start-of-day →
  // end-of-day), so the filter matches the local times shown in the list.
  startDate: string | null;
  endDate: string | null;
  minPrice: number | null;
  maxPrice: number | null;
}

/** Inclusive slider bounds for the price filter, derived from the whole dataset. */
export interface PriceBounds {
  min: number;
  max: number;
}

export interface PosSyncEntry {
  synced_at: string; // ISO
  direction: string; // push / pull
  entity: string; // order / price / catalog / inventory
  summary: Record<string, unknown> | null;
  device_id: string | null;
}

export interface SalesKpis {
  revenue: number;
  orders: number;
  units: number;
  oversells: number;
}

/** Revenue + order count for one pet-mix segment. */
export interface PetMixSegment {
  revenue: number;
  orders: number;
}

/** The 4-way split of sales by tagged pet. `untagged` collects null pet_type. */
export interface PetMix {
  dog: PetMixSegment;
  cat: PetMixSegment;
  both: PetMixSegment;
  untagged: PetMixSegment;
}

/**
 * One event with its sales rollup. `cashSales` is the sum of non-voided
 * cash-method order totals during the event; `expectedCash` is opening_cash +
 * cashSales (null when opening_cash wasn't recorded), i.e. what the till should
 * hold at close before counting closing_cash.
 */
export interface EventRollup {
  event: PosEvent;
  revenue: number; // Σ non-voided order totals for the event
  orders: number; // non-voided order count
  cashSales: number; // Σ non-voided cash-method order totals
  expectedCash: number | null; // opening_cash + cashSales, or null
}

/** The single event to spotlight on the Offline Sales home: the one running
 *  today ('current'), else the nearest future one ('upcoming'). */
export interface FeaturedEvent {
  event: PosEvent;
  state: 'current' | 'upcoming';
}

export interface DailySales {
  day: string; // YYYY-MM-DD
  revenue: number;
  orders: number;
}

/** Revenue for one Manila day split by payment method, for the stacked chart. */
export interface DayMethodRevenue {
  day: string; // YYYY-MM-DD (Asia/Manila)
  byMethod: Record<string, number>; // method key -> revenue that day
}

export interface TopProduct {
  product_id: string;
  name: string;
  revenue: number; // itemized only: Σ line_total (bundle picks are ₱0, so excluded)
  units: number; // Σ qty, INCLUDING bundle-picked units
  bundledUnits: number; // of `units`, how many came from ₱0 (bundle-pick) lines
}

/** A bundle ranked by revenue, from bundle_id order lines (post write-path fix). */
export interface TopBundle {
  bundle_id: string;
  name: string;
  revenue: number; // Σ line_total on this bundle's lines
  orders: number; // number of bundle lines (one per bundle sold)
}

/**
 * Reconciles per-product (itemized) revenue with the Revenue KPI. Bundle deals
 * are recorded as ₱0 component lines with the bundle price only on the order
 * header, so `itemizedRevenue` (what Top products sums) is short of the KPI by
 * `bundleRevenue`. By construction: itemizedRevenue + bundleRevenue = totalRevenue.
 */
export interface BundleSalesSummary {
  itemizedRevenue: number; // Σ line_total across product lines
  bundleRevenue: number; // total - itemized: bundle money not attributed to any product
  bundleOrders: number; // orders carrying a bundle deal (order.total exceeds its line sum)
  totalRevenue: number; // = itemizedRevenue + bundleRevenue = Revenue KPI
}
