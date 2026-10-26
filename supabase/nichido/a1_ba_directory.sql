-- A1 · BA directory (Nichido project). Additive and safe to re-run.
-- Run on Nichido STAGING (Nichido-Supabase-Staging) first; PROD after review.
--
-- Why now (Oct 26): the forms carry a "Beauty Consultant" line, but the sample scans
-- leave it blank, and a flag with no BA counts against nobody. The directory says
-- which BA covers which store from when, so a form with no name still lands on the
-- right BA, and a shortened name on the form ("Liza M.") resolves to the full name.
--
--   bas        one row per beauty assistant (full name, unique per company, any case)
--   store_bas  BA to store with dates; a move ends one row and starts another, so
--              history stays. At most one open row (ended_on null) per store.
--
-- inventory.consultant keeps the resolved name per form row (written on the form, or
-- filled from the directory), so the checks and BA tags read one column as before.

create table if not exists public.bas (
  id          uuid primary key default gen_random_uuid(),
  company_id  text not null references public.companies(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 2 and 80),
  created_by  text,
  created_at  timestamptz not null default now()
);
create unique index if not exists bas_company_name_idx on public.bas (company_id, lower(btrim(name)));
alter table public.bas enable row level security;
revoke all on public.bas from anon, authenticated;

create table if not exists public.store_bas (
  id          uuid primary key default gen_random_uuid(),
  company_id  text not null references public.companies(id) on delete cascade,
  store_code  text not null,
  ba_id       uuid not null references public.bas(id) on delete cascade,
  started_on  date not null,
  ended_on    date,
  created_by  text,
  created_at  timestamptz not null default now(),
  check (ended_on is null or ended_on >= started_on)
);
create unique index if not exists store_bas_open_idx on public.store_bas (company_id, store_code) where ended_on is null;
create index if not exists store_bas_store_idx on public.store_bas (company_id, store_code, started_on);
alter table public.store_bas enable row level security;
revoke all on public.store_bas from anon, authenticated;
