-- S3 · Goldline sales units encrypted at rest too (Nichido project). Needs s1.
-- Run on Nichido STAGING first; PROD only after review. Safe to re-run until s2.
--
-- What it does: sales.amounts_enc grows from 'gross|net' to 'gross|net|units', so units
-- join the peso figures in the one per-row ciphertext (same Vault key, same AES-256-CBC,
-- random IV per row). A reader still decrypts each row once and splits it, so the money
-- rollups cost the same; readers that used only plain units now pay one decrypt per row
-- they touch (all 472k rows on Staging: ~1 s).
--
-- Every reader of units moves to the s1 pattern and becomes SECURITY DEFINER (the
-- private schema is closed to API roles): sales_rollup, sales_by_sku, store_scope,
-- forecast_months, forecast_history, forecast_item_history, sku_months. The app's three
-- direct reads of sales.units (checks, board, product page) go through the new
-- sales_units(). sales_months reads periods only and is unchanged.
--
-- Rollout: this file → deploy the app (reads units through sales_units) →
-- s2_sales_drop_plaintext.sql (drops gross_retail, net_of_vat and units). Apply this and
-- deploy together: from here upsert_sales leaves the plain units column empty, which an
-- older build would read as 0 for any month uploaded in between.

-- 1 · Seal three figures. A null figure is an empty part; null only when all are null.
create or replace function private.goldline_sales_seal(p_gross numeric, p_net numeric, p_units integer, p_key bytea)
returns bytea
language plpgsql volatile set search_path = ''
as $$
declare v_iv bytea;
begin
  if p_gross is null and p_net is null and p_units is null then return null; end if;
  v_iv := extensions.gen_random_bytes(16);
  return v_iv || extensions.encrypt_iv(
    convert_to(coalesce(p_gross::text, '') || '|' || coalesce(p_net::text, '') || '|' || coalesce(p_units::text, ''), 'utf8'),
    p_key, v_iv, 'aes-cbc/pad:pkcs');
end;
$$;
revoke all on function private.goldline_sales_seal(numeric, numeric, integer, bytea) from public, anon, authenticated, service_role;

comment on column public.sales.amounts_enc is
  'Encrypted gross_retail|net_of_vat|units (s1, s3). Read through sales_rollup / sales_by_sku / sales_units and the forecast functions, write through upsert_sales.';

-- 2 · Until s2: plain values an older deployment writes are sealed on the way in. On an
-- UPDATE only when a plain figure actually changed: upsert_sales rewrites amounts_enc on a
-- conflicting row whose stale plain figures are still there (s1 re-sealed those over the
-- new ciphertext).
create or replace function private.goldline_sales_seal_legacy()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.gross_retail is null and new.net_of_vat is null and new.units is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.gross_retail is not distinct from old.gross_retail
       and new.net_of_vat is not distinct from old.net_of_vat
       and new.units is not distinct from old.units then
      return new;
    end if;
  end if;
  new.amounts_enc := private.goldline_sales_seal(new.gross_retail, new.net_of_vat, new.units, private.goldline_sales_key());
  return new;
end;
$$;
revoke all on function private.goldline_sales_seal_legacy() from public, anon, authenticated, service_role;

-- 3 · Re-seal every row still on the 2-part format. Gross and net come from the existing
-- ciphertext, NOT the plain columns: rows written by upsert_sales since s1 hold their
-- money only in amounts_enc (80,369 on Staging, plain gross/net empty). Units come from
-- the plain column. A row with no ciphertext yet is sealed from its plain values. Skipped
-- once s2 has dropped the plain units. The trigger is off for the pass so it doesn't
-- re-seal rows with a per-row Vault read.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'sales' and column_name = 'units') then
    alter table public.sales disable trigger sales_seal_legacy;
    execute $u$
      with key as materialized (select private.goldline_sales_key() as k),
      d as materialized (
        select s.id, s.gross_retail, s.net_of_vat, s.units,
               private.goldline_sales_open(s.amounts_enc, key.k) as p
        from public.sales s cross join key
      ),
      todo as materialized (
        select id, units,
               case when p is null then gross_retail else nullif(pg_catalog.split_part(p, '|', 1), '')::numeric end as gross,
               case when p is null then net_of_vat else nullif(pg_catalog.split_part(p, '|', 2), '')::numeric end as net
        from d
        where case when p is null
                   then gross_retail is not null or net_of_vat is not null or units is not null
                   else pg_catalog.array_length(pg_catalog.string_to_array(p, '|'), 1) < 3
              end
      )
      update public.sales s
         set amounts_enc = private.goldline_sales_seal(t.gross, t.net, t.units, key.k)
        from todo t cross join key
       where s.id = t.id
    $u$;
    alter table public.sales enable trigger sales_seal_legacy;
  end if;
end $$;

-- 4 · Writes: units sealed with the money; the plain units column is no longer written.
create or replace function public.upsert_sales(p_company text, p_rows jsonb)
returns integer
language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  v_key   bytea := private.goldline_sales_key();
  v_count integer;
begin
  insert into sales (company_id, store_code, sku_code, period_start, period_end, amounts_enc, source_upload_id)
  select p_company, r.store_code, r.sku_code, r.period_start, r.period_end,
         private.goldline_sales_seal(r.gross_retail, r.net_of_vat, r.units, v_key), r.source_upload_id
  from jsonb_to_recordset(p_rows) as r(
    store_code text, sku_code text, period_start date, period_end date,
    units integer, gross_retail numeric, net_of_vat numeric, source_upload_id uuid)
  on conflict (company_id, store_code, sku_code, period_start, period_end) do update set
    amounts_enc = excluded.amounts_enc, source_upload_id = excluded.source_upload_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.upsert_sales(text, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_sales(text, jsonb) to service_role;

-- Every caller now passes units; the 2-part sealer goes.
drop function if exists private.goldline_sales_seal(numeric, numeric, bytea);

-- 5 · Reads. Same signatures and output as before. As in s1: the key is read once in a
-- MATERIALIZED CTE, rows are filtered before they are decrypted, and each row is decrypted
-- once into `p` before it is split. Units are part 3.
create or replace function public.sales_rollup(p_company text)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  with key as materialized (select private.goldline_sales_key() as k),
  d as materialized (
    select s.store_code, s.sku_code, private.goldline_sales_open(s.amounts_enc, k.k) as p
    from sales s cross join key k
    where s.company_id = p_company
  ),
  v as materialized (
    select store_code, sku_code,
           nullif(split_part(p, '|', 3), '')::integer as units,
           nullif(split_part(p, '|', 1), '')::numeric as gross_retail,
           nullif(split_part(p, '|', 2), '')::numeric as net_of_vat
    from d
  )
  select jsonb_build_object(
    'byStore', coalesce((
      select jsonb_agg(jsonb_build_object('store_code', store_code, 'units', units, 'gross', gross, 'net', net, 'sku_count', sku_count))
      from (
        select store_code,
               coalesce(sum(units), 0) as units,
               coalesce(sum(gross_retail), 0) as gross,
               coalesce(sum(net_of_vat), 0) as net,
               count(distinct sku_code) filter (where sku_code is not null and sku_code <> '') as sku_count
        from v group by store_code
      ) s), '[]'::jsonb),
    'bySku', coalesce((
      select jsonb_agg(jsonb_build_object('sku_code', sku_code, 'units', units, 'gross', gross, 'net', net))
      from (
        select coalesce(sku_code, '') as sku_code,
               coalesce(sum(units), 0) as units,
               coalesce(sum(gross_retail), 0) as gross,
               coalesce(sum(net_of_vat), 0) as net
        from v group by coalesce(sku_code, '')
      ) k), '[]'::jsonb),
    'periodStart', (select min(period_start) from sales where company_id = p_company),
    'periodEnd', (select max(period_end) from sales where company_id = p_company)
  );
$$;
revoke all on function public.sales_rollup(text) from public, anon, authenticated;
grant execute on function public.sales_rollup(text) to service_role;

create or replace function public.sales_by_sku(p_company text, p_start date, p_end date)
returns table (sku_code text, units bigint, gross numeric, net numeric)
language sql stable security definer set search_path = public, pg_temp
as $$
  with key as materialized (select private.goldline_sales_key() as k),
  d as materialized (
    select s.sku_code, private.goldline_sales_open(s.amounts_enc, k.k) as p
    from sales s cross join key k
    where s.company_id = p_company and s.period_start = p_start and s.period_end = p_end
  )
  select coalesce(sku_code, ''),
         coalesce(sum(nullif(split_part(p, '|', 3), '')::integer), 0),
         coalesce(sum(nullif(split_part(p, '|', 1), '')::numeric), 0),
         coalesce(sum(nullif(split_part(p, '|', 2), '')::numeric), 0)
  from d
  group by coalesce(sku_code, '');
$$;
revoke all on function public.sales_by_sku(text, date, date) from public, anon, authenticated;
grant execute on function public.sales_by_sku(text, date, date) to service_role;

-- Store scope (f2_store_scope.sql): every row of the company, since "last month with any
-- units sold" looks at all of them.
create or replace function public.store_scope(p_company text)
returns table (store_code text, last_sale_month date, sold_recently boolean, override boolean, in_scope boolean)
language sql stable security definer set search_path = public, pg_temp
as $$
  with months as (
    select distinct date_trunc('month', period_start)::date as m
    from sales where company_id = p_company
    order by 1 desc limit 3
  ),
  key as materialized (select private.goldline_sales_key() as k),
  d as materialized (
    select s.store_code, date_trunc('month', s.period_start)::date as m, private.goldline_sales_open(s.amounts_enc, k.k) as p
    from sales s cross join key k
    where s.company_id = p_company
  ),
  v as materialized (
    select store_code, m, coalesce(nullif(split_part(p, '|', 3), '')::integer, 0) as units from d
  ),
  per as (
    select v.store_code,
           max(v.m) filter (where v.units > 0) as last_sale_month,
           bool_or(v.units > 0 and v.m in (select m from months)) as sold_recently
    from v
    group by v.store_code
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

-- Forecast (p3_forecast.sql): whole-month rows of the requested months only.
create or replace function public.forecast_months(p_company text, p_months date[])
returns table (month date, loaded boolean, units bigint, unlinked_units bigint)
language sql stable security definer set search_path = public, pg_temp
as $$
  with req as (select distinct date_trunc('month', m)::date as m from unnest(p_months) m),
  linked as (
    select distinct btrim(sku_code) as sku_code from products
    where company_id = p_company and nullif(btrim(sku_code), '') is not null
  ),
  key as materialized (select private.goldline_sales_key() as k),
  d as materialized (
    select date_trunc('month', s.period_start)::date as m, s.sku_code, private.goldline_sales_open(s.amounts_enc, k.k) as p
    from sales s cross join key k
    where s.company_id = p_company
      and date_trunc('month', s.period_start)::date in (select m from req)
      and s.period_start = date_trunc('month', s.period_start)::date
      and s.period_end = (date_trunc('month', s.period_start) + interval '1 month - 1 day')::date
  ),
  s as (
    select d.m, nullif(split_part(d.p, '|', 3), '')::integer as units, (l.sku_code is null) as unlinked
    from d
    left join linked l on l.sku_code = d.sku_code
  )
  select req.m,
         count(s.m) > 0,
         coalesce(sum(s.units), 0)::bigint,
         coalesce(sum(s.units) filter (where s.unlinked), 0)::bigint
  from req left join s on s.m = req.m
  group by req.m
  order by req.m;
$$;
revoke all on function public.forecast_months(text, date[]) from public, anon, authenticated;
grant execute on function public.forecast_months(text, date[]) to service_role;

create or replace function public.forecast_history(p_company text, p_months date[], p_stores text[] default null)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  with req as (
    select date_trunc('month', m)::date as m, ord::int as ord
    from unnest(p_months) with ordinality as t(m, ord)
  ),
  items as (
    select btrim(sku_code) as sku_code, item_code from products
    where company_id = p_company and nullif(btrim(sku_code), '') is not null
  ),
  key as materialized (select private.goldline_sales_key() as k),
  d as materialized (
    select s.store_code, s.sku_code, date_trunc('month', s.period_start)::date as m,
           private.goldline_sales_open(s.amounts_enc, k.k) as p
    from sales s cross join key k
    where s.company_id = p_company
      and s.sku_code in (select sku_code from items)
      and (p_stores is null or s.store_code = any(p_stores))
      and date_trunc('month', s.period_start)::date in (select m from req)
      and s.period_start = date_trunc('month', s.period_start)::date
      and s.period_end = (date_trunc('month', s.period_start) + interval '1 month - 1 day')::date
  ),
  per as (
    select d.store_code, i.item_code, d.m, sum(coalesce(nullif(split_part(d.p, '|', 3), '')::integer, 0))::int as units
    from d
    join items i on i.sku_code = d.sku_code
    group by 1, 2, 3
  ),
  pairs as (select distinct per.store_code, per.item_code from per),
  lines as (
    select p.store_code, p.item_code,
           jsonb_agg(coalesce(per.units, 0) order by req.ord) as units
    from pairs p
    cross join req
    left join per on per.store_code = p.store_code and per.item_code = p.item_code and per.m = req.m
    group by p.store_code, p.item_code
    having sum(coalesce(per.units, 0)) <> 0
  ),
  by_store as (
    select store_code, jsonb_object_agg(item_code, units) as items from lines group by store_code
  )
  select coalesce(jsonb_object_agg(store_code, items), '{}'::jsonb) from by_store;
$$;
revoke all on function public.forecast_history(text, date[], text[]) from public, anon, authenticated;
grant execute on function public.forecast_history(text, date[], text[]) to service_role;

-- One product's year (p3c_item_history.sql, F11 restock).
create or replace function public.forecast_item_history(p_company text, p_item text, p_months date[], p_stores text[] default null)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  with req as (
    select date_trunc('month', m)::date as m, ord::int as ord
    from unnest(p_months) with ordinality as t(m, ord)
  ),
  skus as (
    select distinct btrim(sku_code) as sku_code from products
    where company_id = p_company and item_code = p_item and nullif(btrim(sku_code), '') is not null
  ),
  key as materialized (select private.goldline_sales_key() as k),
  d as materialized (
    select s.store_code, date_trunc('month', s.period_start)::date as m, private.goldline_sales_open(s.amounts_enc, k.k) as p
    from sales s cross join key k
    where s.company_id = p_company
      and s.sku_code in (select sku_code from skus)
      and (p_stores is null or s.store_code = any(p_stores))
      and date_trunc('month', s.period_start)::date in (select m from req)
      and s.period_start = date_trunc('month', s.period_start)::date
      and s.period_end = (date_trunc('month', s.period_start) + interval '1 month - 1 day')::date
  ),
  per as (
    select store_code, m, sum(coalesce(nullif(split_part(p, '|', 3), '')::integer, 0))::int as units
    from d group by 1, 2
  ),
  stores as (select distinct store_code from per),
  lines as (
    select st.store_code, jsonb_agg(coalesce(per.units, 0) order by req.ord) as units
    from stores st
    cross join req
    left join per on per.store_code = st.store_code and per.m = req.m
    group by st.store_code
    having sum(coalesce(per.units, 0)) <> 0
  )
  select coalesce(jsonb_object_agg(store_code, units), '{}'::jsonb) from lines;
$$;
revoke all on function public.forecast_item_history(text, text, date[], text[]) from public, anon, authenticated;
grant execute on function public.forecast_item_history(text, text, date[], text[]) to service_role;

-- Per SKU, per month: units and stores selling (f2f_sku_months.sql, SKU linking's
-- Watsons-files-by-month view). Same output as f2f.
create or replace function public.sku_months(p_company text)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  with key as materialized (select private.goldline_sales_key() as k),
  d as materialized (
    select s.sku_code, s.store_code, date_trunc('month', s.period_start)::date as m,
           private.goldline_sales_open(s.amounts_enc, k.k) as p
    from sales s cross join key k
    where s.company_id = p_company
  )
  select coalesce(jsonb_object_agg(sku_code, months), '{}'::jsonb)
  from (
    select sku_code, jsonb_agg(jsonb_build_array(m, units, stores) order by m) as months
    from (
      select sku_code, m,
             coalesce(sum(nullif(split_part(p, '|', 3), '')::integer), 0)::bigint as units,
             count(distinct store_code)::int as stores
      from d group by 1, 2
    ) x group by sku_code
  ) y;
$$;
revoke all on function public.sku_months(text) from public, anon, authenticated;
grant execute on function public.sku_months(text) to service_role;

-- 6 · Sale rows with their units, for the app's row-level reads (src/goldline-checks-data.ts,
-- goldline-board-data.ts, goldline-product-data.ts). Every filter is optional:
--   p_from_start  period_start >= it      p_stores  only these stores
--   p_from_end    period_end >= it        p_skus    only these SKUs
-- One jsonb array of {store_code, sku_code, period_start, period_end, units}, not rows:
-- PostgREST caps a set at 1000 rows, and paging would decrypt everything again per page.
create or replace function public.sales_units(
  p_company text, p_from_start date default null, p_from_end date default null,
  p_stores text[] default null, p_skus text[] default null)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  with key as materialized (select private.goldline_sales_key() as k),
  d as materialized (
    select s.id, s.store_code, s.sku_code, s.period_start, s.period_end, private.goldline_sales_open(s.amounts_enc, k.k) as p
    from sales s cross join key k
    where s.company_id = p_company
      and (p_from_start is null or s.period_start >= p_from_start)
      and (p_from_end is null or s.period_end >= p_from_end)
      and (p_stores is null or s.store_code = any(p_stores))
      and (p_skus is null or s.sku_code = any(p_skus))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'store_code', store_code, 'sku_code', sku_code, 'period_start', period_start, 'period_end', period_end,
           'units', nullif(split_part(p, '|', 3), '')::integer) order by id), '[]'::jsonb)
  from d;
$$;
revoke all on function public.sales_units(text, date, date, text[], text[]) from public, anon, authenticated;
grant execute on function public.sales_units(text, date, date, text[], text[]) to service_role;
