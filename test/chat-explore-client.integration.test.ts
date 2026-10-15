// LOCAL INTEGRATION (skipped unless pointed at the throwaway local stack built by `scripts/local-supabase/up.sh --explore`):
//   set -a; . scripts/local-supabase/.local-env; set +a; npx vitest run test/chat-explore-client.integration.test.ts
// The Integrator's fake-driver test (chat-explore-client.test.ts) pins the statements; this one proves them against the REAL `postgres`
// package and the real login role coop_explore_ro: the envelope applies, the cursor caps, the extended protocol refuses a second
// statement, a write never reaches the database through the parser and is refused by the database when sent raw, and the error codes
// and column types the executor relies on are what the driver actually returns (spec U5). No model, no network beyond 127.0.0.1.
import {execSync} from 'node:child_process';
import {afterAll, describe, expect, it, vi} from 'vitest';
vi.mock('server-only', () => ({}));
import {createRunQuery, runInEnvelope, type ExploreSql} from '../src/chat/explore/client';
import {ExploreDbError} from '../src/chat/explore/errors';
import {createExploreExecutor} from '../src/chat/explore/executor';
import {DEFAULT_EXPLORE_LIMITS} from '../src/chat/explore/limits';
import {validateExploreSql, wrapCursor} from '../src/chat/explore/parse';
import {shapeResult} from '../src/chat/explore/result';
import {assertLocalPostgres} from './support/local-only';

const URL_ = process.env.EXPLORE_DATABASE_URL;
const PSQL = process.env.SB_PSQL_CMD;
if (URL_) assertLocalPostgres(URL_); // a set but non-local URL fails the file loudly instead of skipping
const local = !!URL_ && !!PSQL && /^docker exec -i coop-local-db /.test(PSQL);

const run = local
  ? createRunQuery({enabled: true, limits: DEFAULT_EXPLORE_LIMITS, databaseUrl: URL_!})
  : (undefined as never);
const OPTS = {timeoutMs: 5000, maxRows: 200};
const admin = (sql: string): string => execSync(`${PSQL} -t -A 2>&1`, {input: sql, encoding: 'utf8'}).trim();

/** Run one probe string through the real envelope; returns its single row as an object. */
async function one(sql: string, opts = OPTS): Promise<Record<string, unknown>> {
  const r = await run(wrapCursor(sql), opts);
  return Object.fromEntries(r.columns.map((c, i) => [c.name, r.rows[0][i]]));
}
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ExploreDbError);
    return (e as ExploreDbError).code;
  }
  throw new Error('expected a refusal');
}

describe.skipIf(!local)('EXP-05 the real driver and the real role (local Postgres only)', () => {
  afterAll(() => undefined);

  it('EXP-05 the envelope really applies: read only, statement and lock timeout, Asia/Manila, search_path', async () => {
    const r = await one(
      "select current_setting('transaction_read_only') as ro, current_setting('statement_timeout') as st, current_setting('lock_timeout') as lt, current_setting('timezone') as tz, current_setting('search_path') as sp, current_setting('idle_in_transaction_session_timeout') as idle, current_user as who",
      {timeoutMs: 1234, maxRows: 5},
    );
    expect(r).toEqual({ro: 'on', st: '1234ms', lt: '2s', tz: 'Asia/Manila', sp: 'public, pg_temp', idle: '10s', who: 'coop_explore_ro'});
  });

  it('Task 7: a temporary object made earlier on the same session can never shadow a real view (search_path public, pg_temp)', async () => {
    const postgres = (await import('postgres')).default;
    const sql = postgres(URL_!, {max: 1, prepare: false, onnotice: () => {}});
    try {
      // The app never sends this (the parser allows one SELECT, the envelope is READ ONLY): it simulates a session that somehow holds one.
      await sql.unsafe('begin read write; create temporary view coop_explore_orders as select -1::bigint as id; commit');
      const shadow = await sql.unsafe('select o.id from coop_explore_orders o limit 1'); // default path: pg_temp is searched first
      expect(Number(shadow[0].id)).toBe(-1);
      const r = await runInEnvelope(sql as unknown as ExploreSql, wrapCursor('select min(o.id) as id from coop_explore_orders o'), OPTS);
      expect(Number(r.rows[0][0])).toBeGreaterThan(0); // the envelope reads the real view
    } finally {
      await sql.end({timeout: 1});
    }
  });

  it('EXP-05 a Manila-day boundary: 16:30 UTC lands on the next Manila day', async () => {
    const r = await one("select ((timestamptz '2026-09-10 16:30:00+00') at time zone 'Asia/Manila')::date::text as day");
    expect(r.day).toBe('2026-09-11');
  });

  it('EXP-05 the cursor returns exactly max+1 rows for a big source (the 201st proves truncation)', async () => {
    const r = await run(wrapCursor('select g from generate_series(1, 5000) g'), OPTS);
    expect(r.fetched).toBe(201);
    expect(r.rows).toHaveLength(201);
  });

  it('EXP-05 a source smaller than the cap returns all of its rows', async () => {
    const r = await run(wrapCursor('select g from generate_series(1, 7) g'), OPTS);
    expect(r.fetched).toBe(7);
  });

  it('EXP-03 the executor, with the real parser and the real client, shows the truncation notice and keeps the cap', async () => {
    const stored = new Map<string, unknown>();
    const exec = createExploreExecutor({
      runQuery: run,
      validate: validateExploreSql,
      limits: {...DEFAULT_EXPLORE_LIMITS, maxRows: 3},
      now: new Date('2026-10-05T00:00:00Z'),
      user: 'dev@localhost',
      store: {set: (id, r) => void stored.set(id, r)},
    });
    const out = (await exec({purpose: 'cap check', sql: 'select i.order_id from coop_explore_order_items i', step: 'final'})) as {id: string; meta: {caveats: string[]}; rows: unknown[]};
    expect(out.id).toBe('x1');
    expect(out.rows).toHaveLength(3);
    expect(out.meta.caveats.join(' ')).toContain('Showing the first 3 rows; the query returned more.');
    expect(stored.has('x1')).toBe(true);
  });

  it('EXP-05 the extended protocol refuses a second statement (no .simple())', async () => {
    const code = await codeOf(run(`${wrapCursor('select 1 as a')}; select 2 as b`, OPTS));
    expect(code).toBe('E_DB_OTHER'); // 42601 "cannot insert multiple commands into a prepared statement": refused by the protocol itself
  });

  it('EXP-05 a write through the parser path never reaches the database', async () => {
    const before = admin('select count(*) from pos_orders');
    let called = 0;
    const exec = createExploreExecutor({
      runQuery: (s, o) => {
        called += 1;
        return run(s, o);
      },
      validate: validateExploreSql,
      limits: DEFAULT_EXPLORE_LIMITS,
      now: new Date('2026-10-05T00:00:00Z'),
      user: 'dev@localhost',
      store: {set: () => undefined},
    });
    await expect(exec({purpose: 'x', sql: "delete from pos_orders where 1 = 1", step: 'final'})).rejects.toMatchObject({code: 'E_NOT_SELECT'});
    await expect(exec({purpose: 'x', sql: 'select 1 as a; delete from pos_orders', step: 'final'})).rejects.toMatchObject({code: 'E_MULTI_STATEMENT'});
    expect(called).toBe(0);
    expect(admin('select count(*) from pos_orders')).toBe(before);
  });

  it('EXP-05 a raw write sent straight to the driver is refused by the database (25006 -> E_DB_DENIED) and changes nothing', async () => {
    const before = admin('select count(*) from pos_orders');
    expect(await codeOf(run('DELETE FROM pos_orders', OPTS))).toBe('E_DB_DENIED');
    expect(await codeOf(run("UPDATE pos_orders SET status = 'voided'", OPTS))).toBe('E_DB_DENIED');
    expect(admin('select count(*) from pos_orders')).toBe(before);
  });

  // Train 3 (direct reads): base tables are readable on purpose now; a CLOSED table (secret name, scripts/coop-direct-fixture.sql) is
  // what the role denies.
  it('EXP-05 a base table is readable, a closed (secret-named) table is denied by the role (42501 -> E_DB_DENIED)', async () => {
    expect((await run(wrapCursor('select o.id from pos_orders o'), OPTS)).rows.length).toBeGreaterThan(0);
    expect(await codeOf(run(wrapCursor('select m.marketplace from marketplace_tokens m'), OPTS))).toBe('E_DB_DENIED');
  });

  it('EXP-05 a statement timeout surfaces as E_TIMEOUT within about the limit', async () => {
    const t0 = Date.now();
    expect(await codeOf(run(wrapCursor('select pg_sleep(3)'), {timeoutMs: 300, maxRows: 200}))).toBe('E_TIMEOUT');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('EXP-05 an unknown column, a division by zero and a bad cast map to their codes, with no raw database text', async () => {
    expect(await codeOf(run(wrapCursor('select o.nope from coop_explore_orders o'), OPTS))).toBe('E_COLUMN');
    expect(await codeOf(run(wrapCursor('select 1 / (g - g) as x from generate_series(1, 2) g'), OPTS))).toBe('E_DIV_ZERO');
    expect(await codeOf(run(wrapCursor("select 'abc'::integer as x"), OPTS))).toBe('E_DATA');
  });

  it('EXP-05 the connection is reusable after a refusal (the transaction rolled back, not left open)', async () => {
    await codeOf(run(wrapCursor('select pg_sleep(3)'), {timeoutMs: 200, maxRows: 5}));
    const r = await one('select current_setting(\'statement_timeout\') as st', {timeoutMs: 5000, maxRows: 5});
    expect(r.st).toBe('5s');
  });

  it('EXP-05 a refused connection and a wrong password both surface as E_UNAVAILABLE (never raw text)', async () => {
    const dead = new URL(URL_!);
    dead.port = '1';
    const down = createRunQuery({enabled: true, limits: DEFAULT_EXPLORE_LIMITS, databaseUrl: dead.toString()});
    expect(await codeOf(down(wrapCursor('select 1 as a'), OPTS))).toBe('E_UNAVAILABLE');
    const bad = new URL(URL_!);
    bad.password = 'not-the-password';
    const wrong = createRunQuery({enabled: true, limits: DEFAULT_EXPLORE_LIMITS, databaseUrl: bad.toString()});
    expect(await codeOf(wrong(wrapCursor('select 1 as a'), OPTS))).toBe('E_UNAVAILABLE');
  });

  it('U5 postgres.js returns column type OIDs for unsafe() results, and the client maps them to roles', async () => {
    const r = await run(
      wrapCursor("select 1::int as a_count, 2::bigint as b_count, 1.5::numeric as c_php, now() as d_ts, current_date as e_day, 'x'::text as f, true as g, '{\"k\":1}'::jsonb as h"),
      OPTS,
    );
    expect(r.columns.map((c) => c.type)).toEqual(['number', 'number', 'number', 'timestamp', 'date', 'text', 'bool', 'json']);
    expect(r.rows[0].slice(0, 3)).toEqual([1, 2, 1.5]); // numeric and bigint arrive as text and are converted
    expect(typeof r.rows[0][4]).toBe('string'); // dates stay text: no JS Date, no timezone shift
  });

  it('U5 numeric and date columns get the right column roles and units after shaping', async () => {
    const sql = "select (o.created_at at time zone 'Asia/Manila')::date as day, count(*) as orders_count, round(sum(o.total), 2) as revenue_php from coop_explore_orders o where o.status = 'completed' group by 1 order by 1";
    const v = await validateExploreSql(sql);
    if (!v.ok) throw new Error(v.code);
    const raw = await run(v.sent, OPTS);
    const s = shapeResult({raw, validated: v, limits: DEFAULT_EXPLORE_LIMITS, id: 'x1'});
    if (!s.ok) throw new Error(s.code);
    expect(s.result.columns.map((c) => [c.key, c.role, c.unit])).toEqual([
      ['day', 'time', 'date'],
      ['orders_count', 'measure', 'count'],
      ['revenue_php', 'measure', 'PHP'],
    ]);
    expect(typeof s.result.rows[0].orders_count).toBe('number');
    expect(typeof s.result.rows[0].revenue_php).toBe('number');
    expect(s.result.meta.dataFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
