-- Goldline upload batches: one store's inventory form for one period, uploaded in one
-- sitting (several page PDFs, or one multi-page PDF split into pages in the browser).
-- Store + period are entered ONCE for the batch (prefilled from page 1's printed
-- header) and every page inherits them, so all pages commit into one Inventory count.
--
-- Additive only: a new table + a nullable FK column on gl_uploads (existing uploads
-- keep batch_id = null and behave as before). RLS on, no policies, revoked from the
-- API roles — service-role only, like the other gl_* tables. Staging first.

create table if not exists public.gl_upload_batches (
  id           uuid primary key default gen_random_uuid(),
  company_id   text not null references public.companies(id) on delete cascade,
  store_code   text,
  period_start date,
  period_end   date,
  status       text not null default 'open' check (status in ('open', 'committed')),
  created_by   text,
  created_at   timestamptz not null default now(),
  committed_at timestamptz,
  constraint gl_upload_batches_period_order check (period_start is null or period_end is null or period_start <= period_end)
);
create index if not exists gl_upload_batches_company_idx on public.gl_upload_batches (company_id, created_at desc);

alter table public.gl_uploads add column if not exists batch_id uuid references public.gl_upload_batches(id) on delete set null;
create index if not exists gl_uploads_batch_idx on public.gl_uploads (batch_id);

alter table public.gl_upload_batches enable row level security;
revoke all on public.gl_upload_batches from anon, authenticated;

comment on table public.gl_upload_batches is
  'One store''s inventory form for one period, uploaded together; pages inherit store + period. Service-role only.';

-- Atomic "Commit all pages": one transaction that locks the batch, verifies every
-- page is this batch's and still awaiting review, upserts all counts, and closes the
-- pages + batch. Concurrent commits serialize on the batch row lock; the second sees
-- status <> 'open' and is refused. Called only by the service-role dashboard.
create or replace function public.gl_commit_batch(
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
  select status into v_status from gl_upload_batches where id = p_batch and company_id = p_company for update;
  if v_status is null then raise exception 'batch_not_found' using errcode = 'P0002'; end if;
  if v_status <> 'open' then raise exception 'batch_not_open' using errcode = 'P0001'; end if;

  -- A page still being read would become reviewable inside a closed batch: refuse.
  if exists (select 1 from gl_uploads where company_id = p_company and batch_id = p_batch and status = 'processing') then
    raise exception 'pages_mismatch' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct (pg->>'upload_id')::uuid), '{}') into v_ids from jsonb_array_elements(p_pages) pg;
  select coalesce(array_agg(id), '{}') into v_expected
    from gl_uploads where company_id = p_company and batch_id = p_batch and status = 'needs_review' and kind = 'inventory_pdf';
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

  insert into gl_inventory (company_id, store_code, item_code, period_start, period_end, consultant,
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

  update gl_extractions set status = 'confirmed' where company_id = p_company and upload_id = any(v_ids);
  update gl_uploads set status = 'committed' where company_id = p_company and id = any(v_ids);
  update gl_upload_batches set status = 'committed', committed_at = now(),
         store_code = p_store, period_start = p_start, period_end = p_end
   where id = p_batch and company_id = p_company;
  return v_count;
end;
$$;

revoke all on function public.gl_commit_batch(text, uuid, text, date, date, text, jsonb) from public, anon, authenticated;
grant execute on function public.gl_commit_batch(text, uuid, text, date, date, text, jsonb) to service_role;
