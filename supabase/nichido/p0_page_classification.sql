-- Phase 0 — page classification + form segmentation (NICH-17, see ../../../PLAN.md).
--
-- A scanned bundle arrives shuffled, rotated, and mixed across stores, periods, and
-- form versions. Before extraction each page is CLASSIFIED (page number, kind,
-- orientation, form version, handwritten header) so it can be grouped into
-- {store · period · version · page} forms. This migration only ADDS nullable columns
-- and an index — nothing existing is altered, and re-running is safe (idempotent).
--
-- Staging first (project jcqlnrvplaapvcxyhcns). Additive-only; never touches Coop's
-- tables. Promote the same file to prod in one reviewed pass later.

-- Per-page classifier output on the upload row (the page's own scan file).
alter table public.uploads add column if not exists page_no        integer;     -- printed "PAGE # N" (1-6); null/0 = none
alter table public.uploads add column if not exists page_kind       text;        -- inventory | sales | blank | unknown
alter table public.uploads add column if not exists orientation     smallint;    -- 0 (upright) | 180 (upside-down, rotated before extract)
alter table public.uploads add column if not exists form_version    text;        -- legacy | v1 | v2 | unknown
alter table public.uploads add column if not exists classification  jsonb;       -- full classifier payload + store_snap (store/period/consultant/confidence)
alter table public.uploads add column if not exists page_key        text;        -- {store · period-bucket · version · page} key, for duplicate / re-upload detection
alter table public.uploads add column if not exists classified_at   timestamptz;

-- Supports the cross-upload "already uploaded before" check and intra-bundle dup flag.
create index if not exists uploads_page_key_idx on public.uploads (company_id, page_key);

-- A batch (one store's form for one cut-off) now also records which form version it is.
alter table public.upload_batches add column if not exists form_version text;     -- legacy | v1 | v2 | unknown

comment on column public.uploads.page_key is
  'Phase 0 semantic page identity: {store · half-month period · version · page}. '
  'Duplicate within a bundle, or match to a prior upload, = same key. Flag, never auto-drop.';
