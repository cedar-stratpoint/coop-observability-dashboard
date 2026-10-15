// list_tables and describe_table (spec 2.3), and the live relation rule the production validator uses. They read LIVE from
// information_schema AS the read-only login, so only granted tables and columns appear (information_schema shows a relation or column
// only when the user holds a privilege on it), merged with the runtime catalog's notes (catalog.json, never sent whole). Fixed SQL
// written by code: the only input is a table name that must be a plain identifier and open. Pure apart from the injected runQuery.
import {logExploreSchema, type AuditSink} from '../audit';
import {catalogTable} from '../catalog';
import {EXPLORE_OPEN_DOMAINS, closedReason, closedRelationMessage, relationRule, type RelationKind} from './access';
import type {RunQuery} from './executor';
import {createExploreValidator, wrapCursor, type ExploreValidator} from './parse';
import {isSecretColumn} from './secret-names';
import {EXPLORE_ERROR_MESSAGES, type ValidateErr} from './types';

export const LIST_TABLES_SQL = "select t.table_name, t.table_type from information_schema.tables t where t.table_schema = 'public' order by t.table_name";
export const describeTableSql = (table: string): string =>
  'select c.column_name, c.data_type, c.is_nullable, t.table_type from information_schema.columns c join information_schema.tables t ' +
  `on t.table_schema = c.table_schema and t.table_name = c.table_name where c.table_schema = 'public' and c.table_name = '${table}' order by c.ordinal_position`;
export const SCHEMA_CALLS_PER_QUESTION = 8;
const NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const OPTS = {timeoutMs: 3000, maxRows: 500};
const RELATION_ERROR = {error: `E_RELATION: ${EXPLORE_ERROR_MESSAGES.E_RELATION}`};
const DOMAIN_ERROR = {error: `E_INPUT: Unknown domain; use "all" or one of ${EXPLORE_OPEN_DOMAINS.join(', ')}.`};
const RATE_ERROR = {error: `E_RATE_DAY: ${EXPLORE_ERROR_MESSAGES.E_RATE_DAY}`};
const ABOUT_MAX = 160;

export interface SchemaTools {
  list_tables: (input: unknown) => Promise<unknown>;
  describe_table: (input: unknown) => Promise<unknown>;
}

/** BASE TABLE is a table; anything else (VIEW, FOREIGN) is held to the view allowlist. Materialized views are not in information_schema. */
const kindOf = (tableType: unknown): RelationKind => (tableType === 'BASE TABLE' ? 'table' : 'view');

/** Every relation the login can see and Ask Coop may read: closed names and views off the allowlist are dropped. */
export async function listOpenTables(runQuery: RunQuery): Promise<{name: string; kind: RelationKind}[]> {
  const r = await runQuery(wrapCursor(LIST_TABLES_SQL), OPTS);
  const all = r.rows.map((row) => ({name: String(row[0]), kind: kindOf(row[1])}));
  const allowed = relationRule(new Map(all.map((t) => [t.name, t.kind])));
  return all.filter((t) => allowed(t.name));
}

/** The first sentence of a catalog note, capped: list_tables stays one short line per table. */
const firstSentence = (s: string): string => {
  const m = /^.*?[.!?](?=\s|$)/.exec(s);
  const one = m ? m[0] : s;
  return one.length > ABOUT_MAX ? `${one.slice(0, ABOUT_MAX - 1)}…` : one;
};

/** The audit and the per-user daily gate the run_query executor uses (Task 7 review finding 8). All optional: tests omit them. */
export interface SchemaToolDeps {
  user?: string | null;
  sink?: AuditSink;
  /** Called once per call that would reach the database; false = today's allowance is used up. */
  dayGate?: () => boolean;
}

/** The error code of a tool result, for the audit line. */
const codeOf = (out: unknown): string | null => {
  const e = (out as {error?: unknown} | null)?.error;
  return typeof e === 'string' ? (/^(E_[A-Z_]+)/.exec(e)?.[1] ?? 'E_UNKNOWN') : null;
};

export function createSchemaTools(runQuery: RunQuery, deps: SchemaToolDeps = {}): SchemaTools {
  let calls = 0;
  const over = (): {error: string} | null =>
    ++calls > SCHEMA_CALLS_PER_QUESTION ? {error: `E_CALLS: At most ${SCHEMA_CALLS_PER_QUESTION} list_tables or describe_table calls per question.`} : null;
  const gated = (): boolean => !deps.dayGate || deps.dayGate();
  const audited = <T>(tool: 'list_tables' | 'describe_table', at: {table?: string | null; domain?: string | null}, out: T): T => {
    const code = codeOf(out);
    logExploreSchema({tool, ok: code === null, code, ...at, user: deps.user ?? null}, deps.sink);
    return out;
  };
  return {
    list_tables: async (input) => {
      const raw = (input as {domain?: unknown} | null)?.domain;
      const at = {domain: typeof raw === 'string' && /^[a-z0-9-]{1,40}$/.test(raw) ? raw : null}; // only id-shaped text is logged
      return audited('list_tables', at, await listTables(raw));
    },
    describe_table: async (input) => {
      const raw = (input as {table?: unknown} | null)?.table;
      const at = {table: typeof raw === 'string' && NAME_RE.test(raw) ? raw : null}; // a malformed name is never logged as text
      return audited('describe_table', at, await describeTable(raw));
    },
  };

  async function listTables(domain: unknown): Promise<unknown> {
    const stop = over();
    if (stop) return stop;
    if (domain !== 'all' && !(typeof domain === 'string' && EXPLORE_OPEN_DOMAINS.includes(domain))) return DOMAIN_ERROR;
    if (!gated()) return RATE_ERROR;
    try {
      const tables = (await listOpenTables(runQuery))
        .map((t) => {
          const c = catalogTable(t.name);
          return {table: t.name, kind: t.kind, domain: c?.domain ?? null, ...(c?.about ? {about: firstSentence(c.about)} : {}), ...(c?.prefer ? {prefer: c.prefer} : {})};
        })
        .filter((t) => domain === 'all' || t.domain === domain);
      return {tables, note: 'Every listed table is readable with run_query. Call describe_table for its columns. domain null = not in the data catalog yet.'};
    } catch {
      return {error: 'E_UNAVAILABLE: The table list could not be read right now.'};
    }
  }

  async function describeTable(table: unknown): Promise<unknown> {
    const stop = over();
    if (stop) return stop;
    if (typeof table !== 'string' || !NAME_RE.test(table)) return RELATION_ERROR;
    const reason = closedReason(table); // from the name rule, not the catalog: a closed name is never sent to the database
    if (reason) return {error: closedRelationMessage(table, reason)};
    if (!gated()) return RATE_ERROR;
    try {
      const r = await runQuery(wrapCursor(describeTableSql(table)), OPTS);
      if (r.rows.length === 0 || !relationRule(new Map([[table, kindOf(r.rows[0][3])]]))(table)) return RELATION_ERROR;
      const columns = r.rows
        .map((row) => ({name: String(row[0]), type: String(row[1]), nullable: row[2] === 'YES'}))
        .filter((c) => !isSecretColumn(table, c.name));
      if (columns.length === 0) return RELATION_ERROR;
      const c = catalogTable(table);
      return {table, about: c?.about ?? null, ...(c?.prefer ? {prefer: c.prefer} : {}), ...(c?.columns ? {catalog_columns: c.columns} : {}), columns};
    } catch {
      return {error: 'E_UNAVAILABLE: The table could not be described right now.'};
    }
  }
}

const UNAVAILABLE: ValidateErr = {ok: false, code: 'E_UNAVAILABLE', message: EXPLORE_ERROR_MESSAGES.E_UNAVAILABLE, trip: null};

/**
 * The production validator: the parser's relation rule with the LIVE kinds the login sees (a view must be allowlisted, a name the login
 * cannot see is refused before the database is asked). Read once per question. When the read fails, it fails CLOSED: every query of
 * this question is E_UNAVAILABLE and nothing is sent (Task 7 review finding 5), and the read is not retried against a struggling database.
 * The static `validateExploreSql` is only for the code-written SQL (leadFacts, coverageLine).
 */
export function createLiveValidator(runQuery: RunQuery): ExploreValidator {
  let live: Promise<ExploreValidator | null> | null = null;
  const load = (): Promise<ExploreValidator | null> =>
    (live ??= runQuery(wrapCursor(LIST_TABLES_SQL), OPTS)
      .then((r) => createExploreValidator({relationAllowed: relationRule(new Map(r.rows.map((row) => [String(row[0]), kindOf(row[1])])))}))
      .catch(() => null));
  return async (sql, limits) => {
    const v = await load();
    return v ? v(sql, limits) : UNAVAILABLE;
  };
}
