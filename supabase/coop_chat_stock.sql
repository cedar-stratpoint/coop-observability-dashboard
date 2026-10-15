-- coop_chat_stock.sql: registry views for the stock metrics stock_on_hand and stock_cover (Ask Coop Train 3), role coop_chat_ro.
-- Owner: zoomy-observability-dashboard. Hand-applied after coop_chat_readonly.sql (staging first). Re-runnable. No pos_* DDL: views only.
-- Prerequisites (zoomy-pos): pos_inventory_by_location (with location), pos_stock_movements, pos_settings.
create or replace view public.coop_chat_stock_by_location as
  select product_id, location, stock from public.pos_inventory_by_location;
create or replace view public.coop_chat_sale_movements as
  select id, product_id, delta, reason, created_at from public.pos_stock_movements where reason = 'sale';
create or replace view public.coop_chat_stock_config as
  select key, value from public.pos_settings where key = 'stock_forecast_config';
revoke all on public.coop_chat_stock_by_location, public.coop_chat_sale_movements, public.coop_chat_stock_config from public, anon, authenticated;
grant select on public.coop_chat_stock_by_location, public.coop_chat_sale_movements, public.coop_chat_stock_config to coop_chat_ro;
notify pgrst, 'reload schema';
