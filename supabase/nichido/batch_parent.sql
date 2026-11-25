-- One Uploads tile per upload (2026-11-25). Picking a store sorts an upload into one batch per
-- store form; each new batch showed as its own tile with the same name, so one 98-page upload
-- looked like 10. A batch split off now records the upload batch it came from, and the app
-- groups, scopes and deletes by that original. Additive only. Staging first.
alter table public.upload_batches add column if not exists parent_batch_id uuid references public.upload_batches(id) on delete set null;
create index if not exists upload_batches_parent_idx on public.upload_batches (parent_batch_id) where parent_batch_id is not null;
