-- Phase 1 — version-aware inventory (NICH-17, see ../../../PLAN.md).
--
-- Tags each committed inventory row with the form version it came from, and gives
-- Legacy (the 7-column "deducted" form) a sidecar to keep its beginning / deducted
-- values — those have no three-location column. Additive-only and idempotent; the
-- commit_batch signature is UNCHANGED (it now derives the version from the batch's
-- own uploads, which all share one version, so no caller change is required).
--
-- Staging first (project jcqlnrvplaapvcxyhcns). Promote to prod in one reviewed pass.

-- 1 · Columns -----------------------------------------------------------------
alter table public.inventory add column if not exists form_version text;   -- legacy | v1 | v2 | …
alter table public.inventory add column if not exists extra        jsonb;  -- Legacy-only: {beginning, begin_plus_delivery, deducted_pcs}

-- Existing committed rows are all the three-location V1 data loaded so far.
update public.inventory set form_version = 'v1' where form_version is null;

-- 2 · commit_batch: stamp the version (derived from the batch's uploads) + sidecar.
--     Same 7-arg signature as before; p_pages rows may now carry an optional "extra".
create or replace function public.commit_batch(
  p_company    text,
  p_batch      uuid,
  p_store      text,
  p_start      date,
  p_end        date,
  p_consultant text,
  p_pages      jsonb  -- [{upload_id, rows:[{item_code, stockroom, drawer, selling_area, delivery, ending_on_hand, extra?}]}]
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
  v_version  text;
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

  -- A batch is one store's form for one cut-off, so all its pages share one version.
  -- Derive it from the uploads (Phase 0 wrote uploads.form_version); default v1.
  select form_version into v_version
    from uploads
   where company_id = p_company and batch_id = p_batch and form_version is not null
   order by classified_at desc nulls last
   limit 1;
  v_version := coalesce(v_version, 'v1');

  insert into inventory (company_id, store_code, item_code, period_start, period_end, consultant,
                            stockroom, drawer, selling_area, delivery, ending_on_hand, form_version, extra, source_upload_id)
  select p_company, p_store, r->>'item_code', p_start, p_end, p_consultant,
         (r->>'stockroom')::int, (r->>'drawer')::int, (r->>'selling_area')::int,
         (r->>'delivery')::int, (r->>'ending_on_hand')::int, v_version, (r->'extra'), (pg->>'upload_id')::uuid
  from jsonb_array_elements(p_pages) pg, jsonb_array_elements(pg->'rows') r
  on conflict (company_id, store_code, item_code, period_start, period_end) do update set
    consultant = excluded.consultant, stockroom = excluded.stockroom, drawer = excluded.drawer,
    selling_area = excluded.selling_area, delivery = excluded.delivery,
    ending_on_hand = excluded.ending_on_hand, form_version = excluded.form_version,
    extra = excluded.extra, source_upload_id = excluded.source_upload_id;
  get diagnostics v_count = row_count;

  update extractions set status = 'confirmed' where company_id = p_company and upload_id = any(v_ids);
  update uploads set status = 'committed' where company_id = p_company and id = any(v_ids);
  update upload_batches set status = 'committed', committed_at = now(),
         store_code = p_store, period_start = p_start, period_end = p_end, form_version = v_version
   where id = p_batch and company_id = p_company;
  return v_count;
end;
$$;

comment on column public.inventory.form_version is 'Phase 1: form layout the row was read from (legacy | v1 | v2 | …), derived from the batch uploads at commit.';
comment on column public.inventory.extra is 'Phase 1: Legacy-only sidecar — beginning / begin_plus_delivery / deducted_pcs, which have no three-location column.';
