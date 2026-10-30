-- F2 · Store scope (Nichido project). Additive and safe to re-run.
-- Run on Nichido STAGING (Nichido-Supabase-Staging) first; PROD after review.
-- Once s3_sales_units_encryption.sql is applied, re-run s3 after this file: s3 holds the
-- decrypting versions of the sales readers below (units are encrypted, then dropped by s2).
--
-- Decided Oct 26 (S2): a store is out of scope when it sold nothing in the last 3
-- loaded months of POS Sales Data; admins can switch any store back on (or off).
-- stores.in_scope (p1) holds the override: NULL = automatic, true/false = admin.
--
-- store_scope(company) gives, per store: its last month with any units sold, whether
-- it sold in the latest 3 loaded months, and the scope that applies (override first).
-- One pass over sales; the restock (P3) reads `in_scope` from here.

create or replace function public.store_scope(p_company text)
returns table (store_code text, last_sale_month date, sold_recently boolean, override boolean, in_scope boolean)
language sql stable security invoker set search_path = public
as $$
  with months as (
    select distinct date_trunc('month', period_start)::date as m
    from sales where company_id = p_company
    order by 1 desc limit 3
  ),
  per as (
    select s.store_code,
           max(date_trunc('month', s.period_start)::date) filter (where coalesce(s.units, 0) > 0) as last_sale_month,
           bool_or(coalesce(s.units, 0) > 0 and date_trunc('month', s.period_start)::date in (select m from months)) as sold_recently
    from sales s
    where s.company_id = p_company
    group by s.store_code
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
