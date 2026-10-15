-- coop_chat_explore_direct_checks.sql: SELECT-only checks after supabase/coop_chat_explore_direct.sql. Safe on staging and PROD:
-- nothing here writes, and nothing prints a row of table data (only names, types, counts and privileges).
-- Run in the SQL editor as postgres. The expected result is above each query. Owner: zoomy-observability-dashboard (Ask Coop, Train 3).
-- Best practice: knowledge/best-practices/chat-direct-read-access.md. Local proof: scripts/coop-explore-ro-proof.mjs.
--
-- KNOWN LIMITS (accepted; read them before calling a result a bug):
--   * A GRANT ... TO PUBLIC (or to the login) made by supabase_admin, another superuser or a reserved role skips the event trigger
--     (Supabase never fires user event triggers for them): the login can read it until the next coop_explore_reapply run, at most
--     5 minutes. (d) must show that job active.
--   * apply_grants covers the public schema only. Other schemas are fenced by USAGE: (b) other_schemas must be empty.
--   * Views are default-deny: a new view (Task 8's included) is unreadable until it is added to coop_explore_admin.view_allowlist()
--     and the data catalog. (b) unlisted_views names them; a name there is a to-do (allowlist it or leave it closed), not a leak.
--   * A rollback cannot restore PUBLIC grants that apply_grants removed from closed relations: take the snapshot (0) BEFORE the first
--     apply, and keep the apply output (each removal prints `NOTICE: coop_explore_admin: revoked SELECT from PUBLIC on ...`).

-- (0) PRE-APPLY SNAPSHOT: run ONCE per environment BEFORE the first apply of coop_chat_explore_direct.sql, and keep the result with
-- the environment notes (knowledge/data-catalog/index.md "Environment notes"). Every PUBLIC grant on a public relation; names and
-- privileges only, no data. After the apply, PUBLIC may have lost SELECT on the closed ones listed here.
select c.relname, c.relkind, a.privilege_type, a.is_grantable
from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) a
where n.nspname = 'public' and a.grantee = 0 order by 1, 3;

-- (a) role: EXPECT t|f|f|f|f|f|t|10 (login, not super, NOINHERIT, no createrole/createdb/replication, BYPASSRLS, limit 10)
select rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolconnlimit
from pg_roles where rolname = 'coop_explore_ro';

-- (a2) memberships: EXPECT 0 rows. The login is NOINHERIT, so a granted role never shows in has_*_privilege, but SET ROLE reaches it.
select pg_get_userbyid(m.roleid) as member_of from pg_auth_members m where m.member = 'coop_explore_ro'::regrole;

-- (b) drift. HOSTED BASELINE: every SECURITY key empty (closed_readable, secret_columns_readable, write_privileges, unreadable_open,
-- role, guard, other_schemas), and unlisted_views listing ONLY views waiting to be allowlisted (today: the Task 8 views until they are
-- added). unlisted_views is a to-do list, not counted in findings_count. The daily job logs the same into coop_explore_drift_log.
select jsonb_pretty(coop_explore_admin.drift_findings());

-- (b2) the same two lists the drift job is built on, as rows. readable_closed: EXPECT 0 rows. unlisted_views: a 'STILL READABLE' line
-- is a finding; the other lines are views waiting for the allowlist. (This function also lists views closed by NAME, e.g. a *_token_view;
-- the drift job leaves those out, because they are closed on purpose and can never be allowlisted.)
select * from coop_explore_admin.readable_closed();
select * from coop_explore_admin.unlisted_views();

-- (c) guard: EXPECT one row, evtenabled = O, owner postgres
select evtname, evtevent, evtenabled, evtowner::regrole as owner from pg_event_trigger where evtname = 'coop_explore_guard_ddl';

-- (d) cron: EXPECT coop_explore_drift (0 22 * * *) and coop_explore_reapply (*/5 * * * *), both active. Errors if pg_cron is off.
select jobname, schedule, active from cron.job where jobname like 'coop\_explore\_%' order by jobname;
-- (d2) the last runs of both jobs: EXPECT status succeeded
select j.jobname, d.status, d.start_time from cron.job_run_details d join cron.job j on j.jobid = d.jobid
where j.jobname like 'coop\_explore\_%' order by d.start_time desc limit 6;

-- (e) default privileges: EXPECT one row: for_role postgres, schema public, type r, SELECT, grantable f
select pg_get_userbyid(d.defaclrole) as for_role, n.nspname, d.defaclobjtype, a.privilege_type, a.is_grantable
from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a
where a.grantee = 'coop_explore_ro'::regrole;

-- (f) access per relation: REVIEW BY EYE. 'closed: ...' = never granted (the reason says why); 'some columns' = a secret column is
-- hidden; 'NOT READABLE' must be empty (otherwise see drift unreadable_open). A 'closed' row the login can read is in (b2).
select c.relname, c.relkind,
  case when coop_explore_admin.closed_reason(c.oid) is not null then 'closed: ' || coop_explore_admin.closed_reason(c.oid)
       when has_table_privilege('coop_explore_ro', c.oid, 'SELECT') then 'readable'
       when has_any_column_privilege('coop_explore_ro', c.oid, 'SELECT') then 'some columns'
       else 'NOT READABLE' end as access
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
order by 3, 1;

-- (g) the last drift rows: EXPECT findings_count 0 (security findings only) and a checked_at within the last day
select checked_at, findings_count from public.coop_explore_drift_log order by checked_at desc limit 3;

-- (h) ONE-TIME COLUMN REVIEW (spec 1.5): every column in public, NAMES AND TYPES ONLY (no row data; column_default is left out on
-- purpose, since a default can hold a literal value). Read the worth_a_look = true rows first, then the rest, for secrets stored under
-- an innocent name (a token in a "note", a password in "value", a key inside a jsonb "payload"). hidden_by_name = true means the login
-- cannot read it already. Record the result (date, environment, who, any column to close) in knowledge/data-catalog/index.md
-- "Column review"; a column to close gets a reviewed rename or a new secret part, never a silent edit.
select c.table_name, t.table_type, c.column_name, c.data_type,
  coop_explore_admin.is_closed_table(c.table_name) as table_closed,
  coop_explore_admin.is_secret_column(c.table_name, c.column_name) as hidden_by_name,
  c.column_name ~* '(pass|pwd|tok|secret|key|pin|hash|cred|auth|session|otp|salt|sig|cookie|bearer|api|private|cert)' as worth_a_look
from information_schema.columns c
join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
where c.table_schema = 'public'
order by worth_a_look desc, c.table_name, c.ordinal_position;
