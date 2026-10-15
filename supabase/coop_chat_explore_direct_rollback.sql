-- coop_chat_explore_direct_rollback.sql: undo supabase/coop_chat_explore_direct.sql (spec 1.7) and restore the Train 1 state: the login
-- coop_explore_ro reads ONLY the fifteen coop_explore_* views of supabase/coop_chat_explore.sql, without BYPASSRLS.
-- Hand-applied in the SQL editor, as postgres. Re-runnable. ONE transaction: it ends with a self-check that raises on any miss, and
-- then nothing at all is changed. Owner: zoomy-observability-dashboard (Ask Coop, Train 3).
-- THE APP MUST CHANGE TOO: the Train 3 prompt, worked examples and list_tables name base tables (pos_orders_completed, pos_events,
-- spin_wheel_leads, ...) that the rolled-back login cannot read, so almost every Explore query would fail with E_RELATION (fails
-- closed, no leak, but useless). Before or with this rollback, unset EXPLORE_MODE (the fastest stop; redeploy on Vercel) or deploy an
-- app version from before Train 3. REQUIRED afterwards: re-run supabase/coop_chat_explore.sql, then supabase/coop_chat_explore_checks.sql
-- (the Train 1 state checks: every BAD line there is a real finding) and read every result against its expectation. Do NOT run
-- coop_chat_explore_direct_checks.sql after a rollback. The self-check below proves the grants; the Train 1 checks prove the role
-- settings, the attributes (NOBYPASSRLS) and the views.
-- Tested locally by a round trip (apply, roll back, apply again; scripts/coop-explore-ro-proof.mjs at each point).
--
-- NOT restored: SELECT that apply_grants revoked from PUBLIC on a closed relation (a secret- or tenant-named table, an unlisted view)
-- that PUBLIC could read. That PUBLIC grant was a hole for every role, not a Train 1 feature; re-grant it by hand only if it was wanted,
-- from the PRE-APPLY SNAPSHOT (coop_chat_explore_direct_checks.sql (0)) and the apply output's `revoked SELECT from PUBLIC` notices.
begin;

create temp table coop_explore_rollback_views (v text primary key) on commit drop;
insert into coop_explore_rollback_views values -- = the fifteen views of supabase/coop_chat_explore.sql (src/chat/explore/views.ts)
  ('coop_explore_orders'), ('coop_explore_order_items'), ('coop_explore_products'), ('coop_explore_bundles'), ('coop_explore_bundle_items'),
  ('coop_explore_events'), ('coop_explore_prices'), ('coop_explore_price_changes'), ('coop_explore_event_leads'), ('coop_explore_digest'),
  ('coop_explore_inventory'), ('coop_explore_inventory_by_location'), ('coop_explore_inventory_lots'), ('coop_explore_stock_movements'),
  ('coop_explore_stock_event');

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'coop_explore_ro') then
    raise exception 'coop_explore_ro does not exist: nothing to roll back';
  end if;
end $$;

-- 1. The guards first, so the revokes below do not fire the trigger and the cron job cannot re-grant
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname in ('coop_explore_reapply', 'coop_explore_drift');
  end if;
end $$;
drop event trigger if exists coop_explore_guard_ddl;

-- 2. Every default privilege for the login (the file sets one: postgres, public, tables, SELECT), whatever its type or schema
do $$
declare
  d record;
begin
  for d in
    select distinct pg_get_userbyid(a.defaclrole) as owner, a.defaclnamespace, a.defaclobjtype
    from pg_default_acl a, aclexplode(a.defaclacl) x
    where x.grantee = 'coop_explore_ro'::regrole
  loop
    execute format('alter default privileges for role %I %s revoke all on %s from coop_explore_ro',
      d.owner,
      case when d.defaclnamespace = 0 then '' else format('in schema %I', d.defaclnamespace::regnamespace::text) end,
      case d.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions' when 'T' then 'types' when 'n' then 'schemas' end);
  end loop;
end $$;

-- 3. Every privilege on every public relation (tables, views, sequences; column grants go with the table REVOKE), then the fifteen
--    views back
do $$
declare
  r record;
begin
  for r in select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') loop
    execute format('revoke all on %s public.%I from coop_explore_ro cascade', case when r.relkind = 'S' then 'sequence' else 'table' end, r.relname);
  end loop;
  for r in select v.v as relname from coop_explore_rollback_views v where to_regclass('public.' || v.v) is not null loop
    execute format('grant select on public.%I to coop_explore_ro', r.relname);
  end loop;
end $$;

-- 4. The role, the drift log and the helper schema
alter role coop_explore_ro nobypassrls;
drop table if exists public.coop_explore_drift_log;
drop schema if exists coop_explore_admin cascade;

-- 5. Self-check (raises on any miss; the transaction then changes nothing)
do $$
declare
  ro oid := 'coop_explore_ro'::regrole;
  bad text;
begin
  if exists (select 1 from pg_event_trigger where evtname = 'coop_explore_guard_ddl') then
    raise exception 'rollback: event trigger coop_explore_guard_ddl still present';
  end if;
  if to_regclass('cron.job') is not null then
    execute 'select string_agg(jobname, '', '') from cron.job where jobname like ''coop\_explore\_%''' into bad;
    if bad is not null then raise exception 'rollback: cron jobs still scheduled: %', bad; end if;
  end if;
  if (select rolbypassrls from pg_roles where oid = ro) then
    raise exception 'rollback: coop_explore_ro still has BYPASSRLS';
  end if;
  if exists (select 1 from pg_default_acl d, aclexplode(d.defaclacl) a where a.grantee = ro) then
    raise exception 'rollback: default privileges still grant coop_explore_ro';
  end if;
  if to_regnamespace('coop_explore_admin') is not null or to_regclass('public.coop_explore_drift_log') is not null then
    raise exception 'rollback: coop_explore_admin or coop_explore_drift_log still present';
  end if;
  select string_agg(v.v, ', ') into bad from coop_explore_rollback_views v
  where to_regclass('public.' || v.v) is null or not has_table_privilege(ro, ('public.' || v.v)::regclass, 'SELECT');
  if bad is not null then
    raise exception 'rollback: the login cannot read these coop_explore_ views (re-run supabase/coop_chat_explore.sql): %', bad;
  end if;
  -- has_*_privilege counts PUBLIC's grants too: the login must reach nothing else in public, and nothing but SELECT on the fifteen
  select string_agg(c.relname, ', ') into bad from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and (has_table_privilege(ro, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or has_any_column_privilege(ro, c.oid, 'INSERT,UPDATE,REFERENCES')
         or (c.relname not in (select v.v from coop_explore_rollback_views v) and has_any_column_privilege(ro, c.oid, 'SELECT')));
  if bad is not null then
    raise exception 'rollback: coop_explore_ro still reaches relations outside the fifteen views, or can write: %', bad;
  end if;
  if exists (select 1 from pg_auth_members m where m.member = ro) then
    raise exception 'rollback: coop_explore_ro is a member of another role (it never should be)';
  end if;
  raise notice 'rollback verified: coop_explore_ro reads the fifteen coop_explore_* views only, no BYPASSRLS, no trigger, no cron job, no helper schema';
end $$;

commit;
