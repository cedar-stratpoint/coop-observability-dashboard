-- F2h · Stores page month filter (Nichido project). Needs s5 (sales_store_period).
-- Run on Nichido STAGING first; PROD only after review. Safe to re-run. Additive: two
-- new read functions, no table or data change.
--
-- Why: an Overview trend bar opens /stores?month=YYYY-MM, so the leaderboard needs each
-- store's totals for one month. sales_rollup only gives all-time totals.
--
--   sales_by_store(company, start, end)  per store: units, gross, net, sku_count for the
--                                        periods inside [start, end]; reads the s5 totals
--                                        (~300 rows decrypted), SKU count from plain columns
--   sales_store_months(company)          the months with sales (for the month picker);
--                                        plain columns only, nothing decrypted

create or replace function public.sales_by_store(p_company text, p_start date, p_end date)
returns table(store_code text, units bigint, gross numeric, net numeric, sku_count bigint)
language sql stable security definer set search_path = 'public', 'pg_temp'
as $$
  with key as materialized (select private.goldline_sales_key() as k),
  st as (
    select t.store_code,
           coalesce(sum(nullif(x.f[3], '')::integer), 0)::bigint as units,
           coalesce(sum(nullif(x.f[1], '')::numeric), 0) as gross,
           coalesce(sum(nullif(x.f[2], '')::numeric), 0) as net
    from sales_store_period t cross join key
    cross join lateral (select pg_catalog.string_to_array(private.goldline_sales_open(t.amounts_enc, key.k), '|') as f offset 0) x
    where t.company_id = p_company and t.period_start >= p_start and t.period_end <= p_end
    group by t.store_code
  ),
  sk as (
    select s.store_code, count(distinct s.sku_code) filter (where coalesce(s.sku_code, '') <> '')::bigint as sku_count
    from sales s
    where s.company_id = p_company and s.period_start >= p_start and s.period_end <= p_end
    group by s.store_code
  )
  select st.store_code, st.units, st.gross, st.net, coalesce(sk.sku_count, 0)
  from st left join sk on sk.store_code = st.store_code;
$$;
revoke all on function public.sales_by_store(text, date, date) from public, anon, authenticated;
grant execute on function public.sales_by_store(text, date, date) to service_role;

create or replace function public.sales_store_months(p_company text)
returns table(month date)
language sql stable security definer set search_path = 'public', 'pg_temp'
as $$
  select distinct date_trunc('month', t.period_start)::date
  from sales_store_period t
  where t.company_id = p_company and t.rows > 0
  order by 1 desc;
$$;
revoke all on function public.sales_store_months(text) from public, anon, authenticated;
grant execute on function public.sales_store_months(text) to service_role;
