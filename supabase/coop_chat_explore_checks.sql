-- coop_chat_explore_checks.sql
-- READ-ONLY audit queries (selects only, plus one DO block that only RAISEs NOTICEs). Safe on PROD. Paste into the SQL editor after
-- applying supabase/coop_chat_explore.sql. Each query states its expected result. Spec: 2026-10-05-ask-coop-explore-spec.md 2.4.
-- TRAIN 1 STATE ONLY: before supabase/coop_chat_explore_direct.sql, or after supabase/coop_chat_explore_direct_rollback.sql (then
-- re-run supabase/coop_chat_explore.sql first). While the direct reads are applied, run supabase/coop_chat_explore_direct_checks.sql
-- INSTEAD: there (b), (c) and (d) below read BAD by design (the login reads every open table, with BYPASSRLS).

-- (a) A4. Any column of any coop_explore_* view whose NAME matches the blocked pattern.
-- EXPECTED: 0 rows. BAD: any row (the generator did not drop it; do not use the role until fixed).
select c.relname as view_name, a.attname as column_name
from pg_class c
join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
where c.relkind = 'v' and c.relname like 'coop\_explore\_%'
  and a.attname ~* 'password|token|secret|key|pin|hash|credential'
order by 1, 2;

-- (b) Privileges on the fifteen views, from the relation ACLs.
-- EXPECTED: exactly fifteen rows, grantee coop_explore_ro, privilege SELECT; and NO row for PUBLIC, anon or authenticated.
-- BAD: any other grantee or privilege (PostgREST would expose contact data to anon/authenticated).
select c.relname as view_name,
       case a.grantee when 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
       a.privilege_type
from pg_class c
join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
where c.relkind = 'v' and c.relname like 'coop\_explore\_%'
  and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('coop_explore_ro', 'anon', 'authenticated'))
order by 1, 2, 3;

-- (c) Any privilege the role holds on a relation in public OTHER than SELECT on the fifteen views.
-- EXPECTED: 0 rows. BAD: any row (a base table, another view, or a write privilege on an explore view).
select c.relname as relation, c.relkind,
       has_table_privilege('coop_explore_ro', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as any_table_privilege,
       has_any_column_privilege('coop_explore_ro', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES') as any_column_privilege,
       has_table_privilege('coop_explore_ro', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as any_write_privilege
from pg_class c
join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
where c.relkind in ('r', 'v', 'm', 'p', 'f')
  and (
    (c.relname not like 'coop\_explore\_%' and (has_table_privilege('coop_explore_ro', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege('coop_explore_ro', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')))
    or (c.relname like 'coop\_explore\_%' and has_table_privilege('coop_explore_ro', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
  )
order by 1;

-- (d) Role attributes. EXPECTED: rolcanlogin true; rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls all
-- false; rolconnlimit = 10. BAD: anything else. (BYPASSRLS true is the direct-read state: the direct checks (a) own that expectation,
-- and the rollback sets NOBYPASSRLS again.)
select rolname, rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolconnlimit
from pg_roles where rolname = 'coop_explore_ro';

-- (d2) Roles the role is a member of. EXPECTED: 0 rows. BAD: any row (it would inherit or SET ROLE into that role).
select pg_get_userbyid(m.roleid) as member_of, m.admin_option
from pg_auth_members m
where m.member = (select oid from pg_roles where rolname = 'coop_explore_ro');

-- (d3) Has the role a password? (a boolean only, never the value). pg_authid needs a superuser; where the SQL editor role cannot read
-- it, this prints a notice instead. EXPECTED after the person set one: true.
do $$
declare has_pw boolean;
begin
  select rolpassword is not null into has_pw from pg_authid where rolname = 'coop_explore_ro';
  raise notice 'coop_explore_ro has a password: %', has_pw;
exception when insufficient_privilege then
  raise notice 'cannot read pg_authid here (not a superuser); check by logging in as the role instead';
end $$;

-- (e) Schema privileges. EXPECTED: can_create false everywhere; can_use true for public, pg_catalog, information_schema.
-- A schema with can_use true and flag = 'REVIEW' is not a failure by itself, but a person should know why it is reachable
-- (PUBLIC USAGE on a schema grants nothing without table privileges).
select n.nspname as schema,
       has_schema_privilege('coop_explore_ro', n.oid, 'USAGE') as can_use,
       has_schema_privilege('coop_explore_ro', n.oid, 'CREATE') as can_create,
       case when has_schema_privilege('coop_explore_ro', n.oid, 'CREATE') then 'BAD'
            when has_schema_privilege('coop_explore_ro', n.oid, 'USAGE') and n.nspname not in ('public', 'pg_catalog', 'information_schema') then 'REVIEW'
            else 'ok' end as flag
from pg_namespace n
where n.nspname !~ '^pg_toast' and n.nspname !~ '^pg_temp'
order by flag desc, 1;

-- (f) SECURITY DEFINER functions in public the role can execute. INFORMATIONAL (a known residual risk, spec 2.4 f and 5.4): zoomy-pos
-- write RPCs are PUBLIC-executable by default. They are blocked by the parser function allowlist, the role default read-only
-- setting (UNVERIFIED through a pooler) and, for writes nested in a SELECT, the READ ONLY transaction. Do NOT add revokes here:
-- pos_* DDL is owned by zoomy-pos (lesson audit-before-revoking-foreign-grants.md).
select p.oid::regprocedure as function, p.prosecdef as is_security_definer, p.provolatile as volatility
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
  and has_function_privilege('coop_explore_ro', p.oid, 'execute')
order by 1::text;

-- (g) View contract vs src/chat/explore/views.ts. The values list is views.ts (verified columns, then fixture-only optional columns).
-- EXPECTED: every row matches = true (no verified column is missing), has_security_invoker = false, owner is not the role.
-- missing_optional is a NOTICE (a column known only from the local fixture; the base table may not have it).
-- extra_columns = base columns not in views.ts (open by default): not a failure, but a person should document them in the catalog.
with contract(view_name, cols, optional_cols) as (values
  ('coop_explore_orders',        'id,client_uuid,subtotal,discount,total,oversold,device_id,payment_method,customer_handle,status,remarks,created_at,edited_at,event_id,pet_type', ''),
  ('coop_explore_order_items',   'id,order_id,product_id,bundle_id,bundle_group,qty,unit_price,line_total', ''),
  ('coop_explore_products',      'product_id,name,product_line,category,subcategory,emoji,active', ''),
  ('coop_explore_bundles',       'bundle_id,name,price,active,bundle_type,pick_count,line_categories,emoji', ''),
  ('coop_explore_bundle_items',  'id,bundle_id,product_id,qty', ''),
  ('coop_explore_events',        'event_id,name,venue,city,organizer,starts_on,ends_on,opening_cash,cash_note,closing_cash,status,created_by,created_at,updated_at', ''),
  ('coop_explore_prices',        'product_id,price', 'currency,updated_by,updated_at'),
  ('coop_explore_price_changes', 'id,product_id,old_price,new_price,changed_at', 'reason,changed_by,device_id'),
  ('coop_explore_event_leads',   'lead_id,email,mobile,prize,campaign,collected_at,consent_at,created_at,instagram,pet', ''),
  ('coop_explore_digest',        'id,window_from,window_to,bundle,digest,created_at', ''),
  ('coop_explore_inventory',     'product_id,stock,next_expiry', ''),
  ('coop_explore_inventory_by_location', 'product_id,location,stock', ''),
  ('coop_explore_inventory_lots', 'lot_id,product_id,location,lot_code,expires_on,qty_received,qty_on_hand,received_at,updated_at', ''),
  ('coop_explore_stock_movements', 'id,product_id,delta,reason,created_by,created_at', 'lot_id,location,order_id'),
  ('coop_explore_stock_event',    'product_id,stock', '')
), actual as (
  select c.relname as view_name,
         array_agg(a.attname::text order by a.attnum) as cols,
         coalesce(c.reloptions::text, '') as reloptions,
         pg_get_userbyid(c.relowner) as owner
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  where c.relkind = 'v' and c.relname like 'coop\_explore\_%'
  group by c.relname, c.reloptions, c.relowner
)
select k.view_name,
       act.view_name is not null as view_exists,
       coalesce(array(select x from unnest(string_to_array(k.cols, ',')) x where not (x = any (act.cols))), '{}') as missing_verified,
       coalesce(array(select x from unnest(string_to_array(nullif(k.optional_cols, ''), ',')) x where not (x = any (act.cols))), '{}') as missing_optional,
       coalesce(array(select x from unnest(act.cols) x where not (x = any (string_to_array(k.cols || ',' || k.optional_cols, ',')))), '{}') as extra_columns,
       act.view_name is not null and not exists (select 1 from unnest(string_to_array(k.cols, ',')) x where not (x = any (act.cols))) as matches,
       coalesce(act.reloptions like '%security_invoker%', false) as has_security_invoker,
       act.owner,
       act.owner = 'coop_explore_ro' as owner_is_role
from contract k
left join actual act on act.view_name = k.view_name
order by 1;

-- (h) (coop_explore_stock_event is left out: it hides the location column on purpose, it is a filter not a pass-through.)
-- (h) Drift: base-table columns that are neither exposed nor blocked by the name pattern (a column added after this file was applied).
-- EXPECTED: 0 rows. A row means: re-apply supabase/coop_chat_explore.sql (the view does not show the column yet), then document it.
select s.view_name, bc.column_name as base_column_not_in_view
from (values
  ('coop_explore_orders', 'pos_orders'), ('coop_explore_order_items', 'pos_order_items'), ('coop_explore_products', 'pos_products'),
  ('coop_explore_bundles', 'pos_bundles'), ('coop_explore_bundle_items', 'pos_bundle_items'), ('coop_explore_events', 'pos_events'),
  ('coop_explore_prices', 'pos_prices'), ('coop_explore_price_changes', 'pos_price_changes'), ('coop_explore_event_leads', 'spin_wheel_leads'),
  ('coop_explore_digest', 'digest_archive'),
  ('coop_explore_inventory', 'pos_inventory'), ('coop_explore_inventory_by_location', 'pos_inventory_by_location'),
  ('coop_explore_inventory_lots', 'pos_inventory_lots'), ('coop_explore_stock_movements', 'pos_stock_movements')
) s(view_name, source_table)
join information_schema.columns bc on bc.table_schema = 'public' and bc.table_name = s.source_table
where bc.column_name !~* 'password|token|secret|key|pin|hash|credential'
  and not exists (
    select 1 from information_schema.columns vc
    where vc.table_schema = 'public' and vc.table_name = s.view_name and vc.column_name = bc.column_name
  )
order by 1, 2;

-- (i) Role settings (pg_db_role_setting). EXPECTED: exactly the six settings of coop_chat_explore.sql.
-- BAD: a missing row (a setting was not applied) or an unexpected one.
with expected(setting) as (values
  ('default_transaction_read_only=on'), ('statement_timeout=5s'), ('lock_timeout=2s'),
  ('idle_in_transaction_session_timeout=10s'), ('search_path=public'), ('timezone=Asia/Manila')
), actual as (
  select lower(split_part(c, '=', 1)) || '=' || substr(c, position('=' in c) + 1) as setting -- Postgres may store TimeZone in its canonical case
  from pg_db_role_setting s
  cross join unnest(s.setconfig) c
  where s.setrole = (select oid from pg_roles where rolname = 'coop_explore_ro') and s.setdatabase = 0
)
select coalesce(e.setting, a.setting) as setting,
       e.setting is not null as expected,
       a.setting is not null as present,
       case when e.setting is not null and a.setting is not null then 'ok' when e.setting is null then 'UNEXPECTED' else 'MISSING' end as status
from expected e
full join actual a on a.setting = e.setting
order by status desc, 1;

-- (j) Secret-looking jsonb KEYS inside digest_archive.digest and .bundle (the name pattern applies to column names only; this tells a
-- person whether the jsonb contents need more). EXPECTED: 0 rows. UNVERIFIED on PROD until the co-worker runs it (spec U8).
with recursive w(src, id, k, v) as (
  select 'digest'::text, d.id, null::text, d.digest from public.digest_archive d
  union all
  select 'bundle'::text, d.id, null::text, d.bundle from public.digest_archive d
  union all
  select w.src, w.id, x.k, x.v
  from w
  cross join lateral (
    select e.key as k, e.value as v from jsonb_each(case when jsonb_typeof(w.v) = 'object' then w.v else '{}'::jsonb end) e
    union all
    select null::text, a.value from jsonb_array_elements(case when jsonb_typeof(w.v) = 'array' then w.v else '[]'::jsonb end) a
  ) x
)
select src as json_column, k as key_name, count(*) as occurrences
from w
where k ~* 'password|token|secret|key|pin|hash|credential'
group by 1, 2
order by 1, 2;
