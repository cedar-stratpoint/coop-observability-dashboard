-- P0b · Upload batch kind and name (Nichido project). Safe to re-run, safe with an older build.
-- Until now these columns only lived in goldline_schema.sql and in two Staging migrations
-- (uploads_batch_name and upload_batches_kind, 2026-11-10); this is the file Prod applies.
--
-- upload_batches.kind: 'form' = one store's multi-page form, reviewed and committed together;
-- 'scan' = a whole-scan batch across stores, worked page by page and never sent to batch review.
alter table public.upload_batches add column if not exists kind text not null default 'form'
  check (kind in ('form','scan'));

-- uploads.batch_name: the optional name typed when a group is dropped. Null = use the file name.
alter table public.uploads add column if not exists batch_name text;

-- Scans that were stored before the column existed: only a batch with more than 8 pages and
-- still 'form'. (Prod on 2026-11-24 has one batch of 5 pages, so this changes nothing there.)
update public.upload_batches set kind = 'scan'
 where kind = 'form'
   and id in (select batch_id from public.uploads where batch_id is not null group by batch_id having count(*) > 8)
   and not exists (select 1 from public.upload_batches x where x.kind = 'scan');
