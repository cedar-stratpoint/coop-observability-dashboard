-- F2f · Watsons SKUs month by month (Nichido project). Additive and safe to re-run.
-- Run on Nichido STAGING (Nichido-Supabase-Staging) first; PROD after review.
--
-- Oct 29: SKU linking shows which monthly Watsons files each SKU is in (a pointer on every
-- Watsons SKU, a month-tabs view of each file, a "Watsons files by month" summary). This
-- sums sales per SKU per month: units and how many stores. One jsonb value, so a client
-- read is never cut at PostgREST's row cap: {"<sku>": [["YYYY-MM-01", units, stores], ...]}.
-- Units only (plain); the encrypted money is not touched.

create or replace function public.sku_months(p_company text)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  select coalesce(jsonb_object_agg(sku_code, months), '{}'::jsonb)
  from (
    select sku_code, jsonb_agg(jsonb_build_array(m, units, stores) order by m) as months
    from (
      select sku_code, date_trunc('month', period_start)::date as m, coalesce(sum(units), 0)::bigint as units, count(distinct store_code)::int as stores
      from sales where company_id = p_company group by 1, 2
    ) x group by sku_code
  ) y;
$$;
revoke all on function public.sku_months(text) from public, anon, authenticated;
grant execute on function public.sku_months(text) to service_role;
