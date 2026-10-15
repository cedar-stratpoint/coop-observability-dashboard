-- LOCAL FIXTURE ONLY (Train 3 direct reads). Never apply to a hosted project. Re-runnable.
-- scripts/local-supabase/up.sh --explore applies it AFTER supabase/coop_chat_explore_direct.sql, so every object here also
-- exercises the event trigger. Secret-shaped values are BUILT at apply time (concatenation, md5), so no secret-looking literal is
-- committed (this repo is public).
alter table public.pos_orders enable row level security; -- RLS on, no policy (like the hosted tables): proves BYPASSRLS

drop view if exists public.explore_fixture_token_view, public.explore_fixture_alias_view, public.explore_fixture_row_view, public.explore_fixture_sd_view;
drop view if exists public.explore_fixture_wrap_view, public.explore_fixture_op_view;
drop view if exists public.explore_fixture_qxml_view, public.explore_fixture_tsstat_view, public.explore_fixture_domain_view;
drop domain if exists public.explore_fixture_dom;
drop function if exists public.explore_fixture_chk(integer);
drop operator if exists public.### (integer, integer);
drop function if exists public.explore_fixture_wrap_rows(), public.explore_fixture_sd_secret(integer, integer);
drop function if exists public.explore_fixture_sd_rows();
drop table if exists public.marketplace_tokens, public.explore_fixture_mixed, public.explore_fixture_notes, public.gl_fixture_stores;

create table public.marketplace_tokens (marketplace text primary key, access_token text, refresh_token text, updated_at timestamptz default now());
insert into public.marketplace_tokens (marketplace, access_token, refresh_token) values ('lazada', 'fixture-token-' || md5('a'), 'fixture-token-' || md5('b'));
alter table public.marketplace_tokens enable row level security;

create table public.explore_fixture_mixed (id int primary key, label text, api_key text);
insert into public.explore_fixture_mixed values (1, 'safe label', 'fixture-token-' || md5('c'));

create table public.explore_fixture_notes (id int primary key, note text, payload jsonb);
insert into public.explore_fixture_notes values
  (1, 'sk-' || repeat('x9', 12), jsonb_build_object('lazada', jsonb_build_object('access_token', 'fixture-token-' || md5('d')))),
  (2, 'eyJ' || repeat('a', 12) || '.' || repeat('b', 12) || '.' || repeat('c', 12), '{}'::jsonb),
  (3, 'plain note 12345, nothing secret', '{"price": 129.5, "sku": "P1"}'::jsonb);

-- Task 9 attack suite (test/support/direct-read-attacks.mjs): JSON under secret-shaped keys with SHORT planted values (no shape rule
-- can see "shorty": only the key rules can), request headers stored as jsonb, cut-short and double-encoded JSON, 202 rows for the
-- span bound, and the over-hiding controls. An open table with no secret column: the event trigger grants it whole.
drop table if exists public.explore_fixture_payloads;
create table public.explore_fixture_payloads (id int primary key, note text, payload jsonb);
insert into public.explore_fixture_payloads (id, payload) values
  (1,  '{"api_key": "shorty", "token": "shorty", "accessToken": "shorty", "apiKey": "shorty", "APIKey": "shorty", "lazada": {"refreshToken": "shorty"}}'),
  (2,  '{"apiKey":"shorty","clientSecret":"s2"}'),
  (3,  '{"tokens":{"lazada":"short"}}'),
  (4,  '{"token": "shorty-planted-value"}'),
  (5,  '{"token":"shorty"}'),
  (6,  '{"$token":"shorty"}'),
  (7,  '{"lazada:token":"shorty"}'),
  (8,  '{"@token":"shorty"}'),
  (9,  '{"apiKey": "shorty-unterminated"}'),
  (10, '{"shop": {"token": "shorty"}}'),
  (11, '{"headers":{"Authorization":"Bearer shorty","Cookie":"sid=shorty","Set-Cookie":"x"}}'),
  (12, '{"bearer":"shorty","passphrase":"shorty","jwt":"shorty","otp":"shorty","cvv":"shorty","cvc":"shorty"}'),
  (13, '{"access_token": "shorty"}'),
  (14, '{"key":"color","value":"red"}'),
  (15, '{"monkey":"banana","isPinned":true,"keyword":"jerky","hashtag":"zoomy"}');
insert into public.explore_fixture_payloads (id, note) values
  (20, md5('t9') || left(md5('t10'), 8)), -- a 40-character hex token, built at apply time
  (21, 'sort key=price'),
  (22, 'chickenjerkytreatsforsmalldogs100g');
insert into public.explore_fixture_payloads (id, payload) select n, jsonb_build_object('n', n) from generate_series(1000, 1200) n;
insert into public.explore_fixture_payloads (id, payload) values (1201, to_jsonb('{"token":"shorty"}'::text)); -- double-encoded, last

-- Innocent names over a closed table and over a secret column: must NOT be granted (Review Focus 1)
create view public.explore_fixture_token_view as select m.marketplace, m.updated_at from public.marketplace_tokens m;
create view public.explore_fixture_alias_view as select x.id, x.api_key as label2 from public.explore_fixture_mixed x;
-- Whole-row read (pg_depend records column 0, no per-column dependency): must NOT be granted either
create view public.explore_fixture_row_view as select to_jsonb(x) as j from public.explore_fixture_mixed x;
-- Whole row through a SECURITY DEFINER function: the view's pg_depend records only the function, never the table. Must NOT be granted.
-- EXECUTE goes to the login only (PUBLIC would expose it to anon through PostgREST); zoomy-pos definer RPCs are PUBLIC on the hosted project.
create function public.explore_fixture_sd_rows() returns setof public.explore_fixture_mixed
  language sql stable security definer set search_path = '' as $$ select * from public.explore_fixture_mixed $$;
revoke all on function public.explore_fixture_sd_rows() from public, anon, authenticated;
grant execute on function public.explore_fixture_sd_rows() to coop_explore_ro;
create view public.explore_fixture_sd_view as select to_jsonb(f) as j from public.explore_fixture_sd_rows() f;
-- The same definer function one step removed: pg_depend of these views records only the wrapper (an INVOKER plpgsql function) or the
-- operator, never the definer function. Both must NOT be granted (reads_closed closes any view that calls a non-pg_catalog function).
create function public.explore_fixture_wrap_rows() returns setof public.explore_fixture_mixed
  language plpgsql stable set search_path = '' as $$ begin return query select * from public.explore_fixture_sd_rows(); end $$;
revoke all on function public.explore_fixture_wrap_rows() from public, anon, authenticated;
grant execute on function public.explore_fixture_wrap_rows() to coop_explore_ro;
create view public.explore_fixture_wrap_view as select to_jsonb(w) as j from public.explore_fixture_wrap_rows() w;
create function public.explore_fixture_sd_secret(a integer, b integer) returns text
  language sql stable security definer set search_path = '' as $$ select m.api_key from public.explore_fixture_mixed m where m.id = a $$;
revoke all on function public.explore_fixture_sd_secret(integer, integer) from public, anon, authenticated;
grant execute on function public.explore_fixture_sd_secret(integer, integer) to coop_explore_ro;
create operator public.### (leftarg = integer, rightarg = integer, function = public.explore_fixture_sd_secret);
create view public.explore_fixture_op_view as select 1 ### 1 as j;
-- Fix round 4: routes the shape rules (reads_closed) do NOT see. All must stay ungranted because views are DEFAULT-DENY: none of
-- these names is in coop_explore_admin.view_allowlist().
-- Query-running pg_catalog functions: the SQL string is invisible to pg_depend, and it runs a definer function the login may EXECUTE.
create view public.explore_fixture_qxml_view as
  select query_to_xml('select to_jsonb(f) as j from public.explore_fixture_sd_rows() f', true, false, '') as x;
create view public.explore_fixture_tsstat_view as
  select s.word from ts_stat('select to_tsvector(''simple'', f.api_key) from public.explore_fixture_sd_rows() f') s;
-- A domain CHECK reached through a pg_type dependency: the view names only the type, the CHECK calls a definer function.
create function public.explore_fixture_chk(v integer) returns boolean
  language plpgsql stable security definer set search_path = '' as $$
  begin raise exception 'domain check saw: %', (select m.api_key from public.explore_fixture_mixed m where m.id = v); end $$;
revoke all on function public.explore_fixture_chk(integer) from public, anon, authenticated;
grant execute on function public.explore_fixture_chk(integer) to coop_explore_ro;
create domain public.explore_fixture_dom as integer check (public.explore_fixture_chk(value));
create view public.explore_fixture_domain_view as select 1::public.explore_fixture_dom as v;

-- Tenant fence
create table public.gl_fixture_stores (store_code text primary key, name text);
insert into public.gl_fixture_stores values ('S1', 'Fixture store');
create table if not exists public.companies (id text primary key, name text);
insert into public.companies (id, name) values ('zoomy', 'Zoomy') on conflict do nothing;

-- Saved reports for the golden case G31 (3 rows: 1 pinned, 1 deleted). Columns per supabase/coop_reports.sql (no foreign key from current_version).
delete from public.coop_reports where owner_email = 'fixture@example.com';
insert into public.coop_reports (owner_email, title, visibility, pinned, current_version, deleted_at) values
  ('fixture@example.com', 'Fixture: weekly bundles', 'team', true, 1, null),
  ('fixture@example.com', 'Fixture: pet mix', 'private', false, 1, null),
  ('fixture@example.com', 'Fixture: old report', 'team', false, 1, now());
