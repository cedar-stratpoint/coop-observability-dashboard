-- coop_chat_explore_direct.sql
-- Owner: zoomy-observability-dashboard (Ask Coop direct reads, Train 3). Best practice: knowledge/best-practices/chat-direct-read-access.md
-- Applied BY HAND in the archive project's SQL editor, as postgres: staging first. PROD only after zoomy-pos revokes PUBLIC/anon/
-- authenticated execute on its write RPCs (spec 5.3). Re-runnable. Afterwards run supabase/coop_chat_explore_direct_checks.sql.
-- From here on, check with coop_chat_explore_direct_checks.sql; coop_chat_explore_checks.sql is for the Train 1 state only.
-- Rollback: unset EXPLORE_MODE first (the Train 3 app names base tables the rolled-back login cannot read), then
-- supabase/coop_chat_explore_direct_rollback.sql, then (REQUIRED) re-run supabase/coop_chat_explore.sql and
-- supabase/coop_chat_explore_checks.sql: the rollback's self-check proves the grants, the Train 1 checks prove the rest.
--
-- PRE-APPLY SNAPSHOT (ONCE per environment, BEFORE the first apply; keep the output with the environment notes, see
-- knowledge/data-catalog/index.md "Environment notes"). apply_grants revokes PUBLIC's SELECT on any closed relation PUBLIC could
-- read, and a rollback cannot restore it; this list is the only record of what PUBLIC held. Names and privileges only, no data:
--   select c.relname, c.relkind, a.privilege_type, a.is_grantable
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) a
--   where n.nspname = 'public' and a.grantee = 0 order by 1, 3;
-- Every apply and every re-apply also prints `NOTICE: coop_explore_admin: revoked SELECT from PUBLIC on <relation> (...)` for each
-- relation it changes that way: keep the apply output too.
--
-- RUNBOOK (after every apply, as postgres):
--   select jobname from cron.job where jobname = 'coop_explore_reapply';   -- must return ONE row; none = only the trigger guards new objects
--   select evtname, evtenabled from pg_event_trigger where evtname = 'coop_explore_guard_ddl';   -- expect coop_explore_guard_ddl|O
--   select * from coop_explore_admin.unlisted_views();   -- every public view not allowlisted; a STILL READABLE line is a finding
--   select * from coop_explore_admin.readable_closed();   -- every closed relation the login can still read, with the reason: expect 0 rows
--   -- the same by hand (has_any_column_privilege also catches column-only grants, e.g. to PUBLIC): expect 0 rows
--   select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
--     and has_any_column_privilege('coop_explore_ro', c.oid, 'select')
--     and ((c.relkind in ('v', 'm', 'f') and not c.relname = any (coop_explore_admin.view_allowlist())) or coop_explore_admin.is_closed_table(c.relname));
--   select jsonb_pretty(coop_explore_admin.drift_findings());   -- every SECURITY key empty; unlisted_views = views waiting for the
--                                                                  -- allowlist only (a to-do, not counted in findings_count)
-- KNOWN LIMITS (accepted, Train 3 review): a GRANT ... TO PUBLIC made by supabase_admin (or any superuser / reserved role, which skip
-- the event trigger) stays readable by the login until the next coop_explore_reapply run (at most 5 minutes); apply_grants covers the
-- public schema only (other schemas are fenced by USAGE, checked by drift other_schemas); new views (Task 8's included) are unreadable
-- until added to view_allowlist() (drift unlisted_views lists them).
-- Recover by hand (grants look wrong, the cron job is missing, or a guard warning mentions a cancel):
--   select coop_explore_admin.reapply_all();   -- idempotent; returns how many relations it changed
-- ADD A VIEW for Ask Coop (views are DEFAULT-DENY; tables are not):
--   1. Review the view body: no function outside pg_catalog, no query-running function (query_to_xml, ts_stat, ...), no domain or type
--      with a user CHECK/IO function, no closed table or secret column. The second layer (reads_closed) still closes it if it trips.
--   2. Add ONE line to view_allowlist() below (name + where it comes from), add the view to knowledge/data-catalog/tables.md, re-apply
--      this file, then `select coop_explore_admin.reapply_all();` and check has_table_privilege('coop_explore_ro', '<view>', 'select').
--
-- WHAT THIS DOES
--   1. coop_explore_ro (created by coop_chat_explore.sql) gets BYPASSRLS: every archive table has RLS on and no policies.
--   2. One secret-name rule in the private schema coop_explore_admin (never public: PostgREST exposes public functions to anon).
--      TS copy: src/chat/explore/secret-names.ts; test/chat-explore-secret-names.test.ts fails when they differ.
--   3. apply_grants(rel): TABLES are open by default: SELECT on an open table; column grants on the safe columns of a table with a
--      secret column; nothing on a closed table (secret or tenant name). VIEWS (materialized views, foreign tables) are DEFAULT-DENY: granted only
--      when named in view_allowlist(), and even then closed when reads_closed() trips (second layer). A view runs logic as the login
--      (query_to_xml over a definer function, a domain CHECK, a wrapper function, ...): no blacklist of view shapes is complete.
--      A closed relation (or secret column) the login can still read through PUBLIC loses PUBLIC's SELECT on it.
--      Idempotent: no change when the ACL is right.
--   4. Default privileges for relations postgres creates (only while the event trigger is installed: those privileges also cover
--      views, and only the trigger takes a new view's grant back in the same transaction), then reapply_all() for the existing ones.
--   5. Event trigger coop_explore_guard_ddl re-applies on DDL; pg_cron re-applies every 5 minutes as well, because Supabase skips user
--      event triggers for superusers and reserved roles (https://supabase.com/blog/event-triggers-wo-superuser).
--   7. A daily drift job (pg_cron coop_explore_drift, 06:00 PH) writes drift_findings() into public.coop_explore_drift_log.
-- The coop_explore_* views of coop_chat_explore.sql stay (aliases during the switch). Not touched: coop_chat_ro, the coop_chat_* views,
-- any pos_* DDL.

-- 0. Prerequisites ----------------------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'coop_explore_ro') then
    raise exception 'apply supabase/coop_chat_explore.sql first (it creates the login coop_explore_ro)';
  end if;
  if current_setting('server_version_num')::int < 160000 then
    raise exception 'coop_chat_explore_direct.sql needs PostgreSQL 16 or newer (this server is %): before 16 only a superuser may ALTER ROLE ... BYPASSRLS. Hosted: check `show server_version_num`.', current_setting('server_version');
  end if;
  if not (select rolbypassrls from pg_roles where rolname = current_user) then
    raise exception 'run this as a role that has BYPASSRLS (postgres in the SQL editor): only such a role may grant it';
  end if;
end $$;

-- 1. Role -------------------------------------------------------------------------------------------------------
alter role coop_explore_ro bypassrls;

-- 2. The name rule ----------------------------------------------------------------------------------------------
create schema if not exists coop_explore_admin;
revoke all on schema coop_explore_admin from public;

create or replace function coop_explore_admin.secret_parts() returns text[] language sql immutable set search_path = '' as $$
  select array['password', 'token', 'secret', 'key', 'pin', 'hash', 'credential']::text[]
$$;
create or replace function coop_explore_admin.tenant_prefixes() returns text[] language sql immutable set search_path = '' as $$
  select array['gl_', 'company_']::text[]
$$;
create or replace function coop_explore_admin.tenant_tables() returns text[] language sql immutable set search_path = '' as $$
  select array['companies']::text[]
$$;
create or replace function coop_explore_admin.column_exceptions() returns text[] language sql immutable set search_path = '' as $$
  select array['pos_settings.key']::text[]
$$;

-- THE VIEW ALLOWLIST: the only public views and materialized views coop_explore_ro may read. One reviewed line per view, plus its
-- entry in knowledge/data-catalog/tables.md (see "ADD A VIEW" in the header). A view NOT named here is never granted, and any grant
-- on it is revoked by apply_grants, the event trigger and the cron job. A view dropped and re-created under a listed name is granted
-- again (subject to reads_closed). Not listed on purpose: gl_inventory_snapshots (tenant fence; Ask Coop is Zoomy-only).
create or replace function coop_explore_admin.view_allowlist() returns text[] language sql immutable set search_path = '' as $$
  select array[
    -- registry views, supabase/coop_chat_readonly.sql + coop_chat_digest.sql (data catalog section 15)
    'coop_chat_bundles', 'coop_chat_digest', 'coop_chat_events', 'coop_chat_order_items',
    'coop_chat_orders', 'coop_chat_price_changes', 'coop_chat_prices', 'coop_chat_products',
    -- registry stock views, supabase/coop_chat_stock.sql (data catalog section 15)
    'coop_chat_sale_movements', 'coop_chat_stock_by_location', 'coop_chat_stock_config',
    -- explore views, supabase/coop_chat_explore.sql, list in src/chat/explore/views.ts (data catalog section 15)
    'coop_explore_bundle_items', 'coop_explore_bundles', 'coop_explore_digest', 'coop_explore_event_leads', 'coop_explore_events',
    'coop_explore_inventory', 'coop_explore_inventory_by_location', 'coop_explore_inventory_lots', 'coop_explore_order_items',
    'coop_explore_orders', 'coop_explore_price_changes', 'coop_explore_prices', 'coop_explore_products', 'coop_explore_stock_event',
    'coop_explore_stock_movements',
    -- zoomy-pos read views (DDL in zoomy-pos; data catalog: pos_inventory and pos_inventory_by_location, "a view")
    'pos_inventory', 'pos_inventory_by_location',
    -- Ask Coop default view over pos_orders (completed only), supabase/coop_chat_default_views.sql (data catalog section 1)
    'pos_orders_completed'
  ]::text[]
$$;

create or replace function coop_explore_admin.is_secret_name(name text) returns boolean language sql immutable set search_path = '' as $$
  select exists (
    select 1
    from unnest(regexp_split_to_array(lower(name), '[^a-z0-9]+')) as w(word),
         unnest(coop_explore_admin.secret_parts()) as p(part)
    where w.word in (p.part, p.part || 's', p.part || 'es'))
$$;

create or replace function coop_explore_admin.is_closed_table(name text) returns boolean language sql immutable set search_path = '' as $$
  select coop_explore_admin.is_secret_name(name)
      or lower(name) = any (coop_explore_admin.tenant_tables())
      or exists (select 1 from unnest(coop_explore_admin.tenant_prefixes()) as t(prefix) where left(lower(name), length(t.prefix)) = t.prefix)
$$;

create or replace function coop_explore_admin.is_secret_column(tbl text, col text) returns boolean language sql immutable set search_path = '' as $$
  select coop_explore_admin.is_secret_name(col) and not ((lower(tbl) || '.' || lower(col)) = any (coop_explore_admin.column_exceptions()))
$$;

-- A view (or materialized view) is closed when it reads, at ANY depth, a closed relation, a secret column, another schema, or ANY
-- relation that has a secret column. The last clause fails closed on whole-row reads (to_jsonb(x), row_to_json(x), x::text): Postgres
-- records those as a column-0 dependency, so the per-column check alone would grant a view that returns the secret column.
-- Trade-off: a view over only the safe columns of a mixed table is closed too (read the table's column grants instead).
-- It is also closed when the view, or any view under it, calls a function that lives outside pg_catalog (directly, through an operator's
-- oprcode, or through a cast's castfunc), or any SECURITY DEFINER function. pg_depend records only the function a view names, never what
-- the function reads: `to_jsonb(f) from sd_fn() f`, an INVOKER wrapper around sd_fn() (the login has EXECUTE on definer RPCs), and an
-- operator over sd_fn all returned the secret. The prosecdef clause is kept on purpose: only a superuser can put a function in
-- pg_catalog, so it is redundant today, but it costs nothing and keeps the definer rule explicit.
-- This is the SECOND layer for views: the first is view_allowlist() (default-deny). No allowlisted view trips it locally.
create or replace function coop_explore_admin.reads_closed(rel oid) returns boolean language sql stable set search_path = '' as $$
  with recursive deps(oid, att) as (
    select d.refobjid, d.refobjsubid
    from pg_catalog.pg_rewrite rw
    join pg_catalog.pg_depend d on d.classid = 'pg_catalog.pg_rewrite'::regclass and d.objid = rw.oid and d.refclassid = 'pg_catalog.pg_class'::regclass
    where rw.ev_class = rel and d.refobjid <> rel
    union
    select d.refobjid, d.refobjsubid
    from deps
    join pg_catalog.pg_rewrite rw on rw.ev_class = deps.oid
    join pg_catalog.pg_depend d on d.classid = 'pg_catalog.pg_rewrite'::regclass and d.objid = rw.oid and d.refclassid = 'pg_catalog.pg_class'::regclass
    where d.refobjid <> deps.oid
  )
  select exists (
    select 1
    from deps
    join pg_catalog.pg_class t on t.oid = deps.oid
    join pg_catalog.pg_namespace n on n.oid = t.relnamespace
    left join pg_catalog.pg_attribute a on a.attrelid = deps.oid and a.attnum = deps.att and deps.att > 0
    where n.nspname <> 'public'
       or coop_explore_admin.is_closed_table(t.relname)
       or (a.attname is not null and coop_explore_admin.is_secret_column(t.relname, a.attname))
       or exists (select 1 from pg_catalog.pg_attribute a2
                  where a2.attrelid = deps.oid and a2.attnum > 0 and not a2.attisdropped
                    and coop_explore_admin.is_secret_column(t.relname, a2.attname)))
  or exists (
    select 1
    from pg_catalog.pg_rewrite rw
    join pg_catalog.pg_depend d on d.classid = 'pg_catalog.pg_rewrite'::regclass and d.objid = rw.oid
    left join pg_catalog.pg_operator o on d.refclassid = 'pg_catalog.pg_operator'::regclass and o.oid = d.refobjid
    left join pg_catalog.pg_cast k on d.refclassid = 'pg_catalog.pg_cast'::regclass and k.oid = d.refobjid
    join pg_catalog.pg_proc p on p.oid = case d.refclassid
                                           when 'pg_catalog.pg_proc'::regclass then d.refobjid
                                           when 'pg_catalog.pg_operator'::regclass then o.oprcode::oid
                                           when 'pg_catalog.pg_cast'::regclass then k.castfunc
                                         end
    join pg_catalog.pg_namespace pn on pn.oid = p.pronamespace
    where (rw.ev_class = rel or rw.ev_class in (select deps.oid from deps))
      and (p.prosecdef or pn.nspname <> 'pg_catalog'))
$$;

-- Why a relation must be CLOSED to the login (null = open). Views, materialized views and foreign tables are default-deny.
create or replace function coop_explore_admin.closed_reason(rel oid) returns text language sql stable set search_path = '' as $$
  select case
    when coop_explore_admin.is_closed_table(c.relname) then 'secret or tenant name'
    when c.relkind in ('v', 'm', 'f') and not (c.relname::text = any (coop_explore_admin.view_allowlist())) then 'view not allowlisted'
    when coop_explore_admin.reads_closed(c.oid) then 'reads a closed relation, a secret column or a user function'
  end
  from pg_catalog.pg_class c where c.oid = rel
$$;

-- What the login can EFFECTIVELY read that it must not (null = nothing), whoever granted it: its own grants, PUBLIC, or a role it
-- belongs to. has_any_column_privilege, not has_table_privilege: a column-only grant (`grant select (store_code) ... to public`)
-- leaves has_table_privilege false but the column readable.
create or replace function coop_explore_admin.login_leak(rel oid) returns text language sql stable set search_path = '' as $$
  select case
    when coop_explore_admin.closed_reason(rel) is not null
         and pg_catalog.has_any_column_privilege('coop_explore_ro', rel, 'SELECT') then coop_explore_admin.closed_reason(rel)
    else (select 'secret column ' || a.attname
          from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid
          where a.attrelid = rel and a.attnum > 0 and not a.attisdropped
            and coop_explore_admin.is_secret_column(c.relname, a.attname)
            and pg_catalog.has_column_privilege('coop_explore_ro', rel, a.attnum, 'SELECT')
          order by a.attnum limit 1)
  end
$$;

-- For the drift check and the runbook: one line per public view (or foreign table) that is not allowlisted. Normally not readable;
-- a line saying STILL READABLE means apply_grants could not close it (role membership): a finding.
create or replace function coop_explore_admin.unlisted_views() returns setof text language sql stable set search_path = '' as $$
  select case when coop_explore_admin.login_leak(c.oid) is null
              then format('view not allowlisted: %s (not readable until added)', c.relname)
              else format('view not allowlisted but STILL READABLE by the login: %s (revoke failed: role membership?)', c.relname) end
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('v', 'm', 'f') and not (c.relname::text = any (coop_explore_admin.view_allowlist()))
  order by c.relname
$$;

-- For the drift check and the runbook: EVERY public relation the login can still read although it must not, with the reason.
-- Expected: no rows.
create or replace function coop_explore_admin.readable_closed() returns setof text language sql stable set search_path = '' as $$
  select format('still readable by the login: %s (%s)', c.relname, coop_explore_admin.login_leak(c.oid))
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f') and coop_explore_admin.login_leak(c.oid) is not null
  order by c.relname
$$;

-- 3. apply_grants: decide ONE relation. Never raises (a failure in the event trigger would abort someone else's DDL).
create or replace function coop_explore_admin.apply_grants(rel oid) returns text language plpgsql set search_path = '' as $$
declare
  ro oid := (select oid from pg_catalog.pg_roles where rolname = 'coop_explore_ro');
  r record;
  closed boolean;
  mixed boolean;
  safe_cols text[];
  have_tab text[];
  have_cols text[];
  want_tab text[];
  want_cols text[];
  result text;
  leak text;
begin
  select c.oid, c.relname, c.relkind, n.nspname into r
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where c.oid = rel;
  if not found or ro is null or r.nspname <> 'public' or r.relkind not in ('r', 'p', 'v', 'm', 'f') then
    return 'skipped';
  end if;
  -- views: default-deny (allowlist first), then the second layer; tables: open unless the name rule closes them
  closed := coop_explore_admin.closed_reason(rel) is not null;
  select coalesce(array_agg(a.attname::text order by a.attnum) filter (where not coop_explore_admin.is_secret_column(r.relname, a.attname)), '{}'),
         coalesce(bool_or(coop_explore_admin.is_secret_column(r.relname, a.attname)), false)
    into safe_cols, mixed
  from pg_catalog.pg_attribute a
  where a.attrelid = rel and a.attnum > 0 and not a.attisdropped;
  -- a WITH GRANT OPTION privilege is encoded as 'SELECT*', so it never equals the wanted ACL and is always reset
  select coalesce(array_agg(distinct x.privilege_type || case when x.is_grantable then '*' else '' end
                            order by x.privilege_type || case when x.is_grantable then '*' else '' end), '{}') into have_tab
  from pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) x
  where c.oid = rel and x.grantee = ro;
  -- column ACLs compared as 'column:PRIVILEGE', so a hand-made `grant update (label)` is a difference, not 'ok'
  select coalesce(array_agg(distinct a.attname::text || ':' || x.privilege_type || case when x.is_grantable then '*' else '' end
                            order by a.attname::text || ':' || x.privilege_type || case when x.is_grantable then '*' else '' end), '{}') into have_cols
  from pg_catalog.pg_attribute a, pg_catalog.aclexplode(a.attacl) x
  where a.attrelid = rel and a.attnum > 0 and not a.attisdropped and x.grantee = ro;
  want_tab := case when closed or mixed then '{}'::text[] else array['SELECT'] end;
  want_cols := case when not closed and mixed then safe_cols else '{}'::text[] end;
  if have_tab = want_tab
     and have_cols = (select coalesce(array_agg(c || ':SELECT' order by c || ':SELECT'), '{}') from unnest(want_cols) as c) then
    result := 'ok';
  else
    -- also revokes every column privilege and grant option; cascade drops anything the role re-granted with a grant option
    execute format('revoke all on public.%I from coop_explore_ro cascade', r.relname);
    if want_tab <> '{}'::text[] then
      execute format('grant select on public.%I to coop_explore_ro', r.relname);
      result := 'granted';
    elsif want_cols <> '{}'::text[] then
      execute format('grant select (%s) on public.%I to coop_explore_ro', (select string_agg(format('%I', c), ', ') from unnest(want_cols) as c), r.relname);
      result := 'columns';
    else
      result := 'closed';
    end if;
  end if;
  -- The login also reads what is granted to PUBLIC (default privileges `to public`, `grant select ... to public`). If it can still
  -- read a closed relation or a secret column, revoke SELECT from PUBLIC on that relation: a table-level REVOKE also revokes PUBLIC's
  -- column grants. Safe on Supabase: anon, authenticated and service_role hold their own explicit grants, never PUBLIC's. Grants to
  -- any other role are not touched; if the login still reads it (role membership), warn, and readable_closed() reports it.
  if coop_explore_admin.login_leak(rel) is not null then
    execute format('revoke select on public.%I from public', r.relname);
    result := 'public-revoked';
    raise notice 'coop_explore_admin: revoked SELECT from PUBLIC on % (%): record it, a rollback cannot restore it',
      r.relname, coalesce(coop_explore_admin.closed_reason(rel), 'secret column');
    leak := coop_explore_admin.login_leak(rel);
    if leak is not null then
      raise warning 'coop_explore_admin: % still readable by the login through role membership (%)', r.relname, leak;
    end if;
  end if;
  return result;
exception when others then
  raise warning 'coop_explore_admin.apply_grants(%): % (%)', rel, sqlerrm, sqlstate;
  return 'error';
end $$;

create or replace function coop_explore_admin.reapply_all() returns integer language plpgsql set search_path = '' as $$
declare
  was text := coalesce(current_setting('coop_explore.in_guard', true), '');
  r record;
  changed integer := 0;
begin
  perform set_config('coop_explore.in_guard', 'on', true);
  for r in
    select c.oid from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f') order by c.oid
  loop
    if coop_explore_admin.apply_grants(r.oid) not in ('ok', 'skipped') then
      changed := changed + 1;
    end if;
  end loop;
  perform set_config('coop_explore.in_guard', was, true);
  return changed;
end $$;

-- 4. Grants ------------------------------------------------------------------------------------------------------
grant usage on schema public to coop_explore_ro;
-- default privileges are set with the event trigger in section 5 (they cover views too, so they need the trigger)
select coop_explore_admin.reapply_all() as relations_changed;

-- 5. Event trigger (SECURITY INVOKER on purpose: a definer event-trigger function fires even for superusers, supautils issue #140)
create or replace function coop_explore_admin.guard_ddl() returns event_trigger language plpgsql set search_path = '' as $$
declare
  r record;
begin
  if coalesce(current_setting('coop_explore.in_guard', true), '') = 'on' then
    return; -- our own GRANT/REVOKE: never recurse
  end if;
  -- GRANT/REVOKE rows carry no usable objid, and a change to one relation can close or open the views over it (a table renamed to a
  -- secret name, a column renamed to api_key): re-apply the whole schema (tens of relations, milliseconds; idempotent).
  if tg_tag in ('GRANT', 'REVOKE', 'ALTER DEFAULT PRIVILEGES')
     or exists (select 1 from pg_catalog.pg_event_trigger_ddl_commands() c
                where c.classid = 'pg_catalog.pg_class'::regclass and c.schema_name = 'public') then
    perform coop_explore_admin.reapply_all(); -- sets and restores the in_guard flag itself
  end if;
exception
  -- A statement_timeout (or a cancel) firing while this trigger runs would abort the user's DDL. `set local statement_timeout = 0`
  -- cannot prevent that: the timer is armed when the statement starts and a SET inside it does not disarm it (verified locally, PG 17),
  -- and WHEN OTHERS does not catch query_canceled. So catch it by name: the DDL completes, and the 5-minute cron job re-applies.
  -- Fail closed: the DDL may have opened a secret on a relation the login can already read (add column api_key, a rename to token, a
  -- GRANT). Revoke the login's privileges on every relation the commands touched and on every view over them, at any depth; GRANT,
  -- REVOKE and ALTER DEFAULT PRIVILEGES carry no objid, so for those revoke on every public relation. The cron job re-grants the right
  -- ones. The timer has already fired, so this runs to the end; a second cancel is caught too (warning, nothing more).
  when query_canceled then
    begin
      perform set_config('coop_explore.in_guard', 'on', true);
      for r in
        with recursive hit(oid) as (
          select c.objid from pg_catalog.pg_event_trigger_ddl_commands() c
          where c.classid = 'pg_catalog.pg_class'::regclass and c.schema_name = 'public'
          union
          select rw.ev_class
          from hit
          join pg_catalog.pg_depend d on d.refclassid = 'pg_catalog.pg_class'::regclass and d.refobjid = hit.oid
                                     and d.classid = 'pg_catalog.pg_rewrite'::regclass
          join pg_catalog.pg_rewrite rw on rw.oid = d.objid
        )
        select c.relname
        from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
          and (c.oid in (select hit.oid from hit) or tg_tag in ('GRANT', 'REVOKE', 'ALTER DEFAULT PRIVILEGES'))
      loop
        begin -- one sub-block per relation: a failing revoke must not roll back the others (that would fail OPEN)
          execute format('revoke all on public.%I from coop_explore_ro cascade', r.relname);
        exception when query_canceled or others then
          raise warning 'coop_explore_guard_ddl: could not revoke the login on public.%: % (%)', r.relname, sqlerrm, sqlstate;
        end;
      end loop;
      perform set_config('coop_explore.in_guard', '', true);
      raise warning 'coop_explore_guard_ddl: cancelled (statement timeout?): revoked the login on the touched relations; the coop_explore_reapply cron job re-grants';
    exception when query_canceled or others then
      perform set_config('coop_explore.in_guard', '', true);
      raise warning 'coop_explore_guard_ddl: cancelled, and failing closed also failed: % (%)', sqlerrm, sqlstate;
    end;
  when others then
    perform set_config('coop_explore.in_guard', '', true);
    raise warning 'coop_explore_guard_ddl: % (%)', sqlerrm, sqlstate;
end $$;

revoke execute on all functions in schema coop_explore_admin from public; -- defence in depth: the schema is already private

do $$
begin
  drop event trigger if exists coop_explore_guard_ddl;
  create event trigger coop_explore_guard_ddl on ddl_command_end
    when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'ALTER TABLE', 'CREATE VIEW', 'ALTER VIEW', 'CREATE MATERIALIZED VIEW',
                 'ALTER MATERIALIZED VIEW', 'CREATE FOREIGN TABLE', 'ALTER FOREIGN TABLE', 'GRANT', 'REVOKE', 'ALTER DEFAULT PRIVILEGES')
    execute function coop_explore_admin.guard_ddl();
  -- new tables readable at once; a new view is granted by these too and the trigger revokes it in the same transaction
  alter default privileges for role postgres in schema public grant select on tables to coop_explore_ro;
  raise notice 'event trigger coop_explore_guard_ddl installed';
exception when insufficient_privilege then
  -- fail closed: without the trigger nothing would take a new VIEW's default grant back for up to 5 minutes, so no default
  -- privileges; new tables then wait for the cron job (at most 5 minutes)
  alter default privileges for role postgres in schema public revoke select on tables from coop_explore_ro;
  raise notice 'event trigger NOT installed (%): no default privileges; the 5-minute pg_cron job below is the only guard and grants new tables', sqlerrm;
end $$;

-- 6. pg_cron backstop (skipped triggers: superuser or reserved-role DDL) ------------------------------------------
do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice 'pg_cron could not be enabled here (%): enable it in Database > Extensions, then re-run this file', sqlerrm;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('coop_explore_reapply', '*/5 * * * *', 'select coop_explore_admin.reapply_all()');
    raise notice 'pg_cron job coop_explore_reapply scheduled (every 5 minutes)';
  else
    raise notice 'pg_cron is not enabled: new objects rely on the event trigger alone until it is';
  end if;
end $$;

-- 7. Daily drift check (spec 1.6). Names and counts only, never values. /api/chat/health reads the newest row's time and count.
-- The login reads this table (an open name), so the health route can read it through the same read-only envelope as the chat.
create table if not exists public.coop_explore_drift_log (
  id bigserial primary key,
  checked_at timestamptz not null default now(),
  findings jsonb not null,
  findings_count integer not null
);
alter table public.coop_explore_drift_log enable row level security;
revoke all on public.coop_explore_drift_log from public, anon, authenticated;
-- Supabase default privileges also give anon/authenticated USAGE and UPDATE (setval) on the id sequence: take those back too.
revoke all on sequence public.coop_explore_drift_log_id_seq from public, anon, authenticated;
select coop_explore_admin.apply_grants('public.coop_explore_drift_log'::regclass) as drift_log_grant; -- without the trigger too

-- Every key holds an array of names (never values). On a healthy database every SECURITY key is empty; unlisted_views is a TO-DO list
-- (views waiting for the allowlist, closed meanwhile) and is not counted in findings_count by record_drift().
--   closed_readable          a closed relation (secret or tenant name, view not allowlisted, view over a closed object) the login can
--                            read, whoever granted it (its own grant, PUBLIC). Same rule as readable_closed(), minus mixed tables.
--   secret_columns_readable  a secret column of an OPEN (mixed) table the login can read.
--   write_privileges         any non-SELECT privilege (table, column, default privileges), or CREATE on schema public.
--   unreadable_open          an open relation the login cannot read (owned by a role other than postgres, or a missed grant).
--   unlisted_views           a public view, materialized view or foreign table that is not allowlisted (not readable: fail closed),
--                            except names closed by the name rule (gl_*, *_tokens, ...), which are closed on purpose. Allowlist it or
--                            drop it; Task 8's new views land here until added.
--   role                     role attribute drift, or ANY role membership: the login is NOINHERIT, so a granted role is invisible to
--                            has_*_privilege but reachable through SET ROLE.
--   guard                    the event trigger is missing or not firing for ordinary sessions (only evtenabled O or A fires; R =
--                            replica only, D = disabled), or the coop_explore_reapply cron job is missing, inactive, or its latest
--                            finished run failed or is older than 15 minutes (a brand-new job with no run yet is not reported).
--   other_schemas            any schema other than public / pg_catalog / information_schema the login holds USAGE on.
create or replace function coop_explore_admin.drift_findings() returns jsonb language plpgsql stable set search_path = '' as $$
declare
  ro oid := (select oid from pg_catalog.pg_roles where rolname = 'coop_explore_ro');
  f jsonb;
  guard text[] := '{}';
  job_ok boolean;
  last_run text;
begin
  if ro is null then
    return jsonb_build_object('role', jsonb_build_array('role coop_explore_ro missing'));
  end if;
  if not exists (select 1 from pg_catalog.pg_event_trigger where evtname = 'coop_explore_guard_ddl' and evtenabled in ('O', 'A')) then
    guard := guard || 'event trigger coop_explore_guard_ddl missing, disabled or replica-only'::text;
  end if;
  if pg_catalog.to_regclass('cron.job') is null then -- dynamic SQL below: this function must compile without pg_cron
    guard := guard || 'pg_cron not installed: no coop_explore_reapply backstop'::text;
  else
    execute 'select exists (select 1 from cron.job where jobname = ''coop_explore_reapply'' and active)' into job_ok;
    if not job_ok then
      guard := guard || 'cron job coop_explore_reapply missing or inactive'::text;
    elsif pg_catalog.to_regclass('cron.job_run_details') is null then
      guard := guard || 'cron.job_run_details missing: the coop_explore_reapply runs cannot be checked'::text;
    else
      -- the latest FINISHED run (a run in progress at this moment is skipped): it must have succeeded within the last 15 minutes
      execute 'select d.status || case when d.end_time < now() - interval ''15 minutes'' then '':stale'' else '''' end
               from cron.job_run_details d join cron.job j on j.jobid = d.jobid
               where j.jobname = ''coop_explore_reapply'' and d.end_time is not null
               order by d.end_time desc limit 1' into last_run;
      if last_run is not null and last_run <> 'succeeded' then
        guard := guard || format('cron job coop_explore_reapply: latest finished run is %s (expected succeeded within 15 minutes)', last_run);
      end if;
    end if;
  end if;
  with rels as (
    select c.oid, c.relname, coop_explore_admin.closed_reason(c.oid) as reason
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
  ),
  closed_readable as (
    select format('%s (%s)', r.relname, r.reason) as name from rels r
    where r.reason is not null and pg_catalog.has_any_column_privilege(ro, r.oid, 'SELECT')
  ),
  secret_columns_readable as (
    select r.relname || '.' || a.attname as name
    from rels r join pg_catalog.pg_attribute a on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
    where r.reason is null and coop_explore_admin.is_secret_column(r.relname, a.attname)
      and pg_catalog.has_column_privilege(ro, r.oid, a.attnum, 'SELECT')
  ),
  write_privileges as (
    select r.relname as name from rels r
    where pg_catalog.has_table_privilege(ro, r.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or pg_catalog.has_any_column_privilege(ro, r.oid, 'INSERT,UPDATE,REFERENCES')
    union all
    select 'CREATE on schema public' where pg_catalog.has_schema_privilege(ro, 'public', 'CREATE')
    union all
    select format('default privilege %s on %s for %s', a.privilege_type, d.defaclobjtype, pg_catalog.pg_get_userbyid(d.defaclrole))
    from pg_catalog.pg_default_acl d, pg_catalog.aclexplode(d.defaclacl) a
    where a.grantee = ro and not (a.privilege_type = 'SELECT' and d.defaclobjtype = 'r' and not a.is_grantable)
  ),
  unreadable_open as (
    select r.relname as name from rels r
    where r.reason is null and not pg_catalog.has_any_column_privilege(ro, r.oid, 'SELECT')
  ),
  unlisted_views as (
    select c.relname as name
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('v', 'm', 'f')
      and not (c.relname::text = any (coop_explore_admin.view_allowlist()))
      and not coop_explore_admin.is_closed_table(c.relname)
  ),
  role_drift as (
    select 'role attributes' as what from pg_catalog.pg_roles
    where oid = ro
      and not (rolcanlogin and not rolsuper and not rolinherit and not rolcreaterole and not rolcreatedb and not rolreplication and rolbypassrls and rolconnlimit = 10)
    union all
    select 'member of ' || pg_catalog.pg_get_userbyid(m.roleid) from pg_catalog.pg_auth_members m where m.member = ro
  ),
  other_schemas as (
    select n.nspname as name from pg_catalog.pg_namespace n
    where n.nspname not in ('public', 'pg_catalog', 'information_schema')
      and pg_catalog.has_schema_privilege(ro, n.oid, 'USAGE')
  )
  select jsonb_build_object(
    'closed_readable', coalesce((select jsonb_agg(name order by name) from closed_readable), '[]'::jsonb),
    'secret_columns_readable', coalesce((select jsonb_agg(name order by name) from secret_columns_readable), '[]'::jsonb),
    'write_privileges', coalesce((select jsonb_agg(name order by name) from write_privileges), '[]'::jsonb),
    'unreadable_open', coalesce((select jsonb_agg(name order by name) from unreadable_open), '[]'::jsonb),
    'unlisted_views', coalesce((select jsonb_agg(name order by name) from unlisted_views), '[]'::jsonb),
    'role', coalesce((select jsonb_agg(what order by what) from role_drift), '[]'::jsonb),
    'guard', to_jsonb(guard),
    'other_schemas', coalesce((select jsonb_agg(name order by name) from other_schemas), '[]'::jsonb))
  into f;
  return f;
end $$;

-- One row per run (90 days kept); a WARNING in the Postgres log when a SECURITY finding exists. Returns the number of security findings
-- (unlisted_views excluded: see drift_findings).
create or replace function coop_explore_admin.record_drift() returns integer language plpgsql set search_path = '' as $$
declare
  f jsonb := coop_explore_admin.drift_findings();
  n integer;
begin
  -- security findings only: unlisted_views is a to-do list (closed by default), stored in findings but not counted
  select coalesce(sum(jsonb_array_length(e.v)), 0)::integer into n from jsonb_each(f) as e(k, v) where e.k <> 'unlisted_views';
  insert into public.coop_explore_drift_log (findings, findings_count) values (f, n);
  delete from public.coop_explore_drift_log where checked_at < now() - interval '90 days';
  if n > 0 then
    raise warning 'coop_explore drift: % finding(s): %', n, f::text;
  end if;
  return n;
end $$;

revoke execute on all functions in schema coop_explore_admin from public;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('coop_explore_drift', '0 22 * * *', 'select coop_explore_admin.record_drift()');
    raise notice 'pg_cron job coop_explore_drift scheduled (daily 22:00 UTC = 06:00 PH)';
  else
    raise notice 'pg_cron is not enabled: no daily drift job; run select coop_explore_admin.record_drift() by hand';
  end if;
end $$;
select coop_explore_admin.record_drift() as drift_findings_now;
