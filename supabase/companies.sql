-- Goldline / multi-tenant foundation (P0).
--
-- Introduces the first tenancy dimension Coop has ever had: a `companies`
-- registry and a `company_users` membership map. ADDITIVE ONLY — it does not
-- touch Coop's existing tables (digest_archive, business_health, marketplace_*)
-- or any pos_* data. Zoomy keeps working exactly as before and is simply seeded
-- here as the first company, so one auth path can serve both brands.
--
-- Run once per environment in the Supabase SQL editor: STAGING
-- (syxwixxzmytvhwhkwdvw) first, PROD only after review.

-- Roles. Coop Admin is DATA-BLIND — it manages companies and people but sees no
-- business data (enforced app-side; see src/company.ts). company_admin / analyst
-- / store_manager are each scoped to a single company. Goldline's v1 "Goldline
-- User" is a company_admin; the label is a UI concern, not a separate role.
do $$ begin
  create type public.company_role as enum
    ('coop_admin', 'company_admin', 'analyst', 'store_manager');
exception when duplicate_object then null; end $$;

create table if not exists public.companies (
  id          text primary key,                 -- slug: 'zoomy', 'goldline'
  name        text not null,
  status      text not null default 'active',   -- active | suspended
  theme       jsonb,                            -- accent, logo, etc. (optional)
  created_at  timestamptz not null default now()
);

create table if not exists public.company_users (
  id          uuid primary key default gen_random_uuid(),
  -- NULL company_id === cross-tenant (coop_admin). For every other role this is
  -- the single company the member can see.
  company_id  text references public.companies(id) on delete cascade,
  user_email  text not null,
  role        public.company_role not null,
  store_scope text[],                           -- store codes (store_manager); null = all
  created_at  timestamptz not null default now(),
  -- One membership per (person, company); coop_admin rows use company_id NULL.
  unique (user_email, company_id)
);

create index if not exists company_users_email_idx
  on public.company_users (lower(user_email));

-- Membership + registry are operator metadata, not business data. RLS on with NO
-- policies: the anon key reads nothing; only the service role (the Coop server,
-- same pattern as pos_* and spin_wheel_leads) gets through. App-level scoping by
-- the active company_id is the primary fence; this RLS is the backstop.
alter table public.companies     enable row level security;
alter table public.company_users enable row level security;

-- Seed the first tenant. Zoomy keeps its legacy tables; it just becomes a company.
insert into public.companies (id, name) values ('zoomy', 'Zoomy')
  on conflict (id) do nothing;

-- Seed existing dashboard users as Zoomy members so nobody loses access when the
-- sign-in gate moves from ALLOWED_EMAILS to membership. They land as company_admin
-- for Zoomy; adjust individual roles afterwards. Safe to re-run.
insert into public.company_users (company_id, user_email, role)
  select 'zoomy', lower(email), 'company_admin'::public.company_role
  from public.pos_dashboard_users
  on conflict (user_email, company_id) do nothing;

-- Goldline is added when onboarding begins (kept commented so this migration is
-- Zoomy-safe to run today):
--   insert into public.companies (id, name) values ('goldline', 'Goldline Cosmetics')
--     on conflict (id) do nothing;
--   -- v1 "Goldline User" (= company_admin) and the data-blind Coop Admin, once
--   -- their Google identities are known:
--   insert into public.company_users (company_id, user_email, role) values
--     ('goldline', 'rhea.lim@goldline.ph', 'company_admin'),
--     (null,       'ops@stratpoint.com',   'coop_admin')
--     on conflict (user_email, company_id) do nothing;
