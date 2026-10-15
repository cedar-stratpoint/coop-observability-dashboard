// Role proof for Ask Coop Explore mode (spec section 5). LOCAL THROWAWAY STACK (Docker) ONLY. The validator is BYPASSED: every corpus
// row goes straight to the database as the login role coop_explore_ro, in three modes, so that what the database refuses on its own
// is proven separately from what the parser refuses (the parser is layer 2 of 5; this script proves layers 1, 3 and 5).
// Env (from scripts/local-supabase/.local-env, written by `up.sh --explore`): EXPLORE_DATABASE_URL, SB_PSQL_CMD.
//   set -a; . scripts/local-supabase/.local-env; set +a; node scripts/coop-explore-ro-proof.mjs
// Exit code 1 on any FAIL. Never prints a URL, a password or a row of customer data.
import postgres from 'postgres'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { assertLocalPostgres } from './local-only.mjs'
import { EXPLORE_EXTRA_CORPUS, EXPLORE_NEGATIVE_CORPUS, EXPLORE_POSITIVE_CORPUS } from '../test/support/explore-corpus.mjs'
import { DIRECT_READ_ATTACKS } from '../test/support/direct-read-attacks.mjs'

const URL_ = process.env.EXPLORE_DATABASE_URL
assertLocalPostgres(URL_) // first: this script never opens a connection to anything but the local stack
const PSQL = process.env.SB_PSQL_CMD
if (!PSQL || !/^docker exec -i coop-local-db /.test(PSQL)) throw new Error('set SB_PSQL_CMD to the local container psql command (docker exec -i coop-local-db psql ...)')

const ROLE = 'coop_explore_ro'
const CURSOR = 'coop_explore_c'
const wrap = (sql) => `DECLARE ${CURSOR} NO SCROLL CURSOR FOR ${sql}` // = wrapCursor() in src/chat/explore/parse.ts (a test pins them equal)
const FETCH = 'FETCH FORWARD 201 FROM coop_explore_c'
const ENVELOPE = ['BEGIN READ ONLY', "SET LOCAL statement_timeout = 5000", "SET LOCAL lock_timeout = 2000", "SET LOCAL timezone = 'Asia/Manila'", "SET LOCAL search_path = public, pg_temp"]
const TIMEOUT_MS = 5000
const MUST_CODES = new Set(['42501', '25006', '42P01', '42883', '42601', '0A000', '3F000', '42809', '55000', '54000', '42703', '428C9'])
// 42703 undefined_column (a blocked or unknown column), 428C9 generated_always (an INSERT into the identity column of an auto-updatable view
// is refused at analysis, before the privilege check; the role holds no INSERT anyway, see step (a)). Both are the database refusing on its own.

const admin = (sql, extra = '') => execSync(`${PSQL} ${extra} 2>&1`, { input: sql, encoding: 'utf8', maxBuffer: 1 << 24 })
const q = (sql) => admin(sql, '-t -A -F"|"').trim()

let pass = 0, fail = 0
const rec = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + String(detail).replace(/\s+/g, ' ').slice(0, 220) : ''}`) }

const connect = () => postgres(URL_, { max: 1, prepare: false, idle_timeout: 2, connect_timeout: 5, onnotice: () => {} })
/** One case on its own connection. Returns {outcome: 'rejected'|'executed', code, rows, ms}. */
async function run(fn) {
  const sql = connect()
  const t0 = Date.now()
  try {
    const rows = await fn(sql)
    return { outcome: 'executed', rows, ms: Date.now() - t0 }
  } catch (e) {
    return { outcome: 'rejected', code: String(e.code ?? e.name ?? 'ERR'), msg: String(e.message ?? ''), ms: Date.now() - t0 }
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {})
  }
}
const rollback = (sql) => sql.unsafe('ROLLBACK').catch(() => {})
/** M1: the string as written, autocommit, simple protocol, role defaults only. */
export const m1 = (text) => run((sql) => sql.unsafe(text))
/** M2: the string as written inside the executor's envelope (READ ONLY + SET LOCALs), simple protocol, then ROLLBACK. */
export const m2 = (text) => run(async (sql) => {
  try {
    await sql.unsafe(`${ENVELOPE.join('; ')}`)
    return await sql.unsafe(text)
  } finally { await rollback(sql) }
})
/** M3: as production: the envelope, DECLARE ... CURSOR FOR <sql>, FETCH 201, EXTENDED protocol (no simple), then ROLLBACK. */
export const m3 = (text) => run(async (sql) => {
  try {
    await sql.unsafe(ENVELOPE.join('; '))
    await sql.unsafe(wrap(text), [], { simple: false })
    return await sql.unsafe(FETCH, [], { simple: false })
  } finally { await rollback(sql) }
})

const label = (r) => (r.outcome === 'rejected' ? `rejected ${r.code}` : `executed (${r.rows?.length ?? 0} rows)`)
const rejectedByDb = (r) => r.outcome === 'rejected' && MUST_CODES.has(r.code)

// ---- 0. the role as the database sees it --------------------------------------------------------------------------------------
{
  const row = q(`select rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolconnlimit from pg_roles where rolname = '${ROLE}'`)
  rec('role attributes: login, BYPASSRLS (Train 3), no super/inherit/createrole/createdb/replication, connection limit 10', row === 't|f|f|f|f|f|t|10', row)
  const members = q(`select count(*) from pg_auth_members where member = (select oid from pg_roles where rolname = '${ROLE}')`)
  rec('role is a member of no other role (NOINHERIT hides a membership from privilege checks; SET ROLE would still reach it)', members === '0', members)
  const settings = q(`select string_agg(c, ',' order by c) from pg_db_role_setting s cross join unnest(s.setconfig) c where s.setrole = (select oid from pg_roles where rolname = '${ROLE}')`)
  rec('role default settings include read-only and the 5s timeout', /default_transaction_read_only=on/.test(settings) && /statement_timeout=5s/.test(settings), settings)
}

// ---- (a) privileges: direct reads (Train 3). Tables open unless closed by name; views only when allowlisted --------------------
// The fixture's trap views (scripts/coop-direct-fixture.sql) are unlisted ON PURPOSE, so the drift job always lists exactly these locally.
const FIXTURE_UNLISTED = ['explore_fixture_alias_view', 'explore_fixture_domain_view', 'explore_fixture_op_view', 'explore_fixture_qxml_view', 'explore_fixture_row_view', 'explore_fixture_sd_view', 'explore_fixture_tsstat_view', 'explore_fixture_wrap_view']
const DRIFT_KEYS = ['closed_readable', 'guard', 'other_schemas', 'role', 'secret_columns_readable', 'unlisted_views', 'unreadable_open', 'write_privileges']
const drift = () => JSON.parse(q('select coop_explore_admin.drift_findings()::text'))
const driftClean = (f) => Object.entries(f).every(([k, v]) => (k === 'unlisted_views' ? JSON.stringify(v) === JSON.stringify(FIXTURE_UNLISTED) : v.length === 0))
{
  const f = drift()
  rec('(a) drift_findings has exactly the documented keys', JSON.stringify(Object.keys(f).sort()) === JSON.stringify(DRIFT_KEYS), Object.keys(f).sort().join(','))
  for (const [k, v] of Object.entries(f)) {
    if (k === 'unlisted_views') rec('(a) drift_findings.unlisted_views is exactly the fixture trap views (unlisted on purpose)', JSON.stringify(v) === JSON.stringify(FIXTURE_UNLISTED), JSON.stringify(v))
    else rec(`(a) drift_findings.${k} is empty`, Array.isArray(v) && v.length === 0, JSON.stringify(v))
  }
  const rc = q('select count(*) from coop_explore_admin.readable_closed()')
  rec('(a) readable_closed() is empty (no closed relation or secret column is readable, whoever granted it)', rc === '0', rc)
  const create = q(`select has_schema_privilege('${ROLE}', 'public', 'CREATE')`)
  rec('(a) no CREATE on schema public', create === 'f', create)
  const exposed = q(`select string_agg(c.relname || ':' || coalesce(pg_get_userbyid(nullif(a.grantee, 0)), 'PUBLIC'), ',') from pg_class c cross join lateral aclexplode(coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) a where c.relname like 'coop\\_explore\\_%' and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon','authenticated'))`)
  rec('(a) PUBLIC, anon and authenticated hold nothing on the coop_explore_ views, the drift log or its sequence', exposed === '', exposed)
  // every public TABLE is readable unless its name is closed (secret or tenant); a mixed table is readable on its safe columns only
  const tables = q(`select string_agg(c.relname, ',' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where c.relkind in ('r','p') and coop_explore_admin.is_closed_table(c.relname) = has_any_column_privilege('${ROLE}', c.oid, 'SELECT')`)
  rec('(a) every public table is readable except the secret- and tenant-named ones (catalog check)', tables === '', tables)
  const plain = q(`select string_agg(c.relname, ',' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where c.relkind in ('r','p') and not coop_explore_admin.is_closed_table(c.relname) and not has_table_privilege('${ROLE}', c.oid, 'SELECT')
      and not exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and coop_explore_admin.is_secret_column(c.relname, a.attname))`)
  rec('(a) an open table with no secret column has a whole-table grant', plain === '', plain)
  // every public VIEW (materialized view, foreign table) is readable only when allowlisted (and the second layer agrees)
  const views = q(`select string_agg(c.relname, ',' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where c.relkind in ('v','m','f') and (c.relname = any (coop_explore_admin.view_allowlist()) and not coop_explore_admin.reads_closed(c.oid)) <> has_any_column_privilege('${ROLE}', c.oid, 'SELECT')`)
  rec('(a) every public view is readable if and only if it is allowlisted (catalog check)', views === '', views)
  const allow = q('select string_agg(v, \',\' order by v) from unnest(coop_explore_admin.view_allowlist()) v').split(',')
  const allowFail = []
  for (const v of allow) { const r = await m3(`select count(*) as n from ${v} x`); if (r.outcome !== 'executed') allowFail.push(`${v}:${label(r)}`) }
  rec(`(a) all ${allow.length} allowlisted views read in M3`, allow.length === 29 && allowFail.length === 0, allowFail.join(' '))
  const open = q(`select string_agg(c.relname, ',' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where c.relkind in ('r','p') and not coop_explore_admin.is_closed_table(c.relname)`).split(',')
  const openFail = []
  for (const t of open) { const r = await m3(`select count(*) as n from ${t} x`); if (r.outcome !== 'executed') openFail.push(`${t}:${label(r)}`) }
  rec(`(a) all ${open.length} open public tables read in M3 (count(*), RLS on: BYPASSRLS)`, openFail.length === 0, openFail.join(' '))
}

// ---- (i) direct reads: new objects, closed objects, the guard, the cron path (Train 3) ------------------------------------------
// DDL here runs as postgres (non-superuser: the event trigger fires). Steps that switch the trigger OFF stand in for DDL by a
// superuser or reserved role (supabase_admin), which Supabase never sends to user event triggers; reapply_all() is the cron job body.
const denied = (r) => r.outcome === 'rejected' && r.code === '42501'
const ran = (r) => r.outcome === 'executed'
const PROBE_TABLES = ['explore_probe_new', 'explore_probe_tokens', 'gl_probe', 'company_probe', 'explore_probe_secret', 'explore_probe_cron', 'explore_probe_raise']
const PROBE_VIEWS = ['explore_probe_view2', 'explore_probe_view', 'explore_probe_plain', 'explore_probe_drift_view']
const PROBE_ROLE = 'explore_probe_member'
const DIRECT_SQL = readFileSync(new URL('../supabase/coop_chat_explore_direct.sql', import.meta.url), 'utf8')
const dropProbes = () => admin(`drop view if exists ${PROBE_VIEWS.map((v) => 'public.' + v).join(', ')}; drop table if exists ${PROBE_TABLES.map((t) => 'public.' + t).join(', ')}; drop role if exists ${PROBE_ROLE};`)
/** As the login under an explicit READ WRITE transaction: only privileges can refuse. */
const rw = (text) => run(async (sql) => { try { await sql.unsafe('start transaction read write'); return await sql.unsafe(text) } finally { await rollback(sql) } })
try {
  dropProbes()
  const o = await m3('select o.id from pos_orders o limit 1')
  rec('(i1) BYPASSRLS: pos_orders (RLS on, no policy) returns rows', ran(o) && o.rows.length === 1, label(o))
  admin('create table public.explore_probe_new (id int, note text); insert into public.explore_probe_new values (1, \'hello\')')
  rec('(i2) a new table is readable at once', ran(await m3('select p.id, p.note from explore_probe_new p')))
  admin('alter table public.explore_probe_new add column extra text')
  rec('(i2) a new safe column on an open table is readable at once', ran(await m3('select p.extra from explore_probe_new p')))
  admin('alter table public.explore_probe_new add column api_key text')
  rec('(i3) select * on the now-mixed table is refused', denied(await m3('select * from explore_probe_new p')))
  rec('(i4) a new secret column is refused at once (event trigger)', denied(await m3('select p.api_key from explore_probe_new p')))
  rec('(i5) its safe columns stay readable', ran(await m3('select p.id, p.note, p.extra from explore_probe_new p')))
  admin('alter table public.explore_probe_new add column shipping_fee numeric')
  rec('(i6) a new safe column on a mixed table is readable at once (whole-word rule: shipping_fee is not "pin")', ran(await m3('select p.shipping_fee from explore_probe_new p')))
  admin('create table public.explore_probe_tokens (id int); create table public.gl_probe (id int); create table public.company_probe (id int)')
  for (const t of ['explore_probe_tokens', 'gl_probe', 'company_probe']) rec(`(i7) new closed table ${t} is refused`, denied(await m3(`select x.id from ${t} x`)))
  rec('(i8) the secret table, the secret column and select * on a mixed table are refused', denied(await m3('select m.marketplace from marketplace_tokens m')) && denied(await m3('select x.api_key from explore_fixture_mixed x')) && denied(await m3('select * from explore_fixture_mixed x')))
  rec('(i8) companies and gl_fixture_stores (tenant fence) are refused', denied(await m3('select c.id from companies c')) && denied(await m3('select g.store_code from gl_fixture_stores g')))
  admin('create view public.explore_probe_view as select m.marketplace from public.marketplace_tokens m; create view public.explore_probe_view2 as select v.marketplace from public.explore_probe_view v')
  rec('(i9) a view over a closed table is refused, also one level up', denied(await m3('select v.marketplace from explore_probe_view v')) && denied(await m3('select v.marketplace from explore_probe_view2 v')))
  admin('create view public.explore_probe_plain as select o.id from public.pos_orders o')
  rec('(i9) a new innocent view over an open table is refused: views are default-deny until allowlisted', denied(await m3('select v.id from explore_probe_plain v')))
  admin(`grant select on public.explore_probe_plain to public; grant select on public.explore_probe_plain to ${ROLE}`)
  rec('(i9) an unlisted view granted to PUBLIC and to the login stays unreadable (event trigger)', denied(await m3('select v.id from explore_probe_plain v')))
  const fixtureViews = []
  for (const v of [...FIXTURE_UNLISTED, 'explore_fixture_token_view']) { const r = await m3(`select * from ${v} v`); if (!denied(r)) fixtureViews.push(`${v}:${label(r)}`) }
  rec('(i10) all nine fixture trap views are refused (closed table, secret column, whole row, definer, wrapper, operator, query_to_xml, ts_stat, domain)', fixtureViews.length === 0, fixtureViews.join(' '))
  admin(`grant select on public.marketplace_tokens to ${ROLE}`)
  rec('(i11) a hand-made grant on a closed table is stripped at once by the trigger', denied(await m3('select m.marketplace from marketplace_tokens m')))
  admin('grant select on public.marketplace_tokens to public; grant select (api_key) on public.explore_fixture_mixed to public')
  rec('(i11) a grant TO PUBLIC on a closed table or a secret column is stripped at once', denied(await m3('select m.marketplace from marketplace_tokens m')) && denied(await m3('select x.api_key from explore_fixture_mixed x')))
  admin(`grant insert on public.pos_orders to ${ROLE}`)
  rec('(i12) a hand-made INSERT grant is stripped at once', q(`select has_table_privilege('${ROLE}', 'public.pos_orders', 'INSERT')`) === 'f')
  const writes = { insert: await rw('insert into pos_orders (total) values (1)'), update: await rw('update pos_orders set total = 0'), delete: await rw('delete from pos_orders'), truncate: await rw('truncate pos_settings') }
  rec('(i12) under an explicit READ WRITE transaction, INSERT, UPDATE, DELETE and TRUNCATE are refused by privileges (42501)', Object.values(writes).every(denied), Object.entries(writes).map(([k, r]) => `${k} ${label(r)}`).join(', '))
  // the cron path: the trigger is OFF (a superuser's DDL), then reapply_all() (the coop_explore_reapply job body) closes what slipped
  admin('create table public.explore_probe_cron (id int, note text); insert into public.explore_probe_cron values (1, \'x\')')
  admin('alter event trigger coop_explore_guard_ddl disable')
  admin(`create table public.explore_probe_secret (id int); alter table public.explore_probe_cron add column refresh_token text; grant select on public.explore_probe_plain to ${ROLE}`)
  const before = [await m3('select x.id from explore_probe_secret x'), await m3('select x.refresh_token from explore_probe_cron x'), await m3('select v.id from explore_probe_plain v')]
  console.log(`INFO (i13) with the trigger OFF: new secret-named table ${label(before[0])}, new secret column ${label(before[1])}, unlisted view granted ${label(before[2])} (the cron window, at most 5 minutes)`)
  const changed = q('select coop_explore_admin.reapply_all()')
  admin('alter event trigger coop_explore_guard_ddl enable')
  rec(`(i13) reapply_all (the cron job body, changed ${changed}) closes the new secret table, the new secret column and the unlisted view`, denied(await m3('select x.id from explore_probe_secret x')) && denied(await m3('select x.refresh_token from explore_probe_cron x')) && denied(await m3('select v.id from explore_probe_plain v')))
  rec('(i13) the safe columns of that table stay readable after the cron pass', ran(await m3('select x.id, x.note from explore_probe_cron x')))
  rec('(i15) auth, storage and vault are refused', denied(await m3('select u.id from auth.users u')) && denied(await m3('select o.id from storage.objects o')) && denied(await m3('select s.id from vault.secrets s')))
  rec('(i15) the private helper schema is refused', denied(await m3('select coop_explore_admin.reapply_all() as n')))
  const setRole = await m1('set role postgres')
  rec('(i15) SET ROLE is refused (42501)', denied(setRole), label(setRole))
  const copies = [await m1("copy pos_orders to program 'true'"), await m1("copy pos_orders to '/tmp/explore_probe_copy'"), await m1("copy pos_orders from '/etc/hostname'")]
  rec('(i16) COPY TO PROGRAM, COPY TO a server file and COPY FROM a server file are refused (42501)', copies.every(denied), copies.map(label).join(', '))
  rec('(i17) pos_settings.key (the reviewed exception) is readable', ran(await m3('select s.key, s.value from pos_settings s')))
  rec('(i18) the login reads the drift log through the envelope (what /api/chat/health runs)', ran(await m3('select d.checked_at, d.findings_count from coop_explore_drift_log d order by d.checked_at desc limit 1')))

  // ---- (j) the drift job reports injected problems: an unlisted view, a role membership, a closed relation readable ---------------
  admin('drop view public.explore_probe_view2, public.explore_probe_view, public.explore_probe_plain') // so only the injected problems show
  admin('create view public.explore_probe_drift_view as select o.id from public.pos_orders o')
  admin(`create role ${PROBE_ROLE} nologin; grant ${PROBE_ROLE} to ${ROLE}`)
  const viaSetRole = await m1(`set role ${PROBE_ROLE}`)
  console.log(`INFO (j) with a plain membership, the NOINHERIT login can still 'set role ${PROBE_ROLE}': ${label(viaSetRole)} (why the drift job checks memberships)`)
  admin(`alter event trigger coop_explore_guard_ddl disable; grant select on public.marketplace_tokens to ${ROLE}`)
  const leak = await m3('select count(*) as n from marketplace_tokens m')
  console.log(`INFO (j) with the trigger OFF, a direct grant on marketplace_tokens: the login ${label(leak)}`)
  const inj = drift()
  console.log(`INFO (j) drift_findings with injected problems: ${JSON.stringify(inj)}`)
  rec('(j) drift reports the unlisted view', inj.unlisted_views.includes('explore_probe_drift_view'), JSON.stringify(inj.unlisted_views))
  rec('(j) drift reports the role membership', inj.role.includes(`member of ${PROBE_ROLE}`), JSON.stringify(inj.role))
  rec('(j) drift reports the closed relation the login can read', inj.closed_readable.includes('marketplace_tokens (secret or tenant name)'), JSON.stringify(inj.closed_readable))
  rec('(j) drift reports the disabled event trigger', inj.guard.some((g) => /coop_explore_guard_ddl/.test(g)), JSON.stringify(inj.guard))
  const n = Number(q('select coop_explore_admin.record_drift()').split('\n').pop()) // the WARNING it raises comes first
  const logged = q('select d.findings_count from coop_explore_drift_log d order by d.id desc limit 1')
  rec('(j) record_drift() counts the 3 security findings (role, guard, closed_readable; unlisted_views is a to-do, not counted) and logs the count', n === 3 && logged === String(n), `${n} / logged ${logged}`)
  admin(`revoke ${PROBE_ROLE} from ${ROLE}; drop role ${PROBE_ROLE}; drop view public.explore_probe_drift_view; alter event trigger coop_explore_guard_ddl enable; select coop_explore_admin.reapply_all()`)
  const after = drift()
  rec('(j) after cleanup and one reapply_all, the drift job is clean again', driftClean(after), JSON.stringify(after))
  admin('alter event trigger coop_explore_guard_ddl enable replica') // evtenabled R: fires only for replication sessions, i.e. never here
  const replica = drift().guard
  admin('alter event trigger coop_explore_guard_ddl enable')
  rec('(j) drift reports a replica-only event trigger (it never fires for ordinary sessions)', replica.some((g) => /coop_explore_guard_ddl/.test(g)), JSON.stringify(replica))

  // (i14) last, because it breaks reads_closed until the file is re-applied in `finally`
  admin(`create or replace function coop_explore_admin.reads_closed(rel oid) returns boolean language plpgsql as $$ begin raise exception 'probe failure'; end $$`)
  const out = admin("create table public.explore_probe_raise (id int); select 'created-ok'")
  rec('(i14) a failing guard never aborts the DDL: the table is created and a WARNING is logged', /created-ok/.test(out) && /WARNING/.test(out), out)
} finally {
  admin(`alter event trigger coop_explore_guard_ddl enable; revoke insert on public.pos_orders from ${ROLE}`)
  dropProbes()
  admin(DIRECT_SQL) // restores reads_closed after (i14), re-applies every grant and logs a fresh drift row
}
{
  const f = drift()
  rec('(i) after the probes: no probe object is left, the trigger is enabled and the drift job is clean', q(`select count(*) from pg_class where relname like 'explore\\_probe\\_%' or relname in ('gl_probe', 'company_probe')`) === '0' && q("select evtenabled from pg_event_trigger where evtname = 'coop_explore_guard_ddl'") === 'O' && driftClean(f), JSON.stringify(f))
}

// ---- (k) Train 3 attack suite against the database (validator bypassed; test/support/direct-read-attacks.mjs) ---------------------
// MUST rows: the database alone refuses in all three modes. PARSER rows: recorded (the database would run them; the guard is the
// layer). SCAN rows: test/chat-explore-scan.integration.test.ts (the scanner in client.ts is the layer).
for (const x of DIRECT_READ_ATTACKS) {
  if (x.db === 'MUST') {
    const r1 = await m1(x.sql), r2 = await m2(x.sql), r3 = await m3(x.sql)
    rec(`(k) ${x.id} MUST (${x.category}): the database alone refuses in M1, M2 and M3`, rejectedByDb(r1) && rejectedByDb(r2) && rejectedByDb(r3), `M1 ${label(r1)}, M2 ${label(r2)}, M3 ${label(r3)}`)
  } else if (x.db === 'PARSER') {
    console.log(`INFO (k) ${x.id} PARSER-only (${x.category}): M3 ${label(await m3(x.sql))}`)
  }
}

// ---- the corpus, validator bypassed ------------------------------------------------------------------------------------------
const tally = { dbAlone: 0, clock: 0, cap: 0, parserOnly: [] }
const rows = [...EXPLORE_NEGATIVE_CORPUS, ...EXPLORE_EXTRA_CORPUS]
for (const c of rows) {
  if (c.db === 'MUST') {
    const r1 = await m1(c.sql), r2 = await m2(c.sql), r3 = await m3(c.sql)
    const ok = rejectedByDb(r1) && rejectedByDb(r2) && rejectedByDb(r3)
    rec(`${c.id} MUST (${c.category}): the database alone refuses in M1, M2 and M3`, ok, `M1 ${label(r1)}, M2 ${label(r2)}, M3 ${label(r3)}`)
    if (ok) tally.dbAlone++
  } else if (c.db === 'BOUNDED') {
    const r = await m3(c.sql)
    const cancelled = r.outcome === 'rejected' && r.code === '57014'
    const refused = r.outcome === 'rejected' && MUST_CODES.has(r.code)
    const capped = r.outcome === 'executed' && r.rows.length <= 201
    const inTime = r.ms <= TIMEOUT_MS + 1000
    rec(`${c.id} BOUNDED (${c.category}): stopped by the clock, the cursor cap or a refusal, within ${TIMEOUT_MS + 1000} ms`, inTime && (cancelled || refused || capped), `M3 ${label(r)} in ${r.ms} ms`)
    if (inTime && cancelled) tally.clock++
    else if (inTime && (refused || capped)) tally.cap++
  } else if (c.db === 'PARSER') {
    const r1 = await m1(c.sql), r2 = await m2(c.sql), r3 = await m3(c.sql)
    tally.parserOnly.push(`${c.id}[M1 ${label(r1)}; M2 ${label(r2)}; M3 ${label(r3)}]`)
    console.log(`INFO ${c.id} PARSER-only (${c.category}): M1 ${label(r1)}, M2 ${label(r2)}, M3 ${label(r3)}`)
  } else if (c.db === 'OK') {
    const r = await m3(c.sql)
    const expectCode = c.runtime
    const ok = expectCode ? r.outcome === 'rejected' && r.code === '42703' : r.outcome === 'executed'
    rec(`${c.id} OK (${c.category}): the positive control runs in M3${expectCode ? ' and fails only with undefined_column' : ''}`, ok, label(r))
  } else if (c.id === 'N65' || c.id === 'N75') {
    const r = await m3(c.sql)
    rec(`${c.id} n/a (${c.category}): the driver or database refuses it raw`, r.outcome === 'rejected', label(r))
  }
}
for (const c of EXPLORE_POSITIVE_CORPUS) {
  const r = await m3(c.sql)
  rec(`${c.id} positive (${c.category}): runs in M3`, r.outcome === 'executed', label(r))
}

// ---- steps (b) to (h) --------------------------------------------------------------------------------------------------------
const ordersCount = () => q('select count(*) from public.pos_orders')
{
  // (b) the SECURITY DEFINER write RPC (PUBLIC-executable on purpose in the fixture)
  const before = ordersCount()
  const r1 = await m1('select fake_write_rpc()'), r2 = await m2('select fake_write_rpc()'), r3 = await m3('select fake_write_rpc() as x from coop_explore_orders o')
  rec('(b) definer write RPC: fails in M1 (role default read-only)', r1.outcome === 'rejected' && r1.code === '25006', label(r1))
  rec('(b) definer write RPC: fails in M2 (read-only envelope)', r2.outcome === 'rejected' && r2.code === '25006', label(r2))
  rec('(b) definer write RPC: fails in M3 (cursor over a nested write)', r3.outcome === 'rejected', label(r3))
  rec('(b) pos_orders row count unchanged', ordersCount() === before, `${before} -> ${ordersCount()}`)
}
{
  // (c) temp objects
  const r2 = await m2('create temp table explore_tmp as select 1 as x'), r1 = await m1('create temp table explore_tmp as select 1 as x')
  rec('(c) CREATE TEMP TABLE fails in M2', r2.outcome === 'rejected', label(r2))
  console.log(`INFO (c) CREATE TEMP TABLE in M1 (role default read-only): ${label(r1)}${r1.outcome === 'executed' ? '  [PARSER-only: PUBLIC holds TEMP; we do not revoke PUBLIC grants]' : ''}`)
  if (r1.outcome === 'executed') tally.parserOnly.push('c-TEMP[M1 executed]')
}
{
  // (d) U6: can the text flip the transaction to read-write? (set_config after the first snapshot)
  const r = await m2("select set_config('transaction_read_only', 'off', true)")
  console.log(`INFO (d) U6 set_config('transaction_read_only','off',true) as the first query in the envelope: ${label(r)} ${r.msg ? '(' + r.msg + ')' : ''}`)
  const r2 = await run(async (sql) => {
    try {
      await sql.unsafe(ENVELOPE.join('; '))
      await sql.unsafe("select set_config('transaction_read_only', 'off', true)")
      return await sql.unsafe('insert into public.pos_orders (total) values (1)')
    } finally { await rollback(sql) }
  })
  rec('(d) set_config(read-only off) followed by an INSERT does not write (refused by the engine or by privileges)', r2.outcome === 'rejected', label(r2))
}
{
  // (e) CONNECTION LIMIT 10: the 11th simultaneous session is refused with 53300
  const conns = []
  let eleventh = null
  try {
    for (let i = 0; i < 11; i++) {
      const sql = postgres(URL_, { max: 1, prepare: false, idle_timeout: 0, connect_timeout: 5, onnotice: () => {} })
      conns.push(sql)
      try { await sql.unsafe('select 1') } catch (e) { eleventh = { i, code: e.code }; break }
    }
  } finally { await Promise.all(conns.map((c) => c.end({ timeout: 1 }).catch(() => {}))) }
  rec('(e) CONNECTION LIMIT: the 11th session fails with 53300 (too many connections for role)', eleventh && eleventh.i === 10 && eleventh.code === '53300', JSON.stringify(eleventh))
}
{
  // (g) the 260-row bulk query returns 201 rows through the cursor (200 returned + 1 proving truncation)
  const r = await m3("select o.id from coop_explore_orders o where o.remarks like 'bulk-%' order by o.id")
  rec('(g) 260 matching rows: the cursor returns exactly 201', r.outcome === 'executed' && r.rows.length === 201, label(r))
  const total = q("select count(*) from public.pos_orders where remarks like 'bulk-%'")
  rec('(g) the fixture holds 260 bulk orders', total === '260', total)
}
{
  // (h) barrier test (Day 1): the READ ONLY transaction is NOT a barrier by itself. Grant INSERT on a scratch table for this step only.
  // The event trigger strips any INSERT grant at once, so switch it off for this step only (re-enabled in `finally`).
  admin('alter event trigger coop_explore_guard_ddl disable')
  admin(`drop table if exists public.explore_proof_scratch; create table public.explore_proof_scratch (id int); grant select, insert on public.explore_proof_scratch to ${ROLE};`)
  try {
    const flip = await run(async (sql) => {
      try {
        await sql.unsafe(ENVELOPE.join('; '))
        await sql.unsafe('set transaction read write')
        await sql.unsafe('insert into public.explore_proof_scratch (id) values (1)')
        return await sql.unsafe('select count(*) from public.explore_proof_scratch')
      } finally { await rollback(sql) }
    })
    const commitInsert = await m2('commit; insert into public.explore_proof_scratch (id) values (2)')
    const multi = await m2('select 1; insert into public.explore_proof_scratch (id) values (3)')
    const m1multi = await m1('select 1; insert into public.explore_proof_scratch (id) values (4)')
    const m1commit = await m1('commit; insert into public.explore_proof_scratch (id) values (5)')
    const m3flip = await m3('set transaction read write')
    const written = q('select count(*) from public.explore_proof_scratch')
    console.log(`INFO (h) with INSERT granted: M2 'set transaction read write; insert' ${label(flip)}; M2 'commit; insert' ${label(commitInsert)}; M2 'select 1; insert' ${label(multi)}; M1 'select 1; insert' ${label(m1multi)}; M1 'commit; insert' ${label(m1commit)}; M3 'set transaction read write' ${label(m3flip)}; rows now in scratch: ${written}`)
    if (flip.outcome === 'executed') console.log("INFO (h) READ ONLY txn is not a barrier; the lock is role privileges + parser (set transaction read write flipped it in M2)")
    rec('(h) M3 (DECLARE ... FOR set transaction read write) cannot flip the transaction: refused by the grammar', m3flip.outcome === 'rejected', label(m3flip))
    rec('(h) the role default (read-only) stops `commit; insert` and `select 1; insert` even with INSERT granted', commitInsert.outcome === 'rejected' && multi.outcome === 'rejected' && m1multi.outcome === 'rejected' && m1commit.outcome === 'rejected', `${label(commitInsert)} / ${label(multi)} / ${label(m1multi)} / ${label(m1commit)}`)
    if (flip.outcome === 'executed') tally.parserOnly.push('h-N89[M2 set transaction read write executed: parser is the only layer]')
  } finally {
    admin(`revoke all on public.explore_proof_scratch from ${ROLE}; drop table if exists public.explore_proof_scratch;`)
    admin('alter event trigger coop_explore_guard_ddl enable')
  }
  const gone = q("select to_regclass('public.explore_proof_scratch') is null")
  rec('(h) the scratch table is dropped and the grant revoked', gone === 't', gone)
  // N89-N91 against the real grants (no scratch): they fail by privileges, or are recorded parser-only
  const n90 = await m2('commit; insert into pos_orders (total) values (1)'), n91 = await m2('select 1; insert into pos_orders (total) values (1)')
  rec('(h) N90 and N91 against the real grants fail by privileges (42501 or 25006)', ['42501', '25006'].includes(n90.code) && ['42501', '25006'].includes(n91.code), `${label(n90)} / ${label(n91)}`)
}
rec('the event trigger is enabled again after every step', q("select evtenabled from pg_event_trigger where evtname = 'coop_explore_guard_ddl'") === 'O')
rec('no proof step left a row behind: pos_orders count back to the fixture', Number(ordersCount()) >= 290, ordersCount())

console.log(`\nDB alone stops ${tally.dbAlone} cases, clock stops ${tally.clock} cases (cursor cap or refusal bounds ${tally.cap} more), parser-only ${tally.parserOnly.length} cases:`)
for (const p of tally.parserOnly) console.log(`  - ${p}`)
console.log(`\n${pass} PASS, ${fail} FAIL`)
process.exit(fail ? 1 : 0)
