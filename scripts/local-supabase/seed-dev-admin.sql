-- LOCAL ONLY, idempotent. Makes the dev-bypass identity (src/dev-auth.ts: dev@localhost) a Coop Admin AND a Zoomy company admin
-- in the local database, so up.sh/dev.sh always leave the dev user able to edit /health-report (Fill in now, Monthly close, Edit targets, typed cells).
-- Wired into scripts/local-supabase/up.sh apply_sql. Never run against a hosted project.
do $$ begin
  if to_regclass('public.company_users') is null or to_regclass('public.companies') is null then
    raise notice 'seed-dev-admin: company tables not found, skipped';
    return;
  end if;
  insert into public.companies (id, name) values ('zoomy', 'Zoomy') on conflict (id) do nothing;
  delete from public.company_users where user_email = 'dev@localhost' and company_id is null;  -- NULL company_id defeats the unique key
  insert into public.company_users (company_id, user_email, role) values (null, 'dev@localhost', 'coop_admin');
  insert into public.company_users (company_id, user_email, role) values ('zoomy', 'dev@localhost', 'company_admin') on conflict (user_email, company_id) do update set role = excluded.role;
end $$;
