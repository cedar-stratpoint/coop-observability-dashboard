-- F10 · Forecast inputs (Nichido project). Additive and safe to re-run.
-- Run on Nichido STAGING (Nichido-Supabase-Staging) first; PROD after review.
-- Once s3_sales_units_encryption.sql is applied, re-run s3 after this file: s3 holds the
-- decrypting versions of the sales readers below (units are encrypted, then dropped by s2).
--
-- Decided Oct 26 (meeting) and Oct 27:
--   • A restock run covers the next `window_months` calendar months after the run date
--     (an Oct 31 run covers Nov to Jan; a Nov 15 run covers Dec to Feb), from each store's
--     own sales in last year's same months. No season multipliers, no store profiles.
--   • Safety stock = last year's final `safety_months` of the window (default: 1 month).
--   • A month with no POS Sales Data holds the line ("check data first"); there is no
--     fallback formula. The holds themselves are worked out in src/goldline-forecast.ts.
--
--   forecast_settings   window and safety, per company (lead times stay in supply_settings).
--   forecast_months()   per requested month: loaded or not, total and unlinked units.
--   forecast_history()  per store × item: units in each requested month, through the
--                       Watsons SKU link (products.sku_code). Whole-month rows only, the
--                       same rule as the form-vs-sales check (src/goldline-checks-data.ts).

create table if not exists public.forecast_settings (
  company_id     text primary key references public.companies(id) on delete cascade,
  window_months  integer not null default 3 check (window_months between 1 and 6),
  safety_months  integer not null default 1,
  updated_by     text,
  updated_at     timestamptz not null default now(),
  check (safety_months between 0 and window_months)
);
alter table public.forecast_settings enable row level security;
revoke all on public.forecast_settings from anon, authenticated;
insert into public.forecast_settings (company_id) values ('goldline') on conflict (company_id) do nothing;

-- Whole-month sales rows for the requested months (first day of each).
create or replace function public.forecast_months(p_company text, p_months date[])
returns table (month date, loaded boolean, units bigint, unlinked_units bigint)
language sql stable security invoker set search_path = public
as $$
  with req as (select distinct date_trunc('month', m)::date as m from unnest(p_months) m),
  linked as (
    select distinct btrim(sku_code) as sku_code from products
    where company_id = p_company and nullif(btrim(sku_code), '') is not null
  ),
  s as (
    select date_trunc('month', s.period_start)::date as m, s.units, (l.sku_code is null) as unlinked
    from sales s
    left join linked l on l.sku_code = s.sku_code
    where s.company_id = p_company
      and date_trunc('month', s.period_start)::date in (select m from req)
      and s.period_start = date_trunc('month', s.period_start)::date
      and s.period_end = (date_trunc('month', s.period_start) + interval '1 month - 1 day')::date
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

-- Units per store × item, one array slot per requested month (in the order given):
-- {"<store>": {"<item>": [u1, u2, u3]}, …}. One jsonb value, not rows: ~42k pairs for a
-- 3-month window would take ~42 PostgREST pages, each re-running the whole function.
-- A store × item with no row in a month gets 0 there; whether the month was loaded at
-- all comes from forecast_months. Only pairs with nonzero units are returned.
-- p_stores narrows to a store-scoped role's stores (null = every store).
drop function if exists public.forecast_history(text, date[]);
create or replace function public.forecast_history(p_company text, p_months date[], p_stores text[] default null)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  with req as (
    select date_trunc('month', m)::date as m, ord::int as ord
    from unnest(p_months) with ordinality as t(m, ord)
  ),
  items as (
    select btrim(sku_code) as sku_code, item_code from products
    where company_id = p_company and nullif(btrim(sku_code), '') is not null
  ),
  per as (
    select s.store_code, i.item_code, date_trunc('month', s.period_start)::date as m, sum(coalesce(s.units, 0))::int as units
    from sales s
    join items i on i.sku_code = s.sku_code
    where s.company_id = p_company
      and (p_stores is null or s.store_code = any(p_stores))
      and date_trunc('month', s.period_start)::date in (select m from req)
      and s.period_start = date_trunc('month', s.period_start)::date
      and s.period_end = (date_trunc('month', s.period_start) + interval '1 month - 1 day')::date
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
