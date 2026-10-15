-- Per-person view preferences for multi-role users (additive; Staging first).
--   last_view    — the view they most recently switched to (a company id, or the
--                  'coop_admin' sentinel). The default starting view at sign-in.
--   default_view — a view they pinned in Settings ("Starting view"); when set and
--                  still held, it wins over last_view at every sign-in.
-- Keys are hints: the app always re-validates against company_users, so a stale
-- value can never grant access. Service-role only (RLS on, no policies, revoked).

create table if not exists public.company_user_prefs (
  user_email   text primary key,
  default_view text,
  last_view    text,
  updated_at   timestamptz not null default now(),
  constraint company_user_prefs_email_lower check (user_email = lower(user_email)),
  constraint company_user_prefs_view_shape check (
    (default_view is null or default_view ~ '^[a-z0-9_-]{1,64}$') and
    (last_view    is null or last_view    ~ '^[a-z0-9_-]{1,64}$')
  )
);

alter table public.company_user_prefs enable row level security;
revoke all on public.company_user_prefs from anon, authenticated;

comment on table public.company_user_prefs is
  'Starting-view preferences per user (last used + pinned default). Service-role only.';
