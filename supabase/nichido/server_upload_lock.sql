-- Lock the server-upload functions to the database itself. Run right after the server_upload_*
-- files. Safe to re-run.
--
-- Supabase's default privileges let anon and authenticated execute every new function in public,
-- and the server_upload_* files never took that back. These three are SECURITY DEFINER: they read
-- the Vault (read URL and pump secret) and start paid page reads, so anyone holding the public API
-- key could trigger them through PostgREST. Only pg_cron calls them, as their owner, so no role
-- needs a grant.
revoke all on function public.goldline_pump_reads(integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.goldline_reap_stalls(integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.goldline_poll_batches() from public, anon, authenticated, service_role;

-- Refuse to finish if any API role can still run one of them.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as fn, g.role
    from pg_proc p
    cross join (values ('anon'), ('authenticated'), ('service_role')) as g(role)
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('goldline_pump_reads', 'goldline_reap_stalls', 'goldline_poll_batches')
      and has_function_privilege(g.role, p.oid, 'execute')
  loop
    raise exception '% can still run %', r.role, r.fn;
  end loop;
end $$;
