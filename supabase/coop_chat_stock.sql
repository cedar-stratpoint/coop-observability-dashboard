-- coop_chat_stock.sql: registry views for the stock metrics stock_on_hand and stock_cover (Ask Coop Train 3), role coop_chat_ro.
-- Owner: zoomy-observability-dashboard. Hand-applied after coop_chat_readonly.sql (staging first). Re-runnable. No pos_* DDL: views only.
-- Prerequisites (zoomy-pos): pos_products, pos_locations, pos_inventory_lots, pos_stock_movements, pos_settings.
--
-- coop_chat_stock_by_location reads the BASE tables, not zoomy-pos's pos_inventory_by_location. That view is security_invoker=on, and
-- a definer view over a security_invoker view still checks the CALLER's table privileges; coop_chat_ro has none, so the chat got
-- "permission denied for table pos_products" and every stock answer failed (2026-10-19, staging). The select below is a HAND-KEPT COPY
-- of that view's body (as read from staging on 2026-10-19): change it together with zoomy-pos. The first view is dropped and created
-- (its column type can differ from the older version, which create-or-replace refuses), inside one transaction: if anything fails,
-- nothing changes. A dependent view makes the drop fail, which is also safe.
begin;
drop view if exists public.coop_chat_stock_by_location;
create view public.coop_chat_stock_by_location as
  select p.product_id, loc.code as location, coalesce(sum(l.qty_on_hand) filter (where l.location = loc.code), 0::bigint) as stock
  from public.pos_products p
  cross join public.pos_locations loc
  left join public.pos_inventory_lots l on l.product_id = p.product_id
  group by p.product_id, loc.code;
create or replace view public.coop_chat_sale_movements as
  select id, product_id, delta, reason, created_at from public.pos_stock_movements where reason = 'sale';
create or replace view public.coop_chat_stock_config as
  select key, value from public.pos_settings where key = 'stock_forecast_config';
revoke all on public.coop_chat_stock_by_location, public.coop_chat_sale_movements, public.coop_chat_stock_config from public, anon, authenticated;
grant select on public.coop_chat_stock_by_location, public.coop_chat_sale_movements, public.coop_chat_stock_config to coop_chat_ro;
commit;
notify pgrst, 'reload schema';
