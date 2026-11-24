-- S5 · Goldline sales totals kept per period (Nichido project). Needs s1 + s3 (+ s2).
-- Run on Nichido STAGING first; PROD only after review. Safe to re-run.
--
-- Why: sales_rollup, store_scope, forecast_months, sku_months and sales_by_sku added up
-- every sales row on each call (472k rows, 2 to 4 s each on Staging, with spills to disk
-- on the small instance), which is most of the wait on the Goldline pages. Measured
-- 2026-11-05: rewriting those functions bought nothing; reading fewer rows does.
--
-- What it does: three small tables hold the sales already added up, kept current by
-- statement triggers on sales, so the readers above decrypt a few thousand rows instead
-- of all of them. Same signatures and same output, so the app needs no change.
--
--   sales_sku_period    one row per SKU per period (~3.5k)       rows, units|gross|net
--   sales_store_period  one row per store per period (~3.7k)     rows, pos_rows, units|gross|net
--   sales_store_sku     one row per store per SKU, all time (~65k) rows (no figures)
--
-- The figures stay encrypted at rest: amounts_enc uses s1/s3's format ('gross|net|units',
-- same Vault key, AES-256-CBC, random IV), so a total is no easier to read than a row.
-- pos_rows counts rows with units > 0, which store_scope needs (a month with +5 and -5
-- still counts as sold). A null store/SKU code is kept as '' (none exist; the unique key
-- on sales doesn't stop them).
--
-- Kept current by: after insert / update / delete statement triggers on sales (with
-- transition tables) that decrypt only the changed rows and add the difference, and a
-- truncate trigger that clears the totals. Covers every write path (upsert_sales, the
-- app's delete of a sales file, scripts, the SQL editor). Concurrent uploads are safe:
-- the insert ... on conflict do update locks each total while it's added to.
--
-- Repair / check: private.rebuild_sales_totals(company) rebuilds from sales (one full
-- pass, a few seconds, blocks sales writes meanwhile). private.sales_totals_drift(company)
-- compares the totals to a fresh pass; every count should be 0.
--
-- Rollout: this file (it backfills at the end) → check drift → nothing to deploy.

-- 1 · Tables. RLS on and no API grants: only the SECURITY DEFINER functions below read them.
create table if not exists public.sales_sku_period (
  company_id   text    not null references public.companies(id) on delete cascade,
  sku_code     text    not null,
  period_start date    not null,
  period_end   date    not null,
  rows         integer not null,
  amounts_enc  bytea   not null,
  primary key (company_id, sku_code, period_start, period_end)
);
create table if not exists public.sales_store_period (
  company_id   text    not null references public.companies(id) on delete cascade,
  store_code   text    not null,
  period_start date    not null,
  period_end   date    not null,
  rows         integer not null,
  pos_rows     integer not null,
  amounts_enc  bytea   not null,
  primary key (company_id, store_code, period_start, period_end)
);
create table if not exists public.sales_store_sku (
  company_id text    not null references public.companies(id) on delete cascade,
  store_code text    not null,
  sku_code   text    not null,
  rows       integer not null,
  primary key (company_id, store_code, sku_code)
);
-- Totals emptied by a delete are dropped right after; these keep that check cheap.
create index if not exists sales_sku_period_empty_idx on public.sales_sku_period (company_id) where rows <= 0;
create index if not exists sales_store_period_empty_idx on public.sales_store_period (company_id) where rows <= 0;
create index if not exists sales_store_sku_empty_idx on public.sales_store_sku (company_id) where rows <= 0;

alter table public.sales_sku_period enable row level security;
alter table public.sales_store_period enable row level security;
alter table public.sales_store_sku enable row level security;
revoke all on table public.sales_sku_period, public.sales_store_period, public.sales_store_sku from public, anon, authenticated, service_role;

comment on table public.sales_sku_period is 'Sales added up per SKU per period (s5). Kept by triggers on sales; amounts_enc = encrypted units|gross|net in s1 format.';
comment on table public.sales_store_period is 'Sales added up per store per period (s5). Kept by triggers on sales; pos_rows = rows with units > 0.';
comment on table public.sales_store_sku is 'Sales rows per store per SKU, all periods (s5). Kept by triggers on sales.';

-- 2 · Add two sealed totals (either may be null) and seal the sum.
create or replace function private.goldline_totals_add(p_a bytea, p_b bytea, p_key bytea)
returns bytea
language sql volatile set search_path = ''
as $$
  select private.goldline_sales_seal(
    coalesce(nullif(a[1], '')::numeric, 0) + coalesce(nullif(b[1], '')::numeric, 0),
    coalesce(nullif(a[2], '')::numeric, 0) + coalesce(nullif(b[2], '')::numeric, 0),
    coalesce(nullif(a[3], '')::integer, 0) + coalesce(nullif(b[3], '')::integer, 0),
    p_key)
  from (select pg_catalog.string_to_array(private.goldline_sales_open(p_a, p_key), '|') as a,
               pg_catalog.string_to_array(private.goldline_sales_open(p_b, p_key), '|') as b) x;
$$;
revoke all on function private.goldline_totals_add(bytea, bytea, bytea) from public, anon, authenticated, service_role;

-- 3 · Add the rows in pg_temp.sales_totals_delta (sgn +1 added, -1 removed) to the totals.
create or replace function private.sales_totals_merge()
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_key bytea := private.goldline_sales_key();
begin
  with d as materialized (
    select t.company_id, coalesce(t.store_code, '') as store_code, coalesce(t.sku_code, '') as sku_code,
           t.period_start, t.period_end, t.sgn,
           t.sgn * coalesce(nullif(x.f[3], '')::integer, 0) as units,
           t.sgn * coalesce(nullif(x.f[1], '')::numeric, 0) as gross,
           t.sgn * coalesce(nullif(x.f[2], '')::numeric, 0) as net,
           case when coalesce(nullif(x.f[3], '')::integer, 0) > 0 then t.sgn else 0 end as pos
    from pg_temp.sales_totals_delta t
    cross join lateral (select pg_catalog.string_to_array(private.goldline_sales_open(t.amounts_enc, v_key), '|') as f offset 0) x
  ),
  sku as (
    insert into public.sales_sku_period as t (company_id, sku_code, period_start, period_end, rows, amounts_enc)
    select company_id, sku_code, period_start, period_end, sum(sgn)::integer,
           private.goldline_sales_seal(sum(gross), sum(net), sum(units)::integer, v_key)
    from d group by 1, 2, 3, 4
    on conflict (company_id, sku_code, period_start, period_end) do update
      set rows = t.rows + excluded.rows,
          amounts_enc = private.goldline_totals_add(t.amounts_enc, excluded.amounts_enc, v_key)
  ),
  store as (
    insert into public.sales_store_period as t (company_id, store_code, period_start, period_end, rows, pos_rows, amounts_enc)
    select company_id, store_code, period_start, period_end, sum(sgn)::integer, sum(pos)::integer,
           private.goldline_sales_seal(sum(gross), sum(net), sum(units)::integer, v_key)
    from d group by 1, 2, 3, 4
    on conflict (company_id, store_code, period_start, period_end) do update
      set rows = t.rows + excluded.rows,
          pos_rows = t.pos_rows + excluded.pos_rows,
          amounts_enc = private.goldline_totals_add(t.amounts_enc, excluded.amounts_enc, v_key)
  )
  insert into public.sales_store_sku as t (company_id, store_code, sku_code, rows)
  select company_id, store_code, sku_code, sum(sgn)::integer from d group by 1, 2, 3
  on conflict (company_id, store_code, sku_code) do update set rows = t.rows + excluded.rows;

  -- A total whose rows are all gone goes too (its figures are 0 by then).
  delete from public.sales_sku_period where rows <= 0;
  delete from public.sales_store_period where rows <= 0;
  delete from public.sales_store_sku where rows <= 0;
end;
$$;
revoke all on function private.sales_totals_merge() from public, anon, authenticated, service_role;

-- 4 · Statement triggers on sales. One function for insert / update / delete; each branch
-- reads only the transition tables its trigger declares (plpgsql plans a statement when it
-- first runs, so the other branch's table never has to exist).
create or replace function private.sales_totals_apply()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  create temp table if not exists sales_totals_delta (
    company_id text, store_code text, sku_code text, period_start date, period_end date, sgn integer, amounts_enc bytea
  ) on commit delete rows;
  truncate pg_temp.sales_totals_delta;
  if tg_op in ('INSERT', 'UPDATE') then
    insert into pg_temp.sales_totals_delta
    select n.company_id, n.store_code, n.sku_code, n.period_start, n.period_end, 1, n.amounts_enc from new_rows n;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    insert into pg_temp.sales_totals_delta
    select o.company_id, o.store_code, o.sku_code, o.period_start, o.period_end, -1, o.amounts_enc from old_rows o;
  end if;
  perform private.sales_totals_merge();
  return null;
end;
$$;
revoke all on function private.sales_totals_apply() from public, anon, authenticated, service_role;

create or replace function private.sales_totals_truncate()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  truncate public.sales_sku_period, public.sales_store_period, public.sales_store_sku;
  return null;
end;
$$;
revoke all on function private.sales_totals_truncate() from public, anon, authenticated, service_role;

drop trigger if exists sales_totals_ins on public.sales;
drop trigger if exists sales_totals_upd on public.sales;
drop trigger if exists sales_totals_del on public.sales;
drop trigger if exists sales_totals_trunc on public.sales;
create trigger sales_totals_ins after insert on public.sales
  referencing new table as new_rows for each statement execute function private.sales_totals_apply();
create trigger sales_totals_upd after update on public.sales
  referencing old table as old_rows new table as new_rows for each statement execute function private.sales_totals_apply();
create trigger sales_totals_del after delete on public.sales
  referencing old table as old_rows for each statement execute function private.sales_totals_apply();
create trigger sales_totals_trunc after truncate on public.sales
  for each statement execute function private.sales_totals_truncate();

-- 5 · Rebuild one company's totals from sales (backfill, repair). Holds off sales writes
-- (share lock) so a concurrent upload can't land half in, half out.
create or replace function private.rebuild_sales_totals(p_company text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  lock table public.sales in share mode;
  delete from public.sales_sku_period where company_id = p_company;
  delete from public.sales_store_period where company_id = p_company;
  delete from public.sales_store_sku where company_id = p_company;
  create temp table if not exists sales_totals_delta (
    company_id text, store_code text, sku_code text, period_start date, period_end date, sgn integer, amounts_enc bytea
  ) on commit delete rows;
  truncate pg_temp.sales_totals_delta;
  insert into pg_temp.sales_totals_delta
  select s.company_id, s.store_code, s.sku_code, s.period_start, s.period_end, 1, s.amounts_enc
  from public.sales s where s.company_id = p_company;
  perform private.sales_totals_merge();
  truncate pg_temp.sales_totals_delta;
end;
$$;
revoke all on function private.rebuild_sales_totals(text) from public, anon, authenticated, service_role;

-- 6 · Drift check: the totals against a fresh pass over sales. All zeros = in step.
create or replace function private.sales_totals_drift(p_company text)
returns table(totals text, missing bigint, extra bigint, different bigint)
language sql stable security definer set search_path = ''
as $$
  with key as materialized (select private.goldline_sales_key() as k),
  d as materialized (
    select coalesce(s.store_code, '') as store_code, coalesce(s.sku_code, '') as sku_code, s.period_start, s.period_end,
           coalesce(nullif(x.f[3], '')::integer, 0) as units,
           coalesce(nullif(x.f[1], '')::numeric, 0) as gross,
           coalesce(nullif(x.f[2], '')::numeric, 0) as net
    from public.sales s cross join key
    cross join lateral (select pg_catalog.string_to_array(private.goldline_sales_open(s.amounts_enc, key.k), '|') as f offset 0) x
    where s.company_id = p_company
  ),
  fresh_sku as (
    select sku_code, period_start, period_end, count(*) as rows, sum(units) as units, sum(gross) as gross, sum(net) as net
    from d group by 1, 2, 3
  ),
  kept_sku as (
    select t.sku_code, t.period_start, t.period_end, t.rows::bigint as rows,
           nullif(x.f[3], '')::bigint as units, nullif(x.f[1], '')::numeric as gross, nullif(x.f[2], '')::numeric as net
    from public.sales_sku_period t cross join key
    cross join lateral (select pg_catalog.string_to_array(private.goldline_sales_open(t.amounts_enc, key.k), '|') as f offset 0) x
    where t.company_id = p_company
  ),
  fresh_store as (
    select store_code, period_start, period_end, count(*) as rows, count(*) filter (where units > 0) as pos_rows,
           sum(units) as units, sum(gross) as gross, sum(net) as net
    from d group by 1, 2, 3
  ),
  kept_store as (
    select t.store_code, t.period_start, t.period_end, t.rows::bigint as rows, t.pos_rows::bigint as pos_rows,
           nullif(x.f[3], '')::bigint as units, nullif(x.f[1], '')::numeric as gross, nullif(x.f[2], '')::numeric as net
    from public.sales_store_period t cross join key
    cross join lateral (select pg_catalog.string_to_array(private.goldline_sales_open(t.amounts_enc, key.k), '|') as f offset 0) x
    where t.company_id = p_company
  ),
  fresh_pair as (select store_code, sku_code, count(*) as rows from d group by 1, 2),
  kept_pair as (select store_code, sku_code, rows::bigint as rows from public.sales_store_sku where company_id = p_company)
  select 'sales_sku_period',
         count(*) filter (where k.sku_code is null),
         count(*) filter (where f.sku_code is null),
         count(*) filter (where f.sku_code is not null and k.sku_code is not null
                          and (f.rows, f.units, f.gross, f.net) is distinct from (k.rows, k.units, k.gross, k.net))
  from fresh_sku f full join kept_sku k using (sku_code, period_start, period_end)
  union all
  select 'sales_store_period',
         count(*) filter (where k.store_code is null),
         count(*) filter (where f.store_code is null),
         count(*) filter (where f.store_code is not null and k.store_code is not null
                          and (f.rows, f.pos_rows, f.units, f.gross, f.net) is distinct from (k.rows, k.pos_rows, k.units, k.gross, k.net))
  from fresh_store f full join kept_store k using (store_code, period_start, period_end)
  union all
  select 'sales_store_sku',
         count(*) filter (where k.store_code is null),
         count(*) filter (where f.store_code is null),
         count(*) filter (where f.store_code is not null and k.store_code is not null and f.rows <> k.rows)
  from fresh_pair f full join kept_pair k using (store_code, sku_code);
$$;
revoke all on function private.sales_totals_drift(text) from public, anon, authenticated, service_role;

-- 7 · The readers, now on the totals. Same signatures and output as s3.

-- Totals per store and per SKU (Stores page, SKU linking, Watsons, SKU re-matching).
create or replace function public.sales_rollup(p_company text)
returns jsonb
language sql stable security definer set search_path = 'public', 'pg_temp'
as $$
  with key as materialized (select private.goldline_sales_key() as k),
  st as (
    select t.store_code,
           coalesce(sum(nullif(x.f[3], '')::integer), 0) as units,
           coalesce(sum(nullif(x.f[1], '')::numeric), 0) as gross,
           coalesce(sum(nullif(x.f[2], '')::numeric), 0) as net,
           min(t.period_start) as period_start,
           max(t.period_end) as period_end
    from sales_store_period t cross join key
    cross join lateral (select pg_catalog.string_to_array(private.goldline_sales_open(t.amounts_enc, key.k), '|') as f offset 0) x
    where t.company_id = p_company
    group by t.store_code
  ),
  skus as (
    select store_code, count(*) filter (where sku_code <> '') as sku_count
    from sales_store_sku where company_id = p_company group by store_code
  ),
  sk as (
    select t.sku_code,
           coalesce(sum(nullif(x.f[3], '')::integer), 0) as units,
           coalesce(sum(nullif(x.f[1], '')::numeric), 0) as gross,
           coalesce(sum(nullif(x.f[2], '')::numeric), 0) as net
    from sales_sku_period t cross join key
    cross join lateral (select pg_catalog.string_to_array(private.goldline_sales_open(t.amounts_enc, key.k), '|') as f offset 0) x
    where t.company_id = p_company
    group by t.sku_code
  )
  select jsonb_build_object(
    'byStore', coalesce((
      select jsonb_agg(jsonb_build_object('store_code', st.store_code, 'units', st.units, 'gross', st.gross, 'net', st.net,
                                          'sku_count', coalesce(skus.sku_count, 0)))
      from st left join skus using (store_code)), '[]'::jsonb),
    'bySku', coalesce((
      select jsonb_agg(jsonb_build_object('sku_code', sku_code, 'units', units, 'gross', gross, 'net', net)) from sk), '[]'::jsonb),
    'periodStart', (select min(period_start) from st),
    'periodEnd', (select max(period_end) from st)
  );
$$;
revoke all on function public.sales_rollup(text) from public, anon, authenticated;
grant execute on function public.sales_rollup(text) to service_role;

-- One period's totals per SKU (Stores page). Only the SKU totals, no decrypt of sales.
create or replace function public.sales_by_sku(p_company text, p_start date, p_end date)
returns table(sku_code text, units bigint, gross numeric, net numeric)
language sql stable security definer set search_path = 'public', 'pg_temp'
as $$
  with key as materialized (select private.goldline_sales_key() as k)
  select t.sku_code,
         coalesce(sum(nullif(x.f[3], '')::integer), 0),
         coalesce(sum(nullif(x.f[1], '')::numeric), 0),
         coalesce(sum(nullif(x.f[2], '')::numeric), 0)
  from sales_sku_period t cross join key
  cross join lateral (select pg_catalog.string_to_array(private.goldline_sales_open(t.amounts_enc, key.k), '|') as f offset 0) x
  where t.company_id = p_company and t.period_start = p_start and t.period_end = p_end
  group by t.sku_code;
$$;
revoke all on function public.sales_by_sku(text, date, date) from public, anon, authenticated;
grant execute on function public.sales_by_sku(text, date, date) to service_role;

-- Which stores count (F2): sold in the latest 3 loaded months unless switched. Reads only
-- pos_rows, so nothing is decrypted.
create or replace function public.store_scope(p_company text)
returns table(store_code text, last_sale_month date, sold_recently boolean, override boolean, in_scope boolean)
language sql stable security definer set search_path = 'public', 'pg_temp'
as $$
  with sp as (
    select t.store_code, date_trunc('month', t.period_start)::date as m, t.pos_rows
    from sales_store_period t where t.company_id = p_company
  ),
  months as (select distinct m from sp order by 1 desc limit 3),
  per as (
    select sp.store_code,
           max(sp.m) filter (where sp.pos_rows > 0) as last_sale_month,
           bool_or(sp.pos_rows > 0 and sp.m in (select m from months)) as sold_recently
    from sp group by sp.store_code
  )
  select st.store_code,
         per.last_sale_month,
         coalesce(per.sold_recently, false),
         st.in_scope,
         coalesce(st.in_scope, coalesce(per.sold_recently, false))
  from stores st
  left join per on per.store_code = st.store_code
  where st.company_id = p_company;
$$;
revoke all on function public.store_scope(text) from public, anon, authenticated;
grant execute on function public.store_scope(text) to service_role;

-- Units per requested month, and how many are on SKUs not linked to a product (F10).
create or replace function public.forecast_months(p_company text, p_months date[])
returns table(month date, loaded boolean, units bigint, unlinked_units bigint)
language sql stable security definer set search_path = 'public', 'pg_temp'
as $$
  with req as (select distinct date_trunc('month', m)::date as m from unnest(p_months) m),
  linked as (
    select distinct btrim(sku_code) as sku_code from products
    where company_id = p_company and nullif(btrim(sku_code), '') is not null
  ),
  key as materialized (select private.goldline_sales_key() as k),
  d as (
    select date_trunc('month', t.period_start)::date as m, t.sku_code, t.rows,
           nullif(x.f[3], '')::integer as units
    from sales_sku_period t cross join key
    cross join lateral (select pg_catalog.string_to_array(private.goldline_sales_open(t.amounts_enc, key.k), '|') as f offset 0) x
    where t.company_id = p_company
      and date_trunc('month', t.period_start)::date in (select m from req)
      and t.period_start = date_trunc('month', t.period_start)::date
      and t.period_end = (date_trunc('month', t.period_start) + interval '1 month - 1 day')::date
  ),
  s as (
    select d.m, d.rows, d.units, (l.sku_code is null) as unlinked
    from d left join linked l on l.sku_code = d.sku_code
  )
  select req.m,
         coalesce(sum(s.rows), 0) > 0,
         coalesce(sum(s.units), 0)::bigint,
         coalesce(sum(s.units) filter (where s.unlinked), 0)::bigint
  from req left join s on s.m = req.m
  group by req.m
  order by req.m;
$$;
revoke all on function public.forecast_months(text, date[]) from public, anon, authenticated;
grant execute on function public.forecast_months(text, date[]) to service_role;

-- Each SKU's months: [month, units, stores] (SKU activity). A SKU-period total counts one
-- row per store (sales is unique per store/SKU/period), so stores = rows when the SKU has
-- one period in that month; a month split into several periods counts its distinct
-- stores from sales (plain columns, nothing decrypted).
create or replace function public.sku_months(p_company text)
returns jsonb
language sql stable security definer set search_path = 'public', 'pg_temp'
as $$
  with key as materialized (select private.goldline_sales_key() as k),
  sm as (
    select t.sku_code, date_trunc('month', t.period_start)::date as m,
           coalesce(sum(nullif(x.f[3], '')::integer), 0)::bigint as units,
           sum(t.rows)::int as rows,
           count(*) as periods
    from sales_sku_period t cross join key
    cross join lateral (select pg_catalog.string_to_array(private.goldline_sales_open(t.amounts_enc, key.k), '|') as f offset 0) x
    where t.company_id = p_company
    group by 1, 2
  ),
  split as (
    select s.sku_code, date_trunc('month', s.period_start)::date as m, count(distinct s.store_code)::int as stores
    from sales s
    join sm on sm.periods > 1 and sm.sku_code = s.sku_code
           and s.period_start >= sm.m and s.period_start < (sm.m + interval '1 month')
    where s.company_id = p_company
    group by 1, 2
  )
  select coalesce(jsonb_object_agg(sku_code, months), '{}'::jsonb)
  from (
    select sm.sku_code,
           jsonb_agg(jsonb_build_array(sm.m, sm.units, coalesce(split.stores, sm.rows)) order by sm.m) as months
    from sm left join split on split.sku_code = sm.sku_code and split.m = sm.m
    group by sm.sku_code
  ) y;
$$;
revoke all on function public.sku_months(text) from public, anon, authenticated;
grant execute on function public.sku_months(text) to service_role;

-- 8 · Backfill every company's totals.
do $$
declare c text;
begin
  for c in select distinct company_id from public.sales loop
    perform private.rebuild_sales_totals(c);
  end loop;
end $$;
