// The relations Ask Coop may read, per read mode. One allowlist, used by the
// runtime guard (guarded-fetch.ts), the client type and the tests.

export const CHAT_READ_MODES = ['ro_role', 'guarded_service'] as const;
export type ChatReadMode = (typeof CHAT_READ_MODES)[number];

/** Columns that identify a customer. They may never be selected or filtered on. */
export const FORBIDDEN_COLUMNS: readonly string[] = Object.freeze([
  'customer_handle',
  'remarks',
  'phone',
  'email',
  'instagram',
  'customer_name',
  'client_uuid',
  'device_id',
  // Staff and cash columns of the events, prices and price-change tables.
  'created_by',
  'updated_by',
  'changed_by',
  'opening_cash',
  'closing_cash',
  'cash_note',
  'organizer',
  // digest_archive.bundle holds the verbatim customer quotes behind a digest (never selected; see pii-and-secrets.md).
  'bundle',
]);

// ro_role: dashboard-owned definer views (created in F2, not yet present).
// guarded_service: base tables with explicit column lists that omit
// customer-level columns (edited_at is fine).
const ORDER_COLS = 'id,subtotal,discount,total,oversold,payment_method,status,created_at,edited_at,event_id,pet_type';
const ITEM_COLS = 'order_id,product_id,bundle_id,bundle_group,qty,unit_price,line_total';
// Events: no cash, organizer or created_by columns. Prices and price changes: no updated_by / changed_by / device_id.
const EVENT_COLS = 'event_id,name,venue,city,starts_on,ends_on,status,created_at';
const PRICE_COLS = 'product_id,price';
const PRICE_CHANGE_COLS = 'id,product_id,old_price,new_price,changed_at';
const STOCK_COLS = 'product_id,location,stock';
const SALE_MOVEMENT_COLS = 'id,product_id,delta,reason,created_at';
const STOCK_CONFIG_COLS = 'key,value';
const COLUMNS = Object.freeze({
  orders: ORDER_COLS,
  items: ITEM_COLS,
  products: 'product_id,name',
  bundles: 'bundle_id,name',
  events: EVENT_COLS,
  prices: PRICE_COLS,
  priceChanges: PRICE_CHANGE_COLS,
  stock: STOCK_COLS,
  saleMovements: SALE_MOVEMENT_COLS,
  stockConfig: STOCK_CONFIG_COLS,
});

export const CHAT_RELATIONS = Object.freeze({
  ro_role: Object.freeze({
    tables: Object.freeze({
      orders: 'coop_chat_orders',
      items: 'coop_chat_order_items',
      products: 'coop_chat_products',
      bundles: 'coop_chat_bundles',
      events: 'coop_chat_events',
      prices: 'coop_chat_prices',
      priceChanges: 'coop_chat_price_changes',
      stock: 'coop_chat_stock_by_location',
      saleMovements: 'coop_chat_sale_movements',
      stockConfig: 'coop_chat_stock_config',
    }),
    columns: COLUMNS,
  }),
  guarded_service: Object.freeze({
    tables: Object.freeze({
      orders: 'pos_orders',
      items: 'pos_order_items',
      products: 'pos_products',
      bundles: 'pos_bundles',
      events: 'pos_events',
      prices: 'pos_prices',
      priceChanges: 'pos_price_changes',
      stock: 'pos_inventory_by_location',
      saleMovements: 'pos_stock_movements',
      stockConfig: 'pos_settings',
    }),
    columns: COLUMNS,
  }),
});

/** Every relation name any mode may read (the client's `from` type). */
export type ChatRelation =
  | (typeof CHAT_RELATIONS)['ro_role']['tables'][keyof (typeof CHAT_RELATIONS)['ro_role']['tables']]
  | (typeof CHAT_RELATIONS)['guarded_service']['tables'][keyof (typeof CHAT_RELATIONS)['guarded_service']['tables']];

export interface ChatRelationMap {
  orders: string;
  items: string;
  products: string;
  bundles: string;
  events: string;
  prices: string;
  priceChanges: string;
  stock: string;
  saleMovements: string;
  stockConfig: string;
}

export interface ChatRelationSet {
  tables: ChatRelationMap;
  columns: ChatRelationMap;
  /** The names the guard allows for this mode. */
  allowed: readonly string[];
}

export function relationsForMode(mode: ChatReadMode): ChatRelationSet {
  const r = CHAT_RELATIONS[mode];
  return {tables: r.tables, columns: r.columns, allowed: Object.freeze(Object.values(r.tables))};
}

// The stored digests (F10). A separate, single-relation allowlist: the digest client may read this and nothing else, and
// only these columns. ro_role reads a dashboard-owned definer view (supabase/coop_chat_digest.sql) that has no `bundle`;
// guarded_service reads digest_archive with the same explicit column list (the guard refuses `bundle` and `*`).
export const DIGEST_COLUMNS = 'window_from,window_to,digest,created_at';

/** The window index (spec F.5): a narrow read of every stored window, no JSON. */
export const DIGEST_INDEX_COLUMNS = 'window_from,window_to,created_at';

export const DIGEST_RELATIONS = Object.freeze({
  ro_role: 'coop_chat_digest',
  guarded_service: 'digest_archive',
} as const);

export type ChatDigestRelation = (typeof DIGEST_RELATIONS)[ChatReadMode];

export function digestRelationForMode(mode: ChatReadMode): ChatDigestRelation {
  return DIGEST_RELATIONS[mode];
}
