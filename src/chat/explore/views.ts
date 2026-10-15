// The Explore views: the single TypeScript source of truth for the relation allowlist (parse.ts), the catalog, the
// SQL checks (g) values list and the tests. Pure data, no imports. Spec 2.2 and 2.5.
// `columns` = verified (named in a select(...) list or typed interface in this repo); `optionalColumns` = known only from
// scripts/coop-chat-ro-fixture.sql, kept if the base table has them (the checks SQL reports a missing one as a NOTICE).
// `types` is the Postgres type family of every column (informational, for the catalog; `?` is never used here).
// Open by default: any other base column is exposed too by supabase/coop_chat_explore.sql and shows up in the checks "drift" query.
export const EXPLORE_VIEWS = {
  coop_explore_orders: {
    source: 'pos_orders',
    grain: 'one row per sale',
    columns: ['id', 'client_uuid', 'subtotal', 'discount', 'total', 'oversold', 'device_id', 'payment_method', 'customer_handle', 'status', 'remarks', 'created_at', 'edited_at', 'event_id', 'pet_type'],
    optionalColumns: [],
    types: {id: 'bigint', client_uuid: 'uuid', subtotal: 'numeric', discount: 'numeric', total: 'numeric', oversold: 'boolean', device_id: 'text', payment_method: 'text', customer_handle: 'text', status: 'text', remarks: 'text', created_at: 'timestamptz', edited_at: 'timestamptz', event_id: 'text', pet_type: 'text'},
  },
  coop_explore_order_items: {
    source: 'pos_order_items',
    grain: 'one row per order line (bundle header lines and bundle pick lines included)',
    columns: ['id', 'order_id', 'product_id', 'bundle_id', 'bundle_group', 'qty', 'unit_price', 'line_total'],
    optionalColumns: [],
    types: {id: 'bigint', order_id: 'bigint', product_id: 'text', bundle_id: 'text', bundle_group: 'text', qty: 'integer', unit_price: 'numeric', line_total: 'numeric'},
  },
  coop_explore_products: {
    source: 'pos_products',
    grain: 'one row per product',
    columns: ['product_id', 'name', 'product_line', 'category', 'subcategory', 'emoji', 'active'],
    optionalColumns: [],
    types: {product_id: 'text', name: 'text', product_line: 'text', category: 'text', subcategory: 'text', emoji: 'text', active: 'boolean'},
  },
  coop_explore_bundles: {
    source: 'pos_bundles',
    grain: 'one row per bundle',
    columns: ['bundle_id', 'name', 'price', 'active', 'bundle_type', 'pick_count', 'line_categories', 'emoji'],
    optionalColumns: [],
    types: {bundle_id: 'text', name: 'text', price: 'numeric', active: 'boolean', bundle_type: 'text', pick_count: 'integer', line_categories: 'text[]', emoji: 'text'},
  },
  coop_explore_bundle_items: {
    source: 'pos_bundle_items',
    grain: 'one row per product inside a fixed bundle',
    columns: ['id', 'bundle_id', 'product_id', 'qty'],
    optionalColumns: [],
    types: {id: 'bigint', bundle_id: 'text', product_id: 'text', qty: 'integer'},
  },
  coop_explore_events: {
    source: 'pos_events',
    grain: 'one row per event',
    columns: ['event_id', 'name', 'venue', 'city', 'organizer', 'starts_on', 'ends_on', 'opening_cash', 'cash_note', 'closing_cash', 'status', 'created_by', 'created_at', 'updated_at'],
    optionalColumns: [],
    types: {event_id: 'text', name: 'text', venue: 'text', city: 'text', organizer: 'text', starts_on: 'date', ends_on: 'date', opening_cash: 'numeric', cash_note: 'text', closing_cash: 'numeric', status: 'text', created_by: 'text', created_at: 'timestamptz', updated_at: 'timestamptz'},
  },
  coop_explore_prices: {
    source: 'pos_prices',
    grain: 'one row per product (current price)',
    columns: ['product_id', 'price'],
    optionalColumns: ['currency', 'updated_by', 'updated_at'],
    types: {product_id: 'text', price: 'numeric', currency: 'text', updated_by: 'text', updated_at: 'timestamptz'},
  },
  coop_explore_price_changes: {
    source: 'pos_price_changes',
    grain: 'one row per price change',
    columns: ['id', 'product_id', 'old_price', 'new_price', 'changed_at'],
    optionalColumns: ['reason', 'changed_by', 'device_id'],
    types: {id: 'bigint', product_id: 'text', old_price: 'numeric', new_price: 'numeric', changed_at: 'timestamptz', reason: 'text', changed_by: 'text', device_id: 'text'},
  },
  coop_explore_event_leads: {
    source: 'spin_wheel_leads',
    grain: 'one row per booth sign-up (spin-the-wheel lead)',
    columns: ['lead_id', 'email', 'mobile', 'prize', 'campaign', 'collected_at', 'consent_at', 'created_at', 'instagram', 'pet'],
    optionalColumns: [],
    types: {lead_id: 'uuid', email: 'text', mobile: 'text', prize: 'text', campaign: 'text', collected_at: 'timestamptz', consent_at: 'timestamptz', created_at: 'timestamptz', instagram: 'text', pet: 'text'},
  },
  coop_explore_digest: {
    source: 'digest_archive',
    grain: 'one row per stored digest run (windows vary: weekly or about a month)',
    columns: ['id', 'window_from', 'window_to', 'bundle', 'digest', 'created_at'],
    optionalColumns: [],
    types: {id: 'uuid', window_from: 'timestamptz', window_to: 'timestamptz', bundle: 'jsonb', digest: 'jsonb', created_at: 'timestamptz'},
  },
  coop_explore_inventory: {
    source: 'pos_inventory',
    grain: 'one row per product (stock on hand, all locations)',
    columns: ['product_id', 'stock', 'next_expiry'],
    optionalColumns: [],
    types: {product_id: 'text', stock: 'integer', next_expiry: 'date'},
  },
  coop_explore_inventory_by_location: {
    source: 'pos_inventory_by_location',
    grain: 'one row per product per location',
    columns: ['product_id', 'location', 'stock'],
    optionalColumns: [],
    types: {product_id: 'text', location: 'text', stock: 'integer'},
  },
  coop_explore_inventory_lots: {
    source: 'pos_inventory_lots',
    grain: 'one row per stock lot at one location',
    columns: ['lot_id', 'product_id', 'location', 'lot_code', 'expires_on', 'qty_received', 'qty_on_hand', 'received_at', 'updated_at'],
    optionalColumns: [],
    types: {lot_id: 'uuid', product_id: 'text', location: 'text', lot_code: 'text', expires_on: 'date', qty_received: 'integer', qty_on_hand: 'integer', received_at: 'timestamptz', updated_at: 'timestamptz'},
  },
  coop_explore_stock_movements: {
    source: 'pos_stock_movements',
    grain: 'one row per stock movement (signed delta)',
    columns: ['id', 'product_id', 'delta', 'reason', 'created_by', 'created_at'],
    optionalColumns: ['lot_id', 'location', 'order_id'],
    types: {id: 'bigint', product_id: 'text', delta: 'integer', reason: 'text', created_by: 'text', created_at: 'timestamptz', lot_id: 'uuid', location: 'text', order_id: 'bigint'},
  },
  coop_explore_stock_event: {
    source: 'pos_inventory_by_location',
    grain: 'one row per product: sellable stock at the event location',
    columns: ['product_id', 'stock'],
    optionalColumns: [],
    types: {product_id: 'text', stock: 'integer'},
  },
} as const;

export type ExploreViewName = keyof typeof EXPLORE_VIEWS;
export const EXPLORE_VIEW_NAMES = Object.keys(EXPLORE_VIEWS) as ExploreViewName[];

/** A Train 1 alias view's base table, or the name itself. The coop_explore_* views stay as aliases until a later PR drops them. */
export const baseRelation = (name: string): string =>
  Object.prototype.hasOwnProperty.call(EXPLORE_VIEWS, name) ? EXPLORE_VIEWS[name as ExploreViewName].source : name;
