// EXP-05: the exact transaction envelope, with a fake driver. No database, no network.
import {describe, expect, it, vi} from 'vitest';
vi.mock('server-only', () => ({}));
import {createRunQuery, runInEnvelope, type ExploreSql, type ExploreTx} from '../src/chat/explore/client';
import {wrapCursor} from '../src/chat/explore/parse';
import {resolveExploreAccess} from '../src/chat/explore/config';
import {ExploreDbError} from '../src/chat/explore/errors';

type Log = {stmt: string; opts?: {simple?: boolean}}[];
function fakeDriver(over: {rows?: unknown[][]; columns?: {name: string; type: number}[]; failOn?: RegExp; code?: string} = {}) {
  const log: Log = [];
  const events: string[] = [];
  const tx: ExploreTx = {
    unsafe: ((text: string, _p?: unknown[], opts?: {simple?: boolean}) => {
      log.push({stmt: text, opts});
      events.push(text);
      const fail = over.failOn?.test(text);
      const result = Object.assign(fail ? Promise.reject(Object.assign(new Error('raw db text Maria'), {code: over.code ?? '42501'})) : Promise.resolve([]), {
        values: async () => Object.assign([...(over.rows ?? [])], {columns: over.columns ?? []}),
      });
      return result;
    }) as ExploreTx['unsafe'],
  };
  const sql: ExploreSql = {
    async begin(mode, fn) {
      events.unshift(`BEGIN ${mode.toUpperCase()}`);
      try {
        const v = await fn(tx);
        events.push('COMMIT');
        return v;
      } catch (e) {
        events.push('ROLLBACK');
        throw e;
      }
    },
  };
  return {sql, log, events};
}

const SQL = wrapCursor('select o.id from coop_explore_orders o');

describe('EXP-05 the envelope', () => {
  it('EXP-05 runs BEGIN READ ONLY, the SET LOCALs (timezone Asia/Manila), DECLARE, FETCH max+1, then ROLLBACK, in that order', async () => {
    const d = fakeDriver({rows: [['2026-09-01', '12.50']], columns: [{name: 'day', type: 1082}, {name: 'revenue_php', type: 1700}]});
    const r = await runInEnvelope(d.sql, SQL, {timeoutMs: 5000, maxRows: 200});
    expect(d.events).toEqual([
      'BEGIN READ ONLY',
      'SET LOCAL statement_timeout = 5000',
      'SET LOCAL lock_timeout = 2000',
      'SET LOCAL idle_in_transaction_session_timeout = 10000',
      "SET LOCAL timezone = 'Asia/Manila'",
      'SET LOCAL search_path = public, pg_temp', // pg_temp LAST: a temporary object can never shadow a real table or type
      SQL,
      'FETCH FORWARD 201 FROM coop_explore_c',
      'ROLLBACK',
    ]);
    expect(r.columns).toEqual([{name: 'day', type: 'date'}, {name: 'revenue_php', type: 'number'}]);
    expect(r.rows).toEqual([['2026-09-01', 12.5]]); // numeric text -> number, date stays text
    expect(r.fetched).toBe(1);
  });

  it('Task 7: secret-shaped values are replaced with [hidden] inside the envelope, before anything leaves client.ts, with a count', async () => {
    const jwt = 'eyJ' + 'a'.repeat(12) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12);
    const d = fakeDriver({rows: [[1, jwt], [2, 'plain']], columns: [{name: 'id', type: 23}, {name: 'note', type: 25}]});
    const r = await runInEnvelope(d.sql, SQL, {timeoutMs: 5000, maxRows: 200});
    expect(r.rows).toEqual([[1, '[hidden]'], [2, 'plain']]);
    expect(r.hidden).toBe(1);
  });

  it('Task 7 round 2 N5: if the scanner throws (a stack overflow on a hostile value), no row leaves: ExploreDbError, rolled back', async () => {
    const hostile = {get token(): string {
      throw new RangeError('Maximum call stack size exceeded');
    }};
    const d = fakeDriver({rows: [[1, 'plain'], [2, hostile]], columns: [{name: 'id', type: 23}, {name: 'payload', type: 3802}]});
    const p = runInEnvelope(d.sql, SQL, {timeoutMs: 5000, maxRows: 200});
    await expect(p).rejects.toBeInstanceOf(ExploreDbError);
    await expect(p).rejects.not.toHaveProperty('value');
    expect(d.events.at(-1)).toBe('ROLLBACK');
  });

  it('EXP-05 never uses the simple protocol for any statement (a second statement would otherwise run) and never COMMITs', async () => {
    const d = fakeDriver();
    await runInEnvelope(d.sql, SQL, {timeoutMs: 5000, maxRows: 200});
    expect(d.log.every((l) => l.opts?.simple === false)).toBe(true);
    expect(d.events).not.toContain('COMMIT');
  });

  it('EXP-05 the model SQL appears only as the DECLARE ... CURSOR FOR statement, byte for byte, and in no other statement', async () => {
    const d = fakeDriver();
    await runInEnvelope(d.sql, SQL, {timeoutMs: 5000, maxRows: 200});
    expect(d.log.filter((l) => l.stmt.includes('coop_explore_orders'))).toEqual([{stmt: SQL, opts: {simple: false}}]);
    expect(SQL.startsWith('DECLARE coop_explore_c NO SCROLL CURSOR FOR ')).toBe(true);
  });

  it('EXP-05 a bigint beyond the safe range is E_DATA, not a silently rounded figure', async () => {
    const d = fakeDriver({rows: [['9007199254740993']], columns: [{name: 'n', type: 20}]});
    await expect(runInEnvelope(d.sql, SQL, {timeoutMs: 5000, maxRows: 200})).rejects.toMatchObject({code: 'E_DATA'});
  });

  it('EXP-05 a database error is mapped to a code from its SQLSTATE; the raw message is dropped; the transaction is rolled back', async () => {
    const d = fakeDriver({failOn: /^DECLARE/, code: '57014'});
    const err = await runInEnvelope(d.sql, SQL, {timeoutMs: 5000, maxRows: 200}).catch((e) => e);
    expect(err).toBeInstanceOf(ExploreDbError);
    expect(err.code).toBe('E_TIMEOUT');
    expect(String(err.message)).not.toMatch(/Maria/);
    expect(d.events.at(-1)).toBe('ROLLBACK');
  });

  it('EXP-05 the real postgres client is built with no startup connection options and prepare:false (source pin)', async () => {
    const {readFileSync} = await import('node:fs');
    const src = readFileSync('src/chat/explore/client.ts', 'utf8');
    expect(src).toMatch(/prepare: false/);
    expect(src).toMatch(/max: 1/);
    expect(src).not.toMatch(/connection:\s*\{/);
    expect(src).not.toMatch(/\.simple\(\)/);
  });
});

describe('EXP-05 the client refuses what access refuses', () => {
  const env = {NODE_ENV: 'development', EXPLORE_MODE: 'on', EXPLORE_ALLOWED_EMAILS: 'dev@localhost'};
  it('EXP-05 a disabled access (or a hosted URL outside production) cannot build a runQuery', () => {
    expect(() => createRunQuery(resolveExploreAccess({...env, EXPLORE_DATABASE_URL: 'postgres://coop_explore_ro:x@db.abc.supabase.co:5432/postgres'}, 'dev@localhost'))).toThrow();
    expect(() => createRunQuery(resolveExploreAccess({...env, EXPLORE_MODE: 'off', EXPLORE_DATABASE_URL: 'postgres://coop_explore_ro:x@127.0.0.1:54421/postgres'}, 'dev@localhost'))).toThrow();
    expect(() => createRunQuery(resolveExploreAccess({...env, EXPLORE_DATABASE_URL: 'postgres://postgres:x@127.0.0.1:54421/postgres'}, 'dev@localhost'))).toThrow();
  });
  it('EXP-05 a local URL builds one through the injected factory (loopback is not TLS, nothing connects until a query runs)', async () => {
    const factory = vi.fn((_url: string, hosted: boolean) => ({...fakeDriver().sql, hosted}));
    const run = createRunQuery(resolveExploreAccess({...env, EXPLORE_DATABASE_URL: 'postgres://coop_explore_ro:x@127.0.0.1:54421/postgres'}, 'dev@localhost'), factory as never);
    await run(SQL, {timeoutMs: 5000, maxRows: 200});
    expect(factory).toHaveBeenCalledWith(expect.any(String), false);
  });
});
