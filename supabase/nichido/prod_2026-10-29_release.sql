-- Nichido PROD (pfwrkqsjmetibslltmok) · one pass for the v1.17.0 Coop release, Oct 29 2026.
-- Run once, in one transaction. Every step checks its row counts and stops (raises) if
-- prod isn't in the state this was written against, so nothing half-applies.
--
-- 1. f2c: who decommissioned an item, and why (additive; same as Staging Oct 28).
-- 2. Sync Staging's only data change since prod's copy: MUBBEP linked to Watsons SKU
--    70075146 by hand on Oct 28, and that decision in sku_link_reviews.
-- 3. Inventory form scans: keep one complete run (Cubao, Oct 8 to 9, pages 1 to 5,
--    committed, batch 855ed45d…) and remove the 41 other test scans with their counts,
--    readings (cascade) and flags. The 12 Watsons sales files stay: sales point at them.
--    Their files in the goldline-uploads bucket are removed separately through the
--    Storage API (direct deletes on storage.objects are not allowed).
-- Not here: Rick's p3b/p3c (F11), shipped later in its own release.

begin;

-- 1 · f2c ---------------------------------------------------------------------------
alter table public.products add column if not exists retired_by text;
alter table public.products add column if not exists retired_remark text;
do $$ begin
  alter table public.products add constraint products_retired_remark_len check (retired_remark is null or char_length(retired_remark) <= 500);
exception when duplicate_object then null; end $$;

-- 2 · MUBBEP link and its decision ---------------------------------------------------
do $$ declare n int; begin
  if exists (select 1 from public.products where company_id = 'goldline' and sku_code = '70075146' and item_code <> 'MUBBEP') then
    raise exception 'Watsons SKU 70075146 is already linked to another item on prod';
  end if;
  update public.products
     set sku_code = '70075146', sku_linked_by = 'admin', sku_linked_at = '2026-10-28 05:43:56.55+00'
   where company_id = 'goldline' and item_code = 'MUBBEP' and sku_code is null;
  get diagnostics n = row_count;
  if n not in (0, 1) then raise exception 'MUBBEP update touched % rows', n; end if;
end $$;

insert into public.sku_link_reviews (company_id, chain, sku_code, action, item_code, action_by, action_at)
values ('goldline', 'watsons', '70075146', 'linked', 'MUBBEP', 'Sylvester Niño Uy', '2026-10-28 05:43:58.177+00')
on conflict (company_id, chain, sku_code) do nothing;

-- 3 · Keep one form run ---------------------------------------------------------------
create temp table rel_keep_uploads on commit drop as
  select id from public.uploads where batch_id = '855ed45d-efc2-4bd9-8373-e71cceef289a' and kind = 'inventory_pdf';
create temp table rel_drop_uploads on commit drop as
  select id, storage_path from public.uploads where kind = 'inventory_pdf' and id not in (select id from rel_keep_uploads);

do $$ declare k int; d int; begin
  select count(*) into k from rel_keep_uploads;
  select count(*) into d from rel_drop_uploads;
  if k <> 5 then raise exception 'Expected 5 scans in the kept Cubao run, found %', k; end if;
  if d <> 41 then raise exception 'Expected 41 test scans to remove, found %', d; end if;
end $$;

do $$ declare n int; begin
  delete from public.flags where source_upload_id in (select id from rel_drop_uploads);
  get diagnostics n = row_count; if n <> 4 then raise exception 'flags: expected 4, deleting %', n; end if;
  delete from public.inventory where source_upload_id in (select id from rel_drop_uploads);
  get diagnostics n = row_count; if n <> 306 then raise exception 'inventory: expected 306, deleting %', n; end if;
  delete from public.uploads where id in (select id from rel_drop_uploads); -- extractions cascade
  get diagnostics n = row_count; if n <> 41 then raise exception 'uploads: expected 41, deleting %', n; end if;
  delete from public.upload_batches b where b.id <> '855ed45d-efc2-4bd9-8373-e71cceef289a'
    and not exists (select 1 from public.uploads u where u.batch_id = b.id);
  get diagnostics n = row_count; if n <> 17 then raise exception 'upload_batches: expected 17, deleting %', n; end if;
end $$;

-- What should remain, for the record
select (select count(*) from public.uploads where kind = 'inventory_pdf') pdf_scans,         -- 5
       (select count(*) from public.uploads where kind = 'pos_xlsx') sales_files,            -- 12
       (select count(*) from public.inventory) count_rows,                                   -- 263
       (select count(*) from public.extractions) readings,                                   -- 5
       (select count(*) from public.flags) flags,                                            -- 2
       (select count(*) from public.products where sku_code is not null) linked_items,       -- 211
       (select count(*) from public.sku_link_reviews) decisions;                            -- 1

commit;
