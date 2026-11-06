-- Business Health Report: the saved BREAKDOWNS of the three former consolidated typed lines (Fixed overhead, COGS, Content and other).
-- Run by hand per environment AFTER supabase/plan_report.sql and BEFORE supabase/plan_actuals_itemise.sql. Idempotent: running it twice changes nothing.
-- BHR-06 (2026-11-06): the breakdown modal and its RPC plan_set_actual_parts are retired; each itemised sheet row is typed as its own line. The table
-- stays only because plan_actuals_itemise.sql reads it to split old totals into their rows (nothing else reads or writes it). This file no longer
-- creates the RPC, and drops it, so re-applying the files in their documented order never brings it back (test/plan-sql-apply-order.test.ts).
-- RLS ON, no policies, no privileges for anon / authenticated: service role only, like every plan table.

create table if not exists public.plan_actual_parts (
  month       date    not null,
  metric      text    not null check (metric in ('overhead', 'cogs', 'content_other')),
  part        text    not null,
  amount_php  numeric not null check (amount_php >= 0),
  updated_by  text,
  updated_at  timestamptz not null default now(),
  primary key (month, metric, part),
  foreign key (month, metric) references public.plan_actuals (month, metric) on delete cascade
);
alter table public.plan_actual_parts enable row level security;
revoke all on public.plan_actual_parts from anon, authenticated;

-- Retired (BHR-06): the breakdown save RPC. Dropped here as well as in plan_actuals_itemise.sql.
drop function if exists public.plan_set_actual_parts(date, text, jsonb, numeric, text);
