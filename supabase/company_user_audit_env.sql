-- Record which Coop environment (staging / production) each access change was made in,
-- so the audit trail shows it at a glance once Coop Admins switch between sites.
-- Additive only: a nullable column on company_user_audit (existing rows stay null).
-- The app writes it when present and falls back to the old insert where it isn't yet
-- (so prod keeps auditing before this is applied there). Staging first.

alter table public.company_user_audit add column if not exists env text check (env is null or env in ('staging', 'production'));
comment on column public.company_user_audit.env is 'Which Coop environment (staging / production) the access change was made in.';
