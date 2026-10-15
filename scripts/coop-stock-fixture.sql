-- LOCAL FIXTURE ONLY: stock and settings for the registry stock views and Explore. Never apply to a hosted project. Re-runnable.
-- F.3 stock (LOCAL FIXTURE ONLY; zoomy-pos owns the real DDL). Shapes follow knowledge/data-catalog/tables.md.
-- Expected: sellable at event P1 = 12, P2 = 0; all locations P1 = 72, P2 = 25.
create table if not exists public.pos_locations (code text primary key);
insert into public.pos_locations (code) values ('event'), ('office') on conflict do nothing;

create table if not exists public.pos_inventory_lots (
  lot_id uuid primary key default gen_random_uuid(), product_id text not null, location text not null references public.pos_locations(code),
  lot_code text not null, expires_on date, qty_received integer not null, qty_on_hand integer not null,
  received_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.pos_stock_movements (
  id bigserial primary key, product_id text not null, delta integer not null, reason text not null, created_by text,
  created_at timestamptz not null default now(), lot_id uuid, location text, order_id bigint
);
create or replace view public.pos_inventory_by_location as
  select product_id, location, sum(qty_on_hand)::integer as stock from public.pos_inventory_lots group by product_id, location;
create or replace view public.pos_inventory as
  select product_id, sum(qty_on_hand)::integer as stock, min(expires_on) filter (where qty_on_hand > 0) as next_expiry
  from public.pos_inventory_lots group by product_id;

delete from public.pos_inventory_lots where lot_code like 'FX-%';
insert into public.pos_inventory_lots (product_id, location, lot_code, expires_on, qty_received, qty_on_hand) values
  ('P1', 'event',  'FX-1', '2026-12-31', 40, 12),   -- sellable 12
  ('P1', 'office', 'FX-2', '2027-03-31', 60, 60),   -- trap: back stock, not sellable
  ('P2', 'event',  'FX-3', '2026-11-30', 10, 0),    -- trap: empty lot, P2 sellable = 0
  ('P2', 'office', 'FX-4', '2027-01-31', 25, 25);
-- Dates are relative to now() so the 60-day forecast window and the 30-day G30 window never expire (the P1 and P2 sales are on different days).
delete from public.pos_stock_movements where created_by = 'fixture@example.com';
insert into public.pos_stock_movements (product_id, delta, reason, created_by, created_at, location) values
  ('P1', -28, 'sale',     'fixture@example.com', now() - interval '8 days', 'event'),
  ('P2', -10, 'sale',     'fixture@example.com', now() - interval '7 days', 'event'),
  ('P1',  40, 'receipt',  'fixture@example.com', now() - interval '40 days', 'event'),
  ('P2',   2, 'add-void', 'fixture@example.com', now() - interval '6 days', 'event');

-- pos_settings: the reviewed exception pos_settings.key (moved here by Task 8)
create table if not exists public.pos_settings (key text primary key, value jsonb, updated_at timestamptz default now());
insert into public.pos_settings (key, value) values
  ('stock_forecast_config', '{"threshold": 5, "target_cover_events": 6, "lead_time_days": 3, "early_warning_events": 3}')
on conflict (key) do update set value = excluded.value;
