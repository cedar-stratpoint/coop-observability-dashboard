-- Business Health Report: the per-part TARGETS behind the three consolidated lines (Fixed overhead, COGS, Content and other), shown as the grey value
-- beside each part in the breakdown modal. Schema only: the values are loaded privately from the plan workbook by scripts/seed-plan-from-workbook.mjs
-- (the repo is public and holds no plan figure). Run by hand per environment AFTER supabase/plan_report.sql. Idempotent.
-- One row per (month, line, part), pesos. The reader shows them only while they still add up to the line's current target (src/plan-parts.ts partTargets).
-- RLS ON, no policies, no privileges for anon / authenticated: service role only, like every plan table.
create table if not exists public.plan_part_targets (
  month  date    not null,
  line   text    not null check (line in ('overhead', 'cogs', 'content_other')),
  part   text    not null,
  value  numeric not null,
  primary key (month, line, part),
  check (month = date_trunc('month', month)::date)
);
alter table public.plan_part_targets enable row level security;
revoke all on public.plan_part_targets from anon, authenticated;
