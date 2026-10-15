-- Goldline supply planning: warehouse stock, lead times and warehouse → store shipments,
-- behind the combined Inventory board ("ship by", "arrives", "produce by").
--
-- The real figures (units in the warehouse, how long production takes per line, how
-- long a delivery takes per store) aren't gathered yet, so this seeds SAMPLE values,
-- flagged `is_sample`, that are editable in Coop. Replace them as real data arrives.
--
-- Additive only: new gl_* tables + a nullable-default column on gl_products. RLS on,
-- no policies, revoked from the API roles — service-role only, like every gl_* table.
-- Staging first.

-- Company-wide defaults (used where a line / store has no value of its own).
create table if not exists public.gl_supply_settings (
  company_id              text primary key references public.companies(id) on delete cascade,
  default_production_days integer not null default 30 check (default_production_days between 0 and 365),
  default_transit_days    integer not null default 3  check (default_transit_days between 0 and 60),
  is_sample               boolean not null default true,
  updated_by              text,
  updated_at              timestamptz not null default now()
);

-- How long production takes, per product line ("gano katagal gumawa ng lipstick").
create table if not exists public.gl_line_lead_times (
  company_id      text not null references public.companies(id) on delete cascade,
  product_line    text not null,
  production_days integer not null check (production_days between 0 and 365),
  is_sample       boolean not null default true,
  updated_by      text,
  updated_at      timestamptz not null default now(),
  primary key (company_id, product_line)
);

-- How long a delivery takes from the warehouse, per store ("gano katagal umabot sa Cubao").
create table if not exists public.gl_store_transit (
  company_id   text not null references public.companies(id) on delete cascade,
  store_code   text not null,
  transit_days integer not null check (transit_days between 0 and 60),
  is_sample    boolean not null default true,
  updated_by   text,
  updated_at   timestamptz not null default now(),
  primary key (company_id, store_code)
);

-- Units in the warehouse, per item ("ilan pa ung nasa warehouse").
create table if not exists public.gl_warehouse_stock (
  company_id text not null references public.companies(id) on delete cascade,
  item_code  text not null,
  on_hand    integer not null default 0 check (on_hand >= 0),
  is_sample  boolean not null default true,
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (company_id, item_code)
);

-- Warehouse → store sends. In transit until the store's next count covers the arrival
-- date (that count's "Delivery" column records it); cancelling returns the units.
create table if not exists public.gl_shipments (
  id           uuid primary key default gen_random_uuid(),
  company_id   text not null references public.companies(id) on delete cascade,
  store_code   text not null,
  item_code    text not null,
  qty          integer not null check (qty > 0),
  shipped_on   date not null,
  arrives_on   date not null,
  status       text not null default 'in_transit' check (status in ('in_transit', 'cancelled')),
  created_by   text,
  created_at   timestamptz not null default now(),
  cancelled_by text,
  cancelled_at timestamptz,
  constraint gl_shipments_dates check (arrives_on >= shipped_on)
);
create index if not exists gl_shipments_company_idx on public.gl_shipments (company_id, status, store_code, item_code);

-- Catalog price changes (who changed what, when).
create table if not exists public.gl_price_changes (
  id         bigserial primary key,
  company_id text not null references public.companies(id) on delete cascade,
  item_code  text not null,
  old_price  numeric,
  new_price  numeric not null check (new_price >= 0),
  changed_by text,
  changed_at timestamptz not null default now()
);
create index if not exists gl_price_changes_item_idx on public.gl_price_changes (company_id, item_code, changed_at desc);

-- Hide a product from the inventory board / forecast (like Zoomy's Unlist). Additive.
alter table public.gl_products add column if not exists hidden boolean not null default false;

do $$
declare t text;
begin
  foreach t in array array['gl_supply_settings','gl_line_lead_times','gl_store_transit','gl_warehouse_stock','gl_shipments','gl_price_changes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke all on sequence public.gl_price_changes_id_seq from anon, authenticated;

-- Record a shipment atomically: lock the warehouse row, refuse more than is there,
-- take the units out, and log the send with its arrival date (store transit days, else
-- the company default). Returns the shipment id.
create or replace function public.gl_record_shipment(
  p_company text, p_store text, p_item text, p_qty integer, p_by text, p_today date default current_date
) returns uuid
language plpgsql security invoker set search_path = public
as $$
declare
  v_on_hand integer;
  v_days    integer;
  v_id      uuid;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'bad_qty' using errcode = 'P0001'; end if;
  select on_hand into v_on_hand from gl_warehouse_stock where company_id = p_company and item_code = p_item for update;
  if v_on_hand is null or v_on_hand < p_qty then raise exception 'not_enough_stock:%', coalesce(v_on_hand, 0) using errcode = 'P0001'; end if;
  select coalesce(
    (select transit_days from gl_store_transit where company_id = p_company and store_code = p_store),
    (select default_transit_days from gl_supply_settings where company_id = p_company),
    3) into v_days;
  update gl_warehouse_stock set on_hand = on_hand - p_qty, updated_by = p_by, updated_at = now()
   where company_id = p_company and item_code = p_item;
  insert into gl_shipments (company_id, store_code, item_code, qty, shipped_on, arrives_on, created_by)
  values (p_company, p_store, p_item, p_qty, p_today, p_today + v_days, p_by)
  returning id into v_id;
  return v_id;
end;
$$;

-- Cancel an in-transit shipment and put its units back in the warehouse — only before
-- it's due to arrive (after that the units are likely at the store; the next count
-- settles it, and cancelling would put stock back in the warehouse that isn't there).
drop function if exists public.gl_cancel_shipment(text, uuid, text);
create or replace function public.gl_cancel_shipment(p_company text, p_id uuid, p_by text, p_today date default current_date)
returns void
language plpgsql security invoker set search_path = public
as $$
declare
  v_item text;
  v_qty  integer;
  v_arr  date;
begin
  select arrives_on into v_arr from gl_shipments where id = p_id and company_id = p_company and status = 'in_transit' for update;
  if v_arr is null then raise exception 'not_in_transit' using errcode = 'P0001'; end if;
  if v_arr <= p_today then raise exception 'already_arrived' using errcode = 'P0001'; end if;
  update gl_shipments set status = 'cancelled', cancelled_by = p_by, cancelled_at = now()
   where id = p_id and company_id = p_company and status = 'in_transit'
  returning item_code, qty into v_item, v_qty;
  insert into gl_warehouse_stock (company_id, item_code, on_hand, updated_by)
  values (p_company, v_item, v_qty, p_by)
  on conflict (company_id, item_code) do update set on_hand = gl_warehouse_stock.on_hand + excluded.on_hand, updated_by = p_by, updated_at = now();
end;
$$;

-- Change a catalog price and log it, in one step.
create or replace function public.gl_set_price(p_company text, p_item text, p_price numeric, p_by text)
returns void
language plpgsql security invoker set search_path = public
as $$
declare v_old numeric;
begin
  if p_price is null or p_price < 0 then raise exception 'bad_price' using errcode = 'P0001'; end if;
  select unit_price into v_old from gl_products where company_id = p_company and item_code = p_item for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  if v_old is not distinct from p_price then return; end if; -- unchanged: nothing to log
  update gl_products set unit_price = p_price where company_id = p_company and item_code = p_item;
  insert into gl_price_changes (company_id, item_code, old_price, new_price, changed_by) values (p_company, p_item, v_old, p_price, p_by);
end;
$$;

revoke all on function public.gl_record_shipment(text, text, text, integer, text, date) from public, anon, authenticated;
revoke all on function public.gl_cancel_shipment(text, uuid, text, date) from public, anon, authenticated;
revoke all on function public.gl_set_price(text, text, numeric, text) from public, anon, authenticated;
grant execute on function public.gl_record_shipment(text, text, text, integer, text, date) to service_role;
grant execute on function public.gl_cancel_shipment(text, uuid, text, date) to service_role;
grant execute on function public.gl_set_price(text, text, numeric, text) to service_role;

-- ---------------------------------------------------------------------------------
-- SAMPLE seed for Goldline (is_sample = true). Safe to re-run: never overwrites a value
-- someone has edited (on conflict do nothing).
insert into public.gl_supply_settings (company_id, default_production_days, default_transit_days)
select 'goldline', 30, 3 where exists (select 1 from public.companies where id = 'goldline')
on conflict (company_id) do nothing;

-- Production: lip products ~30 days, lashes/accessories (sourced) ~45, the rest ~21.
insert into public.gl_line_lead_times (company_id, product_line, production_days)
select distinct 'goldline', product_line,
  case when product_line ~* '\m(lip|lips|lipstick|pout)\M' then 30
       when product_line ~* '\m(lash|lashes|accessories)\M' then 45
       else 21 end
from public.gl_products where company_id = 'goldline' and product_line is not null
on conflict (company_id, product_line) do nothing;

-- Transit: Metro Manila 2 days, Visayas 6, Mindanao 8, else 4.
insert into public.gl_store_transit (company_id, store_code, transit_days)
select 'goldline', store_code,
  case when region = 'NCR' then 2 when region = 'Visayas' then 6 when region = 'Mindanao' then 8 else 4 end
from public.gl_stores where company_id = 'goldline'
on conflict (company_id, store_code) do nothing;

-- Warehouse: a deterministic spread (0–399) per item, a few at zero so "short" shows up.
insert into public.gl_warehouse_stock (company_id, item_code, on_hand)
select 'goldline', item_code,
  case when abs(hashtext(item_code)::bigint) % 17 = 0 then 0 else abs(hashtext(item_code)::bigint) % 400 end
from public.gl_products where company_id = 'goldline'
on conflict (company_id, item_code) do nothing;
