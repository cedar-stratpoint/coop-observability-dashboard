-- coop_chat_boxme.sql: registry views over the BoxMe (online warehouse) feed for Ask Coop, role coop_chat_ro (plan
-- knowledge/tasks/2026-10-19-ask-coop-inventory-plan.md, B2). Owner: zoomy-observability-dashboard. Hand-applied after
-- coop_chat_readonly.sql (staging first). Re-runnable. Views only: the boxme_* tables are owned by zoomy-observability
-- (supabase/boxme_inventory.sql there), which must be applied first.
-- DEFINER views (like coop_chat_stock.sql): they read the RLS-protected boxme_* tables as their owner, so coop_chat_ro needs no
-- table grant. Explicit columns only. The sync-run view leaves out the error text and the API key expiry.
-- "Current" rows (the job never deletes) are picked in the app by buildBoxmeInventory, the same rule as the Inventory page.
create or replace view public.coop_chat_boxme_products as
  select seller_sku, name, active, sale_price, min_quantity, expiry_threshold, image_url from public.boxme_products;
create or replace view public.coop_chat_boxme_warehouses as
  select pickup_id, warehouse_code, pickup_name from public.boxme_warehouses;
create or replace view public.coop_chat_boxme_stock as
  select seller_sku, pickup_id, stock, awaiting, reserved, available, incoming, damaged_stock, damaged_available, synced_at from public.boxme_stock;
create or replace view public.coop_chat_boxme_stock_daily as
  select snapshot_date, seller_sku, pickup_id, stock, available from public.boxme_stock_daily;
create or replace view public.coop_chat_boxme_stock_lots as
  select seller_sku, warehouse_code, batch_lot, expire_date, quantity, synced_at from public.boxme_stock_lots;
create or replace view public.coop_chat_boxme_sync_runs as
  select id, started_at, finished_at, status, skus_seen, skus_written from public.boxme_sync_runs;
revoke all on public.coop_chat_boxme_products, public.coop_chat_boxme_warehouses, public.coop_chat_boxme_stock,
  public.coop_chat_boxme_stock_daily, public.coop_chat_boxme_stock_lots, public.coop_chat_boxme_sync_runs from public, anon, authenticated;
grant select on public.coop_chat_boxme_products, public.coop_chat_boxme_warehouses, public.coop_chat_boxme_stock,
  public.coop_chat_boxme_stock_daily, public.coop_chat_boxme_stock_lots, public.coop_chat_boxme_sync_runs to coop_chat_ro;
notify pgrst, 'reload schema';
