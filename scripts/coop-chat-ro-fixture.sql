-- LOCAL ONLY. Fixture that mimics the shared archive's pos_* tables and two zoomy-pos RPCs, for
-- scripts/coop-chat-ro-proof.mjs. Never apply to a hosted project. Re-runnable (drops and recreates).
drop view if exists public.coop_chat_orders, public.coop_chat_order_items, public.coop_chat_products, public.coop_chat_bundles,
  public.coop_chat_prices, public.coop_chat_price_changes, public.coop_chat_events;
drop function if exists public.fake_write_rpc();
drop function if exists public.fake_read_rpc();
drop table if exists public.pos_order_items, public.pos_orders, public.pos_products, public.pos_bundles,
  public.pos_prices, public.pos_price_changes, public.pos_events;

create table public.pos_orders (
  id bigint generated always as identity primary key,
  client_uuid uuid default gen_random_uuid(),
  subtotal numeric, discount numeric, total numeric,
  oversold boolean default false,
  device_id text, payment_method text, customer_handle text,
  status text default 'completed', remarks text,
  created_at timestamptz default now(), edited_at timestamptz,
  event_id text, pet_type text
);
create table public.pos_order_items (
  id bigint generated always as identity primary key,
  order_id bigint references public.pos_orders(id),
  product_id text, bundle_id text, bundle_group text,
  qty int, unit_price numeric, line_total numeric
);
create table public.pos_products (product_id text primary key, name text, product_line text, category text);
create table public.pos_bundles (bundle_id text primary key, name text, price numeric);
create table public.pos_prices (
  product_id text primary key, price numeric not null, currency text default 'PHP',
  updated_by text, updated_at timestamptz default now()
);
create table public.pos_price_changes (
  id bigint generated always as identity primary key,
  product_id text not null, old_price numeric, new_price numeric not null,
  reason text, changed_by text, device_id text, changed_at timestamptz default now()
);
create table public.pos_events (
  event_id text primary key, name text, venue text, city text, organizer text,
  starts_on date, ends_on date, opening_cash numeric, cash_note text, closing_cash numeric,
  status text default 'active', created_by text, created_at timestamptz default now(), updated_at timestamptz default now()
);

alter table public.pos_orders enable row level security;       -- no policies, like the real tables
alter table public.pos_order_items enable row level security;
alter table public.pos_products enable row level security;
alter table public.pos_bundles enable row level security;
alter table public.pos_prices enable row level security;
alter table public.pos_price_changes enable row level security;
alter table public.pos_events enable row level security;

insert into public.pos_products values
  ('P1','Chicken Jerky','jerky','treat'),('P2','Salmon Bites','bites','treat'),
  ('P3','Dental Chews','dental','treat'),('P4','Beef Strips','jerky','treat');
insert into public.pos_bundles values ('B1','Starter Box',499),('B2','Party Pack',899);

-- ~25 price rows (P1..P4 named, the rest synthetic), a few changes, 5 events. The staff, device and cash columns
-- carry values on purpose: the proof shows the views hide them.
insert into public.pos_prices (product_id, price, updated_by)
  select 'P' || n, 100 + n * 10, 'staff-' || n from generate_series(1, 25) n;
-- orphan price rows exist (added after the inserts, which they would violate) (P5..P25 have no product), so NOT VALID: enforced for new rows only. /inventory embeds products via this FK.
alter table public.pos_prices add constraint pos_prices_product_id_fkey foreign key (product_id) references public.pos_products(product_id) not valid;

insert into public.pos_price_changes (product_id, old_price, new_price, reason, changed_by, device_id, changed_at) values
  ('P1', 230, 250, 'supplier increase', 'staff-1', 'dev-1', '2026-09-15 02:00:00+00'),
  ('P2', null, 250, 'first price', 'staff-2', 'dev-2', '2026-09-01 02:00:00+00'),
  ('P3', 80, 75, 'promo', 'staff-3', 'dev-1', '2026-09-20 02:00:00+00'),
  ('P4', 110, 120, null, 'staff-1', 'dev-2', '2026-09-25 02:00:00+00');
insert into public.pos_events (event_id, name, venue, city, organizer, starts_on, ends_on, opening_cash, cash_note, closing_cash, status, created_by) values
  ('EV1', 'Pet Fair Manila', 'SMX Hall', 'Pasay', 'Pet Fair Org', '2026-09-12', '2026-09-13', 2000, 'float from safe', 7500, 'closed', 'staff-1'),
  ('EV2', 'Barkada Bazaar', 'Ayala Mall', 'Makati', 'Bazaar Co', '2026-09-26', '2026-09-27', 1500, null, null, 'active', 'staff-2'),
  ('EV3', 'Pawsome Weekend', 'Greenhills', 'San Juan', null, '2026-10-10', '2026-10-11', null, null, null, 'active', 'staff-1'),
  ('EV4', 'Dog Days', 'BGC Park', 'Taguig', 'Dog Days Inc', '2026-08-01', '2026-08-02', 1000, 'closed early', 4200, 'closed', 'staff-3'),
  ('EV5', 'Single Day Market', 'Quezon Circle', 'Quezon City', null, '2026-09-05', null, 500, null, 3100, 'closed', 'staff-2');

insert into public.pos_orders (subtotal,discount,total,oversold,device_id,payment_method,customer_handle,status,remarks,event_id,pet_type) values
  (500,0,500,false,'dev-1','cash','@maria','completed','birthday order','EV1','dog'),
  (250,25,225,false,'dev-1','gcash',null,'completed',null,'EV1','cat'),
  (899,0,899,false,'dev-2','card','@jun','completed','call first','EV2','dog'),
  (120,0,120,true,'dev-2','cash',null,'completed',null,null,'both'),
  (310,0,0,false,'dev-1','cash','@void','voided','customer left',null,'dog'),
  (75,0,75,false,'dev-2','gcash','@kim','completed',null,'EV2','cat');

insert into public.pos_order_items (order_id,product_id,bundle_id,bundle_group,qty,unit_price,line_total) values
  (1,'P1',null,null,2,250,500),
  (2,'P2',null,null,1,250,250),
  (3,null,'B2','g-3',1,899,899),
  (3,'P1',null,'g-3',1,0,0),
  (3,'P3',null,'g-3',2,0,0),
  (4,'P4',null,null,1,120,120),
  (5,'P1',null,null,1,310,310),
  (6,'P3',null,null,1,75,75),
  (1,null,'B1','g-1',1,0,0),
  (1,'P2',null,'g-1',1,0,0),
  (2,'P4',null,null,0,0,0),
  (6,'P2',null,null,0,0,0);

-- Mimic zoomy-pos RPCs. The write one is SECURITY DEFINER with the default PUBLIC execute (the risk).
create function public.fake_write_rpc() returns void
language sql security definer set search_path = public as $$
  insert into public.pos_orders (total, pet_type, customer_handle) values (1,'spike','@spike');
$$;
create function public.fake_read_rpc() returns bigint
language sql stable as $$ select count(*) from public.pos_orders $$;
