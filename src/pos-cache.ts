// Shared cache tags + window for the pos_* data readers. The heavy readers are
// wrapped in unstable_cache so repeat navigations and Next's link prefetches serve
// cached data instead of re-querying Supabase every time (the pages are dynamic).
// Every write action revalidates the relevant tag so a Coop edit shows immediately;
// POS-originated writes (new sales, POS stock/event edits) heal within the window.

export const POS_TAGS = {
  orders: 'pos-orders', // pos_orders / pos_order_items / sale movements
  catalog: 'pos-catalog', // pos_products / pos_prices / pos_inventory / pos_bundles
  events: 'pos-events', // pos_events
  boxme: 'boxme-stock', // boxme_* (written daily by zoomy-observability's boxme-sync job)
} as const;

// Seconds a cached read may be stale before a background refresh. Short, so the
// worst case for anything a write-tag misses is still small.
export const POS_CACHE_REVALIDATE = 30;
