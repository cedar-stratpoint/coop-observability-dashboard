-- Restock · one product's year (Nichido project). Additive and safe to re-run.
-- Run on Nichido STAGING (Nichido-Supabase-Staging) first; PROD after review. Needs p3_forecast.sql.
--
-- Decided Oct 28: the Restock product page (/stock/restock/<item>) shows the product's last
-- 12 months of POS Sales Data, then the run's months forecast from last year's same months.
--
--   forecast_item_history()  forecast_history() for one item: units per store in each
--                            requested month, through the Watsons SKU link
--                            (products.sku_code), whole-month rows only. Same rules, so the
--                            page's numbers match the run's.

-- {"<store>": [u1, u2, …]}, one slot per requested month (in the order given). One jsonb
-- value, not rows: a year for ~300 stores would be ~3.6k rows. A store with no row in a
-- month gets 0 there; stores with no units at all are left out. p_stores narrows to a
-- store-scoped role's stores (null = every store).
create or replace function public.forecast_item_history(p_company text, p_item text, p_months date[], p_stores text[] default null)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  with req as (
    select date_trunc('month', m)::date as m, ord::int as ord
    from unnest(p_months) with ordinality as t(m, ord)
  ),
  skus as (
    select distinct btrim(sku_code) as sku_code from products
    where company_id = p_company and item_code = p_item and nullif(btrim(sku_code), '') is not null
  ),
  per as (
    select s.store_code, date_trunc('month', s.period_start)::date as m, sum(coalesce(s.units, 0))::int as units
    from sales s
    join skus k on k.sku_code = s.sku_code
    where s.company_id = p_company
      and (p_stores is null or s.store_code = any(p_stores))
      and date_trunc('month', s.period_start)::date in (select m from req)
      and s.period_start = date_trunc('month', s.period_start)::date
      and s.period_end = (date_trunc('month', s.period_start) + interval '1 month - 1 day')::date
    group by 1, 2
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
