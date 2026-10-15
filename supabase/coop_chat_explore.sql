-- coop_chat_explore.sql
-- Owner: zoomy-observability-dashboard (Ask Coop, Explore mode: one model-written, read-only SELECT).
-- Applied BY HAND in the archive project's SQL editor: staging first, then PROD by the co-worker. Never by a script against a hosted project.
-- Idempotent: safe to re-run. Run supabase/coop_chat_explore_checks.sql afterwards (it is SELECT-only and safe on PROD).
-- Design: knowledge/architecture/2026-10-05-ask-coop-explore-spec.md (sections 2 and 5). Not touched: the coop_chat_ro role, the seven
-- coop_chat_* views, the PostgREST pre-request hook (supabase/coop_chat_readonly.sql), and any pos_* DDL (owned by zoomy-pos).
--
-- PREREQUISITES (the file fails loudly if one is missing):
--   supabase/spin_wheel_leads.sql and supabase/spin_wheel_leads_instagram.sql applied (the leads view reads instagram and pet).
--   The zoomy-pos stock sources: pos_inventory, pos_inventory_by_location (WITH a `location` column), pos_inventory_lots and
--   pos_stock_movements. None is confirmed on staging or PROD yet. Before applying, run these read-only checks and read the result:
--     select table_name, column_name, data_type, ordinal_position from information_schema.columns
--       where table_schema = 'public' and table_name in ('pos_inventory','pos_inventory_by_location','pos_inventory_lots','pos_stock_movements')
--       order by table_name, ordinal_position;                       -- all 4 tables present; by_location has `location`
--     select distinct location from pos_inventory_by_location;      -- expect 'event' (sellable) and 'office'
--   If one is missing the file stops in step 0 below, naming it, before changing anything.
--
-- WHAT THIS DOES
--   1. a LOGIN role `coop_explore_ro` (no password here), the first Postgres credential the dashboard holds;
--   2. fifteen DEFINER views `coop_explore_*` (no security_invoker), one per business table, built by a generator that reads the base
--      table's columns AT APPLY TIME. Open by default: every column is exposed EXCEPT those whose NAME matches
--      password|token|secret|key|pin|hash|credential (case-insensitive substring, fails closed). A column added to a base table later
--      stays hidden until a person re-applies this file. The resulting column list per view is printed with RAISE NOTICE;
--   3. grants: SELECT on the fifteen views to the role and nothing else; REVOKE ALL from PUBLIC, anon, authenticated (these views carry
--      contact data and PostgREST would otherwise expose them: Supabase default privileges grant new public objects to those roles).
--
-- AFTER APPLYING, ONCE, in the SQL editor and NEVER in this file (a login role with no password cannot connect by password):
--   alter role coop_explore_ro with password '<random 32+ characters>';
-- The password goes only into EXPLORE_DATABASE_URL (Vercel env, server-only). Through the Supabase pooler the login is
-- coop_explore_ro.<project-ref>. Role-level settings below are defence in depth only: whether they reach a pooled session is
-- UNVERIFIED (spec U1), so the executor sets everything again per transaction (BEGIN READ ONLY + SET LOCAL ...).
-- CONNECTION LIMIT 10: 3 users, a pooler may hold several server connections; it is also a hard ceiling for an abuse event.

-- 0. Prerequisites ----------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  if to_regclass('public.spin_wheel_leads') is null then
    raise exception 'apply supabase/spin_wheel_leads.sql first';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'spin_wheel_leads' and column_name = 'instagram') then
    raise exception 'apply supabase/spin_wheel_leads_instagram.sql first';
  end if;
  foreach t in array array['pos_inventory', 'pos_inventory_by_location', 'pos_inventory_lots', 'pos_stock_movements'] loop
    if to_regclass('public.' || t) is null then
      raise exception 'missing stock source public.% (owned by zoomy-pos): run the read-only checks in this file''s header, then apply nothing until it exists', t;
    end if;
  end loop;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'pos_inventory_by_location' and column_name = 'location') then
    raise exception 'public.pos_inventory_by_location has no location column: coop_explore_stock_event cannot be built';
  end if;
end $$;

-- 1. Role -------------------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'coop_explore_ro') then
    create role coop_explore_ro login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 10;
  end if;
end $$;
-- Only the attributes a non-superuser (the SQL editor role) may change. SUPERUSER, REPLICATION and BYPASSRLS clauses are NOT repeated here:
-- Postgres refuses them in ALTER ROLE unless you are a superuser, even when the value is unchanged. CREATE ROLE above already sets
-- all of them to NO*, and coop_chat_explore_checks.sql query (d) proves it.
alter role coop_explore_ro nocreatedb nocreaterole noinherit connection limit 10;
alter role coop_explore_ro set default_transaction_read_only = on;
alter role coop_explore_ro set statement_timeout = '5s';
alter role coop_explore_ro set lock_timeout = '2s';
alter role coop_explore_ro set idle_in_transaction_session_timeout = '10s';
alter role coop_explore_ro set search_path = public;
alter role coop_explore_ro set timezone = 'Asia/Manila';

-- 2. Views and grants (the generator) ---------------------------------------------------------------------------
-- The blocked-name pattern appears here once. src/chat/explore/types.ts has the same string (EXPLORE_BLOCKED_COLUMN_RE);
-- test/chat-explore-views.test.ts fails if the two differ. The view list is views.ts (same order, same names).
do $$
declare
  blocked_re constant text := 'password|token|secret|key|pin|hash|credential';
  pairs constant text[] := array[
    'coop_explore_orders',         'pos_orders',
    'coop_explore_order_items',    'pos_order_items',
    'coop_explore_products',       'pos_products',
    'coop_explore_bundles',        'pos_bundles',
    'coop_explore_bundle_items',   'pos_bundle_items',
    'coop_explore_events',         'pos_events',
    'coop_explore_prices',         'pos_prices',
    'coop_explore_price_changes',  'pos_price_changes',
    'coop_explore_event_leads',    'spin_wheel_leads',
    'coop_explore_digest',         'digest_archive',
    'coop_explore_inventory',             'pos_inventory',
    'coop_explore_inventory_by_location', 'pos_inventory_by_location',
    'coop_explore_inventory_lots',        'pos_inventory_lots',
    'coop_explore_stock_movements',       'pos_stock_movements'
  ];
  i int;
  vname text;
  src text;
  cols text;
  dropped text;
begin
  for i in 1 .. array_length(pairs, 1) by 2 loop
    vname := pairs[i];
    src := pairs[i + 1];
    select string_agg(format('%I', c.column_name), ', ' order by c.ordinal_position)
      into cols
      from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = src and c.column_name !~* blocked_re;
    select string_agg(c.column_name, ', ' order by c.ordinal_position)
      into dropped
      from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = src and c.column_name ~* blocked_re;
    if cols is null then
      raise exception 'source table public.% is missing or has no exposable column (view % not built)', src, vname;
    end if;
    execute format('drop view if exists public.%I', vname);
    execute format('create view public.%I as select %s from public.%I', vname, cols, src);
    execute format('revoke all on public.%I from public, anon, authenticated', vname);
    execute format('grant select on public.%I to coop_explore_ro', vname);
    raise notice '% <- %: % | dropped by name pattern: %', vname, src, cols, coalesce(dropped, '(none)');
  end loop;
end $$;

-- Default view (spec 2.4/F.3): sellable stock = the event location. Raw stock stays readable in the views above.
drop view if exists public.coop_explore_stock_event;
create view public.coop_explore_stock_event as select product_id, stock from public.pos_inventory_by_location where location = 'event';
revoke all on public.coop_explore_stock_event from public, anon, authenticated;
grant select on public.coop_explore_stock_event to coop_explore_ro;

revoke all on schema public from coop_explore_ro;
grant usage on schema public to coop_explore_ro;

-- Deliberately NOT here: any grant on a base table, membership in another role, a sequence or function grant, and
-- `notify pgrst, 'reload schema'` (the role cannot use PostgREST). The zoomy-pos SECURITY DEFINER write RPCs that PUBLIC may
-- execute are a known residual risk: the parser's function allowlist and the per-transaction READ ONLY setting cover them
-- (see coop_chat_explore_checks.sql query f). Do NOT revoke them here: pos_* DDL is owned by zoomy-pos.
