-- P1 · Watsons data in (Nichido project). Additive and safe to re-run.
-- Run on Nichido STAGING (Nichido-Supabase-Staging) first; PROD after review.
--
-- Nichido sells through two chains, Watsons and Robinsons. Watsons comes first: its
-- monthly POS Sales Data workbook (Per_Store_Per_SKU) seeds the store list and the
-- Watsons SKU list. Robinsons gets its own stores and SKUs later.
--
--   stores.chain      which chain a store belongs to ('watsons' for every store today)
--   stores.in_scope   admin override for checks and restock. NULL = automatic: in
--                     scope while the store sold something in its last 3 loaded months.
--   products.category Eyes, Lips, Face or Other, filled from the Watsons subclass.
--   products.retired_at  retire toggle, separate from `hidden`.
--   chain_skus        every SKU a chain reports (code, name, subclass), linked or not.
--                     The link itself stays on products.sku_code, which every
--                     existing reader joins on.

alter table public.stores add column if not exists chain text not null default 'watsons';
alter table public.stores add column if not exists in_scope boolean;
do $$ begin
  alter table public.stores add constraint stores_chain_check check (chain in ('watsons', 'robinsons'));
exception when duplicate_object then null; end $$;

alter table public.products add column if not exists category text;
alter table public.products add column if not exists retired_at timestamptz;
do $$ begin
  alter table public.products add constraint products_category_check
    check (category is null or category in ('eyes', 'lips', 'face', 'other'));
exception when duplicate_object then null; end $$;

create table if not exists public.chain_skus (
  company_id  text not null references public.companies(id) on delete cascade,
  chain       text not null check (chain in ('watsons', 'robinsons')),
  sku_code    text not null,                -- e.g. Watsons SKU Code '38006200'
  name        text not null,                -- as the chain prints it (often cut short)
  subclass    text,                         -- e.g. 'EYES COSMETICS'
  first_month date,                         -- first and last month it appeared in a file
  last_month  date,
  updated_at  timestamptz not null default now(),
  primary key (company_id, chain, sku_code)
);
alter table public.chain_skus enable row level security;
revoke all on public.chain_skus from anon, authenticated;

-- One period's sales totalled per SKU, for the Overview. A Watsons month is ~40k rows;
-- the page only needs ~300 totals, so add them up here instead of shipping every row.
create or replace function public.sales_by_sku(p_company text, p_start date, p_end date)
returns table (sku_code text, units bigint, gross numeric, net numeric)
language sql stable security invoker set search_path = public
as $$
  select coalesce(sku_code, ''), coalesce(sum(units), 0), coalesce(sum(gross_retail), 0), coalesce(sum(net_of_vat), 0)
  from sales
  where company_id = p_company and period_start = p_start and period_end = p_end
  group by coalesce(sku_code, '');
$$;
revoke all on function public.sales_by_sku(text, date, date) from public, anon, authenticated;
grant execute on function public.sales_by_sku(text, date, date) to service_role;
