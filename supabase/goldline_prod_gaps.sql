-- Goldline objects that exist on Staging but were never captured in a .sql file
-- (applied by hand there). Found by diffing Staging's schema against the other
-- goldline/company files before the v1.7.0 prod promotion (2026-10-15).
-- Additive only, safe to re-run. Depends on goldline.sql.

-- Scrubbed reason an upload failed (first 500 chars), written by
-- src/goldline-data.ts and read when diagnosing a failed extraction. Without it the
-- upload status update errors.
alter table public.gl_uploads add column if not exists error_detail text;

-- Private bucket for uploaded CSV / PDF files (src/goldline-data.ts GOLDLINE_BUCKET).
-- No storage policies: only the service-role dashboard reads or writes it, and scans
-- are shown through signed URLs / the same-origin proxy.
insert into storage.buckets (id, name, public)
values ('goldline-uploads', 'goldline-uploads', false)
on conflict (id) do nothing;
