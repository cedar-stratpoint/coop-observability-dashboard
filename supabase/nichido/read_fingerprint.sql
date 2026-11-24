-- QA fix 9 (2026-11-24): the same page uploaded twice gave different confidence and notes
-- (the reader model takes no temperature setting, so its self-rated confidence and wording
-- drift run to run). A read now records the page file's SHA-256 and the reader that read it
-- (the deployed code version); a later upload of the identical file, read by the same deploy,
-- copies that read instead of reading again. Additive only. Staging first.
alter table public.uploads add column if not exists content_sha256 text;
alter table public.uploads add column if not exists reader_sig text;
create index if not exists uploads_company_content_sha256_idx
  on public.uploads (company_id, content_sha256)
  where content_sha256 is not null;
