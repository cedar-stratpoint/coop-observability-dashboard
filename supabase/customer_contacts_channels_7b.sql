-- Stage 7B (RET-07): add the Instagram, Facebook and Viber channels to the manual contact log (customer_contacts).
-- Plan: knowledge/tasks/2026-11-11-customer-last-contacted-stage7.md (section 7B, rule R6: keep 'dm' so older rows stay valid).
--
-- ROLLOUT ORDER: run this in the Supabase SQL editor on Staging first, then PROD, BEFORE deploying the 7B code.
-- Deployed without it, picking Instagram / Facebook / Viber fails the old DB check; the dashboard then says
-- "This channel isn't enabled in the database yet" and saves nothing.
--
-- Postgres names an inline column check <table>_<column>_check, so the check written by supabase/customer_contacts.sql
-- (channel ... check (...)) is customer_contacts_channel_check. Idempotent: safe to re-run. Every existing row
-- (dm, sms, call, email, other) passes the wider check. The same statements are at the end of customer_contacts.sql.
alter table public.customer_contacts drop constraint if exists customer_contacts_channel_check;
alter table public.customer_contacts add constraint customer_contacts_channel_check
  check (channel in ('dm', 'sms', 'call', 'email', 'other', 'instagram', 'facebook', 'viber'));
