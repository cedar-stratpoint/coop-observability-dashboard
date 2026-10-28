-- P2 · Checks (Nichido project). Additive and safe to re-run.
-- Run on Nichido STAGING (Nichido-Supabase-Staging) first; PROD after review.
--
--   check_settings  the form vs. sales threshold, its own setting (plan Q12):
--                   flag when |gap| > max(gap_min_units, gap_pct × POS sold)
--   adjustments     stock that left a store without a sale (F5): pull-out, damage, loss.
--                   Counted in the month its cycle ends; lowers that month's start.
--   flags           one row per finding (F6, F7). Written by the checks in
--                   src/goldline-checks-data.ts; unique per finding so a re-run updates it.
--                   status: open → checked | dismissed (an admin, remark required), or
--                   resolved (the data no longer shows the problem, e.g. a corrected count).

create table if not exists public.check_settings (
  company_id     text primary key references public.companies(id) on delete cascade,
  gap_min_units  integer not null default 1 check (gap_min_units >= 0 and gap_min_units <= 1000),
  gap_pct        numeric not null default 0.05 check (gap_pct >= 0 and gap_pct <= 1),
  updated_by     text,
  updated_at     timestamptz not null default now()
);
alter table public.check_settings enable row level security;
revoke all on public.check_settings from anon, authenticated;
insert into public.check_settings (company_id) values ('goldline') on conflict (company_id) do nothing;

create table if not exists public.adjustments (
  id              uuid primary key default gen_random_uuid(),
  company_id      text not null references public.companies(id) on delete cascade,
  store_code      text not null,
  item_code       text not null,
  period_start    date not null,               -- the cycle it happened in
  period_end      date not null,
  reason          text not null check (reason in ('pull_out', 'damage', 'loss')),
  qty             integer not null check (qty > 0 and qty <= 100000),
  note            text,
  source_flag_id  uuid,                        -- set when logged from a flag
  created_by      text,
  created_at      timestamptz not null default now(),
  check (period_start <= period_end)
);
create index if not exists adjustments_store_item_idx on public.adjustments (company_id, store_code, item_code, period_end);
alter table public.adjustments enable row level security;
revoke all on public.adjustments from anon, authenticated;

create table if not exists public.flags (
  id                uuid primary key default gen_random_uuid(),
  company_id        text not null references public.companies(id) on delete cascade,
  kind              text not null check (kind in ('sales_gap', 'zero_or_below', 'row_math', 'unreadable')),
  cause             text not null check (cause in ('human_error', 'unreadable', 'manipulation')),
  hint              text check (hint is null or hint in ('possible_pull_out', 'repeat')),
  store_code        text not null,
  item_code         text not null,
  period_start      date not null,             -- the cycle (row checks) or the month (sales_gap)
  period_end        date not null,
  consultant        text,                      -- the BA name on the form
  source_upload_id  uuid,
  details           jsonb not null default '{}'::jsonb,
  status            text not null default 'open' check (status in ('open', 'checked', 'dismissed', 'resolved')),
  remark            text,
  original_cause    text,                      -- what the check said, when an admin changed it
  closed_by         text,
  closed_at         timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (company_id, kind, store_code, item_code, period_start, period_end)
);
create index if not exists flags_open_idx on public.flags (company_id, status, cause);
alter table public.flags enable row level security;
revoke all on public.flags from anon, authenticated;

-- Months that have POS Sales Data loaded (first day of each), for "waiting for sales data".
create or replace function public.sales_months(p_company text)
returns setof date
language sql stable security invoker set search_path = public
as $$
  select distinct date_trunc('month', period_start)::date from sales where company_id = p_company order by 1;
$$;
revoke all on function public.sales_months(text) from public, anon, authenticated;
grant execute on function public.sales_months(text) to service_role;
