-- Saved customer cohorts (RET-10 Stage 9A, plan knowledge/tasks/2026-11-12-customer-cohorts-stage9.md): a group + a name + a rule,
-- shown on the Website CRM page as "Event · Circuit Makati". The table holds the RULE only, never the members: customers match it
-- live on every render (matchesCohort in src/crm-compute.ts), so nobody tags a customer by hand and nothing goes stale.
-- Written by src/customer-cohorts-actions.ts (create; edit and delete only where created_by is the signed-in user), read by
-- src/customer-cohorts-data.ts. The rule is validated in code on every write and again on every read (readCohortRule); the checks
-- below are the database's backstop for the shape and the label limits.
--
-- Run once per environment in the Supabase SQL editor (Staging first, owner approval). Safe to re-run.
-- Until it runs, the page shows saved cohorts as "unavailable" (the built-in Repeat promo / Win-back still work) and
-- "+ New cohort" says cohorts are not set up.
create table if not exists public.customer_cohorts (
  id          uuid primary key default gen_random_uuid(),
  group_name  text not null check (group_name = btrim(group_name) and char_length(group_name) between 1 and 24),
  name        text not null check (name = btrim(name) and char_length(name) between 1 and 48),
  -- {"all": [{"f": <field>, "op": <operator>, "v": <value>}, ...]}: AND of 1 to 10 conditions over the closed field list.
  rule        jsonb not null check (
                jsonb_typeof(rule) = 'object'
                and case when jsonb_typeof(rule -> 'all') = 'array' then jsonb_array_length(rule -> 'all') between 1 and 10 else false end
              ),
  created_by  text not null check (created_by <> ''),   -- the signed-in Coop email; only this person edits or deletes
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One cohort per label, case-insensitive: "Event · Circuit Makati" and "event · circuit makati" are the same cohort. The create
-- action reads a clash (23505) as "Already saved" when the rule and creator are the same, otherwise as "already exists".
create unique index if not exists customer_cohorts_label_key on public.customer_cohorts (lower(group_name), lower(name));

-- RLS on with NO policies: the anon key can read nothing, and only the service role (Coop server-side, same as
-- customer_contacts) gets through. Verify after applying: select with the anon key returns no rows.
alter table public.customer_cohorts enable row level security;
