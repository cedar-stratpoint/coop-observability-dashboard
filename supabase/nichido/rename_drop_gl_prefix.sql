-- One-time conversion of a Nichido project created with the old gl_ names (Staging,
-- 2026-10-22) to the prefix-free names in goldline_schema.sql. A project built from the
-- current goldline_schema.sql never needs this. Data, ids, RLS and grants are kept: a
-- rename moves them with the object. Runs as one transaction; safe to re-run (it only
-- touches objects that still carry the gl_ prefix).
--
-- Function bodies refer to tables by name, so the six functions are dropped and
-- recreated with the new names (same bodies as goldline_schema.sql).

do $$
declare r record;
begin
  -- Constraints first (they are named after their tables), then indexes, sequences,
  -- the view and the tables themselves.
  for r in select c.conrelid::regclass as tbl, c.conname from pg_constraint c
           where c.connamespace = 'public'::regnamespace and c.conname like 'gl\_%'
             and c.contype in ('c', 'f', 'u', 'p') loop
    execute format('alter table %s rename constraint %I to %I', r.tbl, r.conname, substr(r.conname, 4));
  end loop;
  for r in select format('alter %s public.%I rename to %I', k.word, c.relname, substr(c.relname, 4)) as stmt
           from pg_class c
           join (values ('i', 'index', 1), ('S', 'sequence', 2), ('v', 'view', 3), ('r', 'table', 4)) k(kind, word, ord)
             on k.kind = c.relkind::text
           where c.relnamespace = 'public'::regnamespace and c.relname like 'gl\_%'
           order by k.ord loop
    execute r.stmt;
  end loop;
end $$;

drop function if exists public.gl_commit_batch(text, uuid, text, date, date, text, jsonb);
drop function if exists public.gl_record_shipment(text, text, text, integer, text, date);
drop function if exists public.gl_cancel_shipment(text, uuid, text, date);
drop function if exists public.gl_set_price(text, text, numeric, text);
drop function if exists public.gl_sales_rollup(text);
drop function if exists public.gl_count_sources(text, text);

create or replace function public.commit_batch(
  p_company    text,
  p_batch      uuid,
  p_store      text,
  p_start      date,
  p_end        date,
  p_consultant text,
  p_pages      jsonb  -- [{upload_id, rows:[{item_code, stockroom, drawer, selling_area, delivery, ending_on_hand}]}]
) returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_status   text;
  v_ids      uuid[];
  v_expected uuid[];
  v_count    integer;
  v_dup      text;
begin
  select status into v_status from upload_batches where id = p_batch and company_id = p_company for update;
  if v_status is null then raise exception 'batch_not_found' using errcode = 'P0002'; end if;
  if v_status <> 'open' then raise exception 'batch_not_open' using errcode = 'P0001'; end if;

  -- A page still being read would become reviewable inside a closed batch: refuse.
  if exists (select 1 from uploads where company_id = p_company and batch_id = p_batch and status = 'processing') then
    raise exception 'pages_mismatch' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct (pg->>'upload_id')::uuid), '{}') into v_ids from jsonb_array_elements(p_pages) pg;
  select coalesce(array_agg(id), '{}') into v_expected
    from uploads where company_id = p_company and batch_id = p_batch and status = 'needs_review' and kind = 'inventory_pdf';
  if not (v_ids <@ v_expected and v_expected <@ v_ids) then
    raise exception 'pages_mismatch' using errcode = 'P0001';
  end if;

  -- One code per count: a page scanned twice (or a repeated code) is refused.
  select r->>'item_code' into v_dup
    from jsonb_array_elements(p_pages) pg, jsonb_array_elements(pg->'rows') r
    where r->>'item_code' is not null
    group by r->>'item_code' having count(*) > 1 order by 1 limit 1;
  if v_dup is not null then
    raise exception 'duplicate_item:%', v_dup using errcode = 'P0001';
  end if;

  insert into inventory (company_id, store_code, item_code, period_start, period_end, consultant,
                            stockroom, drawer, selling_area, delivery, ending_on_hand, source_upload_id)
  select p_company, p_store, r->>'item_code', p_start, p_end, p_consultant,
         (r->>'stockroom')::int, (r->>'drawer')::int, (r->>'selling_area')::int,
         (r->>'delivery')::int, (r->>'ending_on_hand')::int, (pg->>'upload_id')::uuid
  from jsonb_array_elements(p_pages) pg, jsonb_array_elements(pg->'rows') r
  on conflict (company_id, store_code, item_code, period_start, period_end) do update set
    consultant = excluded.consultant, stockroom = excluded.stockroom, drawer = excluded.drawer,
    selling_area = excluded.selling_area, delivery = excluded.delivery,
    ending_on_hand = excluded.ending_on_hand, source_upload_id = excluded.source_upload_id;
  get diagnostics v_count = row_count;

  update extractions set status = 'confirmed' where company_id = p_company and upload_id = any(v_ids);
  update uploads set status = 'committed' where company_id = p_company and id = any(v_ids);
  update upload_batches set status = 'committed', committed_at = now(),
         store_code = p_store, period_start = p_start, period_end = p_end
   where id = p_batch and company_id = p_company;
  return v_count;
end;
$$;

create or replace function public.record_shipment(
  p_company text, p_store text, p_item text, p_qty integer, p_by text, p_today date default current_date
) returns uuid
language plpgsql security invoker set search_path = public
as $$
declare
  v_on_hand integer;
  v_days    integer;
  v_id      uuid;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'bad_qty' using errcode = 'P0001'; end if;
  select on_hand into v_on_hand from warehouse_stock where company_id = p_company and item_code = p_item for update;
  if v_on_hand is null or v_on_hand < p_qty then raise exception 'not_enough_stock:%', coalesce(v_on_hand, 0) using errcode = 'P0001'; end if;
  select coalesce(
    (select transit_days from store_transit where company_id = p_company and store_code = p_store),
    (select default_transit_days from supply_settings where company_id = p_company),
    3) into v_days;
  update warehouse_stock set on_hand = on_hand - p_qty, updated_by = p_by, updated_at = now()
   where company_id = p_company and item_code = p_item;
  insert into shipments (company_id, store_code, item_code, qty, shipped_on, arrives_on, created_by)
  values (p_company, p_store, p_item, p_qty, p_today, p_today + v_days, p_by)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.cancel_shipment(p_company text, p_id uuid, p_by text, p_today date default current_date)
returns void
language plpgsql security invoker set search_path = public
as $$
declare
  v_item text;
  v_qty  integer;
  v_arr  date;
begin
  select arrives_on into v_arr from shipments where id = p_id and company_id = p_company and status = 'in_transit' for update;
  if v_arr is null then raise exception 'not_in_transit' using errcode = 'P0001'; end if;
  if v_arr <= p_today then raise exception 'already_arrived' using errcode = 'P0001'; end if;
  update shipments set status = 'cancelled', cancelled_by = p_by, cancelled_at = now()
   where id = p_id and company_id = p_company and status = 'in_transit'
  returning item_code, qty into v_item, v_qty;
  insert into warehouse_stock (company_id, item_code, on_hand, updated_by)
  values (p_company, v_item, v_qty, p_by)
  on conflict (company_id, item_code) do update set on_hand = warehouse_stock.on_hand + excluded.on_hand, updated_by = p_by, updated_at = now();
end;
$$;

create or replace function public.set_price(p_company text, p_item text, p_price numeric, p_by text)
returns void
language plpgsql security invoker set search_path = public
as $$
declare v_old numeric;
begin
  if p_price is null or p_price < 0 then raise exception 'bad_price' using errcode = 'P0001'; end if;
  select unit_price into v_old from products where company_id = p_company and item_code = p_item for update;
  if not found then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  if v_old is not distinct from p_price then return; end if; -- unchanged: nothing to log
  update products set unit_price = p_price where company_id = p_company and item_code = p_item;
  insert into price_changes (company_id, item_code, old_price, new_price, changed_by) values (p_company, p_item, v_old, p_price, p_by);
end;
$$;

create or replace function public.sales_rollup(p_company text)
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
        from sales where company_id = p_company group by store_code
      ) s), '[]'::jsonb),
    'bySku', coalesce((
      select jsonb_agg(jsonb_build_object('sku_code', sku_code, 'units', units, 'gross', gross, 'net', net))
      from (
        select coalesce(sku_code, '') as sku_code,
               coalesce(sum(units), 0) as units,
               coalesce(sum(gross_retail), 0) as gross,
               coalesce(sum(net_of_vat), 0) as net
        from sales where company_id = p_company group by coalesce(sku_code, '')
      ) k), '[]'::jsonb),
    'periodStart', (select min(period_start) from sales where company_id = p_company),
    'periodEnd', (select max(period_end) from sales where company_id = p_company)
  );
$$;

create or replace function public.count_sources(p_company text, p_store text)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  with latest as (
    select period_start, period_end, max(consultant) as consultant, max(created_at) as last_committed_at
    from inventory
    where company_id = p_company and store_code = p_store
      and period_end = (select max(period_end) from inventory where company_id = p_company and store_code = p_store)
    group by period_start, period_end
    order by period_start desc
    limit 1
  ),
  src as (
    select distinct i.source_upload_id as id
    from inventory i, latest l
    where i.company_id = p_company and i.store_code = p_store
      and i.period_start = l.period_start and i.period_end = l.period_end
      and i.source_upload_id is not null
  )
  select jsonb_build_object(
    'pending', (select count(*) from uploads where company_id = p_company and status = 'needs_review'),
    'latest', (select to_jsonb(l) from latest l),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object('id', u.id, 'filename', u.filename, 'uploaded_by', u.uploaded_by, 'created_at', u.created_at, 'page', e.page)
                       order by e.page nulls last, u.created_at)
      from src s
      join uploads u on u.id = s.id and u.company_id = p_company
      left join extractions e on e.upload_id = u.id and e.company_id = p_company), '[]'::jsonb)
  );
$$;

revoke all on function public.commit_batch(text, uuid, text, date, date, text, jsonb) from public, anon, authenticated;
grant execute on function public.commit_batch(text, uuid, text, date, date, text, jsonb) to service_role;
revoke all on function public.record_shipment(text, text, text, integer, text, date) from public, anon, authenticated;
revoke all on function public.cancel_shipment(text, uuid, text, date) from public, anon, authenticated;
revoke all on function public.set_price(text, text, numeric, text) from public, anon, authenticated;
grant execute on function public.record_shipment(text, text, text, integer, text, date) to service_role;
grant execute on function public.cancel_shipment(text, uuid, text, date) to service_role;
grant execute on function public.set_price(text, text, numeric, text) to service_role;
revoke all on function public.sales_rollup(text) from public, anon, authenticated;
grant execute on function public.sales_rollup(text) to service_role;
revoke all on function public.count_sources(text, text) from public, anon, authenticated;
grant execute on function public.count_sources(text, text) to service_role;

comment on view public.inventory_snapshots is
  'Per company/store/period rollup of inventory (Inventory page pickers). Service-role only.';
