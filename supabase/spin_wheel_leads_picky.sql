-- Spin-the-wheel v3 (Oct 2026 events onwards): the booth form also asks whether
-- the pet is a picky eater. Additive only — no existing column or row changes.
--
-- Run once per environment in the Supabase SQL editor, AFTER
-- spin_wheel_leads.sql and spin_wheel_leads_instagram.sql. Safe to re-run.
-- Needed before the "Update" button on /customers/leads (it writes this column).
alter table public.spin_wheel_leads
  add column if not exists picky text;  -- as the form saved it: "Yes" / "No"
