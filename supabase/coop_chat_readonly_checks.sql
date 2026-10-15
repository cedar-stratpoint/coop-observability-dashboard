-- coop_chat_readonly_checks.sql
-- READ-ONLY audit queries (selects only) for the coop_chat_ro role. Safe on PROD. Paste into the SQL editor.
-- Each query says what a bad result means.

-- (a) Functions in public that coop_chat_ro can execute (default EXECUTE-to-PUBLIC makes most of them callable).
-- BAD: any row with is_security_definer = true that can write. RELEASE CHECK: zero SECURITY DEFINER functions
-- callable by the role, OR the hook (coop_chat_pre_request) installed (see query c). coop_chat_pre_request itself is
-- a security invoker function and is expected here.
select p.oid::regprocedure as function, p.prosecdef as is_security_definer, p.provolatile as volatility
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and has_function_privilege('coop_chat_ro', p.oid, 'execute')
order by p.prosecdef desc, 1::text;

-- (b) Every table/view privilege held by coop_chat_ro on any non-system relation.
-- EXPECTED: exactly ten rows, all SELECT: coop_chat_orders, coop_chat_order_items, coop_chat_products, coop_chat_bundles,
-- coop_chat_prices, coop_chat_price_changes, coop_chat_events, coop_chat_stock_by_location, coop_chat_sale_movements,
-- coop_chat_stock_config (the last three from supabase/coop_chat_stock.sql; apply it first).
-- BAD: any other relation, or any privilege other than SELECT.
select table_schema, table_name, privilege_type
from information_schema.role_table_grants
where grantee = 'coop_chat_ro'
order by table_schema, table_name, privilege_type;

-- (c) Does authenticator have a pre-request setting?
-- EXPECTED after applying: pgrst.db_pre_request=public.coop_chat_pre_request. BAD: a different function (the
-- coop_chat_readonly.sql DO block skipped it; merge the read-only lines by hand) or no row while query (a) shows
-- SECURITY DEFINER functions callable by the role.
select r.rolname, c as setting
from pg_db_role_setting s
join pg_roles r on r.oid = s.setrole
cross join unnest(s.setconfig) c
where r.rolname = 'authenticator' and c like 'pgrst.db_pre_request=%';

-- (d) Can the role log in? EXPECTED: rolcanlogin = false, rolinherit = false, rolsuper = false, rolbypassrls = false.
-- BAD: any true. It must be reachable only through PostgREST's SET ROLE.
select rolname, rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
from pg_roles where rolname = 'coop_chat_ro';

-- (e) Views and their column lists vs the contract (compare by eye; each row's "matches" must be true).
-- BAD: a missing view, extra columns, any customer column (customer_handle, remarks, phone, email, instagram,
-- customer_name, client_uuid, device_id, created_by, updated_by, changed_by, opening_cash, closing_cash, cash_note,
-- organizer), or a view with security_invoker set (it would then show zero rows).
with contract(view_name, cols) as (values
  ('coop_chat_orders',      'id,subtotal,discount,total,oversold,payment_method,status,created_at,edited_at,event_id,pet_type'),
  ('coop_chat_order_items', 'id,order_id,product_id,bundle_id,bundle_group,qty,unit_price,line_total'),
  ('coop_chat_products',    'product_id,name'),
  ('coop_chat_bundles',     'bundle_id,name'),
  ('coop_chat_prices',        'product_id,price'),
  ('coop_chat_price_changes', 'id,product_id,old_price,new_price,changed_at'),
  ('coop_chat_events',        'event_id,name,venue,city,starts_on,ends_on,status,created_at'),
  ('coop_chat_stock_by_location', 'product_id,location,stock'),
  ('coop_chat_sale_movements',    'id,product_id,delta,reason,created_at'),
  ('coop_chat_stock_config',      'key,value')
), actual as (
  select c.relname as view_name,
         string_agg(a.attname, ',' order by a.attnum) as cols,
         coalesce(c.reloptions::text, '') as reloptions
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  where c.relkind = 'v' and c.relname like 'coop\_chat\_%'
  group by c.relname, c.reloptions
)
select k.view_name, a.cols as actual_columns, a.reloptions,
       (a.cols is not null and a.cols = k.cols and a.reloptions not like '%security_invoker%') as matches
from contract k left join actual a using (view_name)
order by k.view_name;
