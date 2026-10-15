// The ONLY file that imports the Postgres driver (spec 10.5). One read-only transaction per query as the login role coop_explore_ro:
//   BEGIN READ ONLY; SET LOCAL timeouts / timezone / search_path (public, pg_temp); DECLARE ... CURSOR FOR <validated sql>; FETCH max+1; ROLLBACK.
// - The model text is ONLY ever the validated string wrapped in DECLARE (parser step 3 judged exactly that string); it is never concatenated
//   into anything else, and it runs on the EXTENDED protocol (`simple: false`), so a second statement is refused by the protocol itself.
//   (postgres.js `unsafe(sql)` with no options uses the simple protocol, which accepts several statements.)
// - A READ ONLY transaction is NOT a write barrier by itself (spec 5.4): the locks are role privileges + the parser. This file adds depth only.
// - No startup `connection` options (poolers reject unknown startup parameters): everything is SET LOCAL per transaction.
import 'server-only';
import postgres from 'postgres';
import {ExploreDbError, mapDbError} from './errors';
import type {RawColumnType, RawQueryResult} from './result';
import {CURSOR_NAME} from './parse';
import {scrubRows} from './scrub';
import type {ExploreAccess, ExploreLimits} from './types';

export const EXPLORE_TIMEZONE = 'Asia/Manila';

// OIDs (pg_type). Anything unknown becomes 'other' and result.ts falls back to the JS value type (spec U5).
const NUMERIC_OIDS = new Set([20, 21, 23, 700, 701, 1700]);
const TEXT_OIDS = new Set([18, 19, 25, 1042, 1043]);
function typeOf(oid: number): RawColumnType {
  if (NUMERIC_OIDS.has(oid)) return 'number';
  if (oid === 16) return 'bool';
  if (oid === 1082) return 'date';
  if (oid === 1114 || oid === 1184) return 'timestamp';
  if (oid === 114 || oid === 3802) return 'json';
  if (TEXT_OIDS.has(oid)) return 'text';
  return 'other';
}

/** The slice of postgres.js this file uses; the test passes a fake with the same shape. */
export interface ExploreTx {
  unsafe(text: string, params?: unknown[], opts?: {simple?: boolean}): Promise<unknown[] & {columns?: {name: string; type: number}[]}> & {values(): Promise<unknown[][] & {columns?: {name: string; type: number}[]}>};
}
export interface ExploreSql {
  begin<T>(mode: 'read only', fn: (tx: ExploreTx) => Promise<T>): Promise<T>;
  end?(opts?: {timeout?: number}): Promise<void>;
}
export type SqlFactory = (url: string, hosted: boolean) => ExploreSql;

const integer = (n: number): number => {
  if (!Number.isInteger(n) || n < 0) throw new ExploreDbError('E_DB_OTHER');
  return n;
};

class Rollback extends Error {
  constructor(readonly value: RawQueryResult) {
    super('rollback');
  }
}

/** Exported for the fake-driver test: run ONE validated, wrapped statement through the envelope and return the converted result. */
export async function runInEnvelope(sql: ExploreSql, sent: string, opts: {timeoutMs: number; maxRows: number}): Promise<RawQueryResult> {
  const t0 = Date.now();
  try {
    await sql.begin('read only', async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${integer(opts.timeoutMs)}`, [], {simple: false});
      await tx.unsafe('SET LOCAL lock_timeout = 2000', [], {simple: false});
      await tx.unsafe('SET LOCAL idle_in_transaction_session_timeout = 10000', [], {simple: false});
      await tx.unsafe(`SET LOCAL timezone = '${EXPLORE_TIMEZONE}'`, [], {simple: false});
      await tx.unsafe('SET LOCAL search_path = public, pg_temp', [], {simple: false}); // pg_temp LAST: no temporary object can shadow a name
      await tx.unsafe(sent, [], {simple: false});
      const fetched = await tx.unsafe(`FETCH FORWARD ${integer(opts.maxRows) + 1} FROM ${CURSOR_NAME}`, [], {simple: false}).values();
      const cols = (fetched.columns ?? []).map((c) => ({name: c.name, type: typeOf(c.type)}));
      const converted = (fetched as unknown[][]).map((r) => r.map((cell, i) => convert(cell, cols[i]?.type)));
      const {rows, hidden} = scrubRows(converted); // layer 4: before anything leaves this file
      throw new Rollback({columns: cols, rows, fetched: rows.length, ms: Date.now() - t0, hidden}); // always ROLLBACK, never COMMIT
    });
  } catch (e) {
    if (e instanceof Rollback) return e.value;
    if (e instanceof ExploreDbError) throw e;
    const raw = (e as {code?: unknown})?.code;
    throw new ExploreDbError(mapDbError(raw), typeof raw === 'string' ? raw : undefined); // code only: the raw message is dropped here
  }
  throw new ExploreDbError('E_DB_OTHER');
}

function convert(cell: unknown, type: RawColumnType | undefined): unknown {
  if (cell === null || cell === undefined) return null;
  if (type === 'number') {
    const n = typeof cell === 'number' ? cell : Number(cell);
    if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) throw new ExploreDbError('E_DATA');
    return n;
  }
  if (cell instanceof Date) return cell.toISOString();
  return cell;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost']);
const realFactory: SqlFactory = (url, hosted) =>
  postgres(url, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 5,
    ssl: hosted ? 'require' : false,
    onnotice: () => {},
    // numbers and big integers arrive as text and are converted (and range-checked) in convert(); dates stay text (no JS Date, no timezone shift)
    types: {
      bigint: {to: 20, from: [20], serialize: String, parse: (x: string) => x},
      numeric: {to: 1700, from: [1700], serialize: String, parse: (x: string) => x},
      date: {to: 1082, from: [1082], serialize: String, parse: (x: string) => x},
      timestamp: {to: 1114, from: [1114], serialize: String, parse: (x: string) => x},
      timestamptz: {to: 1184, from: [1184], serialize: String, parse: (x: string) => x},
    },
  }) as unknown as ExploreSql;

let cached: {url: string; sql: ExploreSql} | null = null;

/**
 * The real RunQuery. Refuses anything but an `enabled` access (resolveExploreAccess already checked mode, role, local-only host in dev,
 * ro_role and allowlists in production); a URL for a non-loopback host outside production cannot get here, and a hosted URL gets TLS.
 */
export function createRunQuery(access: ExploreAccess, factory: SqlFactory = realFactory): (sent: string, opts: {timeoutMs: number; maxRows: number}) => Promise<RawQueryResult> {
  if (!access.enabled) throw new ExploreDbError('E_DISABLED');
  const url = access.databaseUrl;
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      throw new ExploreDbError('E_UNAVAILABLE');
    }
  })();
  const hosted = !LOOPBACK.has(host);
  const sql = (): ExploreSql => {
    if (factory === realFactory) {
      if (!cached || cached.url !== url) cached = {url, sql: factory(url, hosted)};
      return cached.sql;
    }
    return factory(url, hosted);
  };
  return (sent, opts) => runInEnvelope(sql(), sent, opts);
}

export type {ExploreLimits};
