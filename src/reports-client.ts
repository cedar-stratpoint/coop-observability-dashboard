import 'server-only';
import {createClient} from '@supabase/supabase-js';
import type {DbError} from './supabase-errors';

// F9: the ONLY database clients for Coop Reports (the two tables `coop_reports` and `coop_report_versions`). Design § 5b
// "Write path" and § 5c layer 7; rule: knowledge/best-practices/chat-read-only.md. The chat tree must never import this
// file (architecture test): the model cannot save, restore or delete anything.
//
// Both clients are service-role clients behind a GUARDED FETCH that throws, before any request leaves, on: any host but
// the project's, any path but /rest/v1/<one of the two tables> (so no rpc, storage, auth, functions, graphql), any other
// method (the read client allows GET and HEAD, the write client GET, HEAD, POST and PATCH; never PUT or DELETE). The write
// client also refuses an upsert (on_conflict / resolution=), PATCH on the immutable versions table, a PATCH with no
// `id=eq.` filter (no bulk update) or with a body that touches any column but the editable ones. The reports tables hold
// no customer data, so `select=*` is allowed here (unlike the chat's guard).
//
// Safety flag: when COOP_REQUIRE_LOCAL_DB=1 both clients THROW at creation unless the configured URL host is 127.0.0.1 or
// localhost. The local dev launcher sets it so a stray hosted URL in .env can never be reached.
//
// Everything above `reportsReadClient` is pure and unit-tested with a fake `underlying` fetch.

export const REPORT_TABLES = ['coop_reports', 'coop_report_versions'] as const;
export type ReportsTable = (typeof REPORT_TABLES)[number];

export type GuardMode = 'read' | 'write';

export interface GuardBlock {
  reason: string;
  method: string;
  path: string;
}

export interface ReportsGuardStats {
  allowed: number;
  /** Requests refused for any reason. Each also threw. */
  blocked: GuardBlock[];
}

export interface ReportsGuardOptions {
  baseUrl: string;
  mode: GuardMode;
  underlying: typeof fetch;
  onTrip?: (block: GuardBlock) => void;
}

const METHODS: Record<GuardMode, ReadonlySet<string>> = {
  read: new Set(['GET', 'HEAD']),
  write: new Set(['GET', 'HEAD', 'POST', 'PATCH']),
};
const TABLE_PATH = /^\/rest\/v1\/([a-z0-9_]+)$/;
const DENIED_PREFIXES = ['/rest/v1/rpc', '/storage', '/auth', '/functions', '/graphql'];
/** Columns a PATCH of `coop_reports` may set. Never owner_email, id or created_at. */
const PATCHABLE_COLUMNS: ReadonlySet<string> = new Set(['title', 'visibility', 'pinned', 'current_version', 'deleted_at', 'updated_at']);

const rawOf = (input: Parameters<typeof fetch>[0]): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

function patchBodyProblem(body: unknown): string | null {
  if (typeof body !== 'string') return 'PATCH needs a JSON text body';
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 'PATCH body is not JSON';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'PATCH body must be an object';
  const bad = Object.keys(parsed).find((k) => !PATCHABLE_COLUMNS.has(k));
  return bad ? `PATCH may not set column ${bad}` : null;
}

export function createReportsGuardedFetch(opts: ReportsGuardOptions): {fetch: typeof fetch; stats: ReportsGuardStats} {
  const baseOrigin = new URL(opts.baseUrl).origin;
  const methods = METHODS[opts.mode];
  const tables = new Set<string>(REPORT_TABLES);
  const stats: ReportsGuardStats = {allowed: 0, blocked: []};

  function violation(raw: string, method: string, init: RequestInit | undefined, input: Parameters<typeof fetch>[0]): string | null {
    if (!methods.has(method)) return `method ${method} is not allowed (${opts.mode === 'read' ? 'GET/HEAD' : 'GET/HEAD/POST/PATCH'} only)`;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return 'unparseable URL';
    }
    if (url.origin !== baseOrigin) return `host ${url.origin} is not the project host`;
    if (raw.includes('#')) return 'fragment in URL';

    // Judge the RAW path: WHATWG URL parsing silently resolves `..` / `%2e%2e`, and it must equal the parsed path.
    const afterOrigin = raw.slice(raw.indexOf('//') + 2);
    const slash = afterOrigin.indexOf('/');
    const rawPath = slash === -1 ? '' : afterOrigin.slice(slash).split('?')[0];
    const lower = rawPath.toLowerCase();
    if (DENIED_PREFIXES.some((p) => lower === p || lower.startsWith(`${p}/`))) return `path ${rawPath} is denied`;
    if (url.pathname !== rawPath) return `path ${rawPath} differs from the parsed path ${url.pathname}`;
    const m = TABLE_PATH.exec(rawPath);
    if (!m) return `path ${rawPath} is not /rest/v1/<table>`;
    const table = m[1];
    if (!tables.has(table)) return `table ${table} is not a reports table`;

    if (method === 'POST') {
      if (url.searchParams.has('on_conflict')) return 'upsert (on_conflict) is not allowed';
      const prefer = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined)).get('prefer') ?? '';
      if (/resolution\s*=/i.test(prefer)) return 'upsert (Prefer: resolution) is not allowed';
    }
    if (method === 'PATCH') {
      if (table !== 'coop_reports') return `PATCH on ${table} is not allowed (versions are immutable)`;
      const id = url.searchParams.get('id');
      if (!id || !id.startsWith('eq.') || id.length <= 3) return 'PATCH needs an id=eq.<id> filter (no bulk update)';
      const problem = patchBodyProblem(init?.body);
      if (problem) return problem;
    }
    return null;
  }

  const guarded = (async (input, init) => {
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    const raw = rawOf(input);
    const reason = violation(raw, method, init, input);
    if (reason) {
      const block: GuardBlock = {reason, method, path: raw.replace(/^https?:\/\/[^/]+/, '')};
      stats.blocked.push(block);
      opts.onTrip?.(block);
      throw new Error(`reports guard: ${reason}`);
    }
    stats.allowed += 1;
    return opts.underlying(input, init);
  }) as typeof fetch;

  return {fetch: guarded, stats};
}

// ---- the safety flag ------------------------------------------------------------------------------------------------

/** Throws when COOP_REQUIRE_LOCAL_DB=1 and `url` is not on 127.0.0.1 or localhost. */
export function assertLocalIfRequired(url: string, env: Record<string, string | undefined>): void {
  if (env.COOP_REQUIRE_LOCAL_DB !== '1') return;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('COOP_REQUIRE_LOCAL_DB=1: the database URL is not a valid URL, refusing to connect.');
  }
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`COOP_REQUIRE_LOCAL_DB=1: refusing to connect to ${host} (only 127.0.0.1 or localhost is allowed).`);
  }
}

// ---- the typed clients (layer 3: only the methods each client needs exist on its type) -------------------------------

export type {DbError};
export interface DbResult<T> {
  data: T | null;
  error: DbError | null;
}
export type DbRow = Record<string, unknown>;
export type DbValue = string | number | boolean;

/** A query that resolves to rows. Awaiting it sends the request. */
export interface RowsBuilder extends PromiseLike<DbResult<DbRow[]>> {
  eq(column: string, value: DbValue): RowsBuilder;
  is(column: string, value: null): RowsBuilder;
  /** `column < value`: lets the counter advance only forwards. */
  lt(column: string, value: number): RowsBuilder;
  order(column: string, options?: {ascending?: boolean}): RowsBuilder;
  limit(count: number): RowsBuilder;
  /** After insert or update: return the written rows (Prefer: return=representation). */
  select(columns?: string): RowsBuilder;
  maybeSingle(): PromiseLike<DbResult<DbRow>>;
}

/** No insert, update, delete, upsert or rpc in its type. */
export interface ReportsReadClient {
  from(table: ReportsTable): {select(columns: string): RowsBuilder};
}

/** insert and update only: no delete, no upsert, no rpc. */
export interface ReportsWriteClient {
  from(table: ReportsTable): {
    select(columns: string): RowsBuilder;
    insert(values: DbRow): RowsBuilder;
    update(values: DbRow): RowsBuilder;
  };
}

export interface ReportsClientOptions {
  env?: Record<string, string | undefined>;
  /** Test seam: the fetch that sits under the guard. Defaults to the global fetch. */
  underlying?: typeof fetch;
  onTrip?: (block: GuardBlock) => void;
}

/** True when the archive Supabase env is absent: the reports pages and actions run in demo mode. */
export function usingReportsMock(env: Record<string, string | undefined> = process.env): boolean {
  return !env.SUPABASE_URL_ARCHIVE || !env.SUPABASE_SERVICE_ROLE_KEY_ARCHIVE;
}

const GUARD_PREFIX = 'reports guard:';

/**
 * supabase-js swallows a throwing fetch into an `{error}` result. A guard trip is a bug, not a database error, so it is
 * surfaced again as a THROW here (the guard also counts it and calls onTrip before this point).
 */
function surface<T>(pending: PromiseLike<DbResult<T>>): PromiseLike<DbResult<T>> {
  return pending.then((r) => {
    if (r.error?.message.includes(GUARD_PREFIX)) throw new Error(r.error.message);
    return r;
  });
}

function wrap(b: RowsBuilder): RowsBuilder {
  return {
    eq: (c, v) => wrap(b.eq(c, v)),
    is: (c, v) => wrap(b.is(c, v)),
    lt: (c, v) => wrap(b.lt(c, v)),
    order: (c, o) => wrap(b.order(c, o)),
    limit: (n) => wrap(b.limit(n)),
    select: (c) => wrap(b.select(c)),
    maybeSingle: () => surface(b.maybeSingle()),
    then: (res, rej) => surface(b).then(res, rej),
  };
}

/**
 * The client a caller gets is NOT the supabase-js client: it is a narrow object whose `from()` refuses any table but the
 * two, and whose builders expose only what this mode needs. `delete`, `upsert`, `rpc`, `storage`, `auth` do not exist on it
 * (calling one is a TypeError), and the guarded fetch underneath refuses them anyway.
 */
function build(mode: GuardMode, opts: ReportsClientOptions): {client: ReportsWriteClient; stats: ReportsGuardStats} {
  const env = opts.env ?? process.env;
  const url = env.SUPABASE_URL_ARCHIVE;
  const key = env.SUPABASE_SERVICE_ROLE_KEY_ARCHIVE;
  if (!url || !key) throw new Error('reports Supabase env not configured');
  assertLocalIfRequired(url, env);
  const {fetch: guarded, stats} = createReportsGuardedFetch({baseUrl: url, mode, underlying: opts.underlying ?? fetch, onTrip: opts.onTrip});
  const supabase = createClient(url, key, {auth: {persistSession: false, autoRefreshToken: false}, global: {fetch: guarded}});
  const client: ReportsWriteClient = {
    from(table) {
      if (!(REPORT_TABLES as readonly string[]).includes(table)) throw new Error(`reports client: table ${String(table)} is not a reports table`);
      const t = supabase.from(table);
      const read = {select: (cols: string) => wrap(t.select(cols) as unknown as RowsBuilder)};
      if (mode === 'read') return read as ReturnType<ReportsWriteClient['from']>;
      return {...read, insert: (v) => wrap(t.insert(v) as unknown as RowsBuilder), update: (v) => wrap(t.update(v) as unknown as RowsBuilder)};
    },
  };
  return {client, stats};
}

/** Service role, GET and HEAD on the two report tables only. Throws when the env is unset or the local-DB flag fails. */
export function reportsReadClient(opts: ReportsClientOptions = {}): {client: ReportsReadClient; stats: ReportsGuardStats} {
  const {client, stats} = build('read', opts);
  return {client, stats};
}

/** Service role, GET, HEAD, POST and PATCH on the two report tables only. Used by src/reports-actions.ts and nothing else. */
export function reportsWriteClient(opts: ReportsClientOptions = {}): {client: ReportsWriteClient; stats: ReportsGuardStats} {
  return build('write', opts);
}

/** True when the tables do not exist yet (shared with every dashboard-owned table: src/supabase-errors.ts). */
export {isMissingTable} from './supabase-errors';
