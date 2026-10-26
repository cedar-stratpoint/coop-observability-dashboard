-- Spin-the-wheel v4 (late Oct 2026 events onwards): the booth form asks for the
-- furparent's full name and no longer asks whether the pet is a picky eater.
-- Additive only: `picky` stays, and so does every existing row's value in it.
--
-- Run once per environment in the Supabase SQL editor (Staging, then PROD),
-- AFTER spin_wheel_leads.sql, spin_wheel_leads_instagram.sql and
-- spin_wheel_leads_picky.sql. Safe to re-run.
-- Needed before the "Update" button on /customers/leads (it reads and writes this column).
alter table public.spin_wheel_leads
  add column if not exists name text;  -- as typed on the form, e.g. "Zoe Taylor Go"
