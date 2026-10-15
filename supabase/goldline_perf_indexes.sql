-- Goldline read-path indexes. Every board / forecast / product read filters gl_inventory
-- (and gl_sales / gl_shipments) by a recent period END, but the existing indexes lead
-- with period START — so those reads (and the gl_inventory_snapshots view, which groups
-- by period_end) fall back to scanning the company's whole history. At the 300-store
-- ramp that's millions of rows per page load.
--
-- Additive only (indexes). Safe to re-run. Staging first.

create index if not exists gl_inventory_company_period_end_idx on public.gl_inventory (company_id, period_end);
create index if not exists gl_inventory_store_period_end_idx on public.gl_inventory (company_id, store_code, period_end);
create index if not exists gl_inventory_item_period_end_idx on public.gl_inventory (company_id, item_code, period_end);
create index if not exists gl_sales_company_period_end_idx on public.gl_sales (company_id, period_end);
create index if not exists gl_shipments_open_idx on public.gl_shipments (company_id, arrives_on) where status = 'in_transit';
create index if not exists gl_uploads_status_idx on public.gl_uploads (company_id, status);

-- Stores page rollup in the database: per-store and per-SKU sums plus the period span,
-- instead of shipping every gl_sales row to the app on each load (that grows with every
-- upload — ~150k rows per period at 300 stores). Read-only; service-role only.
create or replace function public.gl_sales_rollup(p_company text)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  select jsonb_build_object(
    'byStore', coalesce((
      select jsonb_agg(jsonb_build_object('store_code', store_code, 'units', units, 'gross', gross, 'net', net, 'sku_count', sku_count))
      from (
        select store_code,
               coalesce(sum(units), 0) as units,
               coalesce(sum(gross_retail), 0) as gross,
               coalesce(sum(net_of_vat), 0) as net,
               count(distinct sku_code) filter (where sku_code is not null and sku_code <> '') as sku_count
        from gl_sales where company_id = p_company group by store_code
      ) s), '[]'::jsonb),
    'bySku', coalesce((
      select jsonb_agg(jsonb_build_object('sku_code', sku_code, 'units', units, 'gross', gross, 'net', net))
      from (
        select coalesce(sku_code, '') as sku_code,
               coalesce(sum(units), 0) as units,
               coalesce(sum(gross_retail), 0) as gross,
               coalesce(sum(net_of_vat), 0) as net
        from gl_sales where company_id = p_company group by coalesce(sku_code, '')
      ) k), '[]'::jsonb),
    'periodStart', (select min(period_start) from gl_sales where company_id = p_company),
    'periodEnd', (select max(period_end) from gl_sales where company_id = p_company)
  );
$$;
revoke all on function public.gl_sales_rollup(text) from public, anon, authenticated;
grant execute on function public.gl_sales_rollup(text) to service_role;

-- Inventory board header in one round trip: a store's latest count (period, consultant,
-- committed at), the scans it was committed from (with their form pages), and how many
-- uploads wait for review. Replaces three sequential reads. Read-only; service-role only.
create or replace function public.gl_count_sources(p_company text, p_store text)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  with latest as (
    select period_start, period_end, max(consultant) as consultant, max(created_at) as last_committed_at
    from gl_inventory
    where company_id = p_company and store_code = p_store
      and period_end = (select max(period_end) from gl_inventory where company_id = p_company and store_code = p_store)
    group by period_start, period_end
    order by period_start desc
    limit 1
  ),
  src as (
    select distinct i.source_upload_id as id
    from gl_inventory i, latest l
    where i.company_id = p_company and i.store_code = p_store
      and i.period_start = l.period_start and i.period_end = l.period_end
      and i.source_upload_id is not null
  )
  select jsonb_build_object(
    'pending', (select count(*) from gl_uploads where company_id = p_company and status = 'needs_review'),
    'latest', (select to_jsonb(l) from latest l),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object('id', u.id, 'filename', u.filename, 'uploaded_by', u.uploaded_by, 'created_at', u.created_at, 'page', e.page)
                       order by e.page nulls last, u.created_at)
      from src s
      join gl_uploads u on u.id = s.id and u.company_id = p_company
      left join gl_extractions e on e.upload_id = u.id and e.company_id = p_company), '[]'::jsonb)
  );
$$;
revoke all on function public.gl_count_sources(text, text) from public, anon, authenticated;
grant execute on function public.gl_count_sources(text, text) to service_role;
