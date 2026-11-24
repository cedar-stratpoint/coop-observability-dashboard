-- NICH-17 · Reconcile across all stores (Nichido project). Additive, read-only functions.
-- Run on Nichido STAGING first; PROD after review. Needs inventory.form_version (Sept phase 1).
--
-- The reconcile page reads every store's form counts for a month. Through the API that is
-- one request per 1,000 rows (about 158 for 300 stores with two forms each), so these
-- return it in one value instead.
--
--   audit_count_index   which stores have a committed form, per month.
--   audit_counts        each store's latest form row per item in a month:
--                       {store: {item: [ending, stockroom, drawer, selling area, form version]}}.
--                       Blanks stay null; on hand is worked out by onHandOf() in the app.

create or replace function public.audit_count_index(p_company text)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(jsonb_object_agg(m, stores), '{}'::jsonb)
  from (
    select to_char(period_end, 'YYYY-MM') as m, jsonb_agg(distinct store_code) as stores
    from inventory where company_id = p_company
    group by 1
  ) t;
$$;

create or replace function public.audit_counts(p_company text, p_month date, p_stores text[] default null)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  with latest as (
    select distinct on (store_code, item_code) store_code, item_code, ending_on_hand, stockroom, drawer, selling_area, form_version
    from inventory
    where company_id = p_company
      and period_end >= date_trunc('month', p_month)::date
      and period_end < (date_trunc('month', p_month) + interval '1 month')::date
      and (p_stores is null or store_code = any(p_stores))
    order by store_code, item_code, period_end desc, id desc
  ),
  per_store as (
    select store_code, jsonb_object_agg(item_code, jsonb_build_array(ending_on_hand, stockroom, drawer, selling_area, form_version)) as items
    from latest group by store_code
  )
  select coalesce(jsonb_object_agg(store_code, items), '{}'::jsonb) from per_store;
$$;

revoke all on function public.audit_count_index(text) from public, anon, authenticated;
revoke all on function public.audit_counts(text, date, text[]) from public, anon, authenticated;
grant execute on function public.audit_count_index(text) to service_role;
grant execute on function public.audit_counts(text, date, text[]) to service_role;
