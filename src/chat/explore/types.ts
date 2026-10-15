// Shared contract for Ask Coop Explore mode (spec sections 3.4, 3.6, 2.1). Pure data and types, no runtime deps, importable from
// anywhere (vitest, scripts, the catalog). Error messages are fixed constants: they never echo the SQL or raw database text.

export {EXPLORE_VIEWS, EXPLORE_VIEW_NAMES} from './views';
export type {ExploreViewName} from './views';

/** Columns whose NAME matches this are never exposed (case-insensitive substring; fails closed). The same pattern is in coop_chat_explore.sql. */
export const EXPLORE_BLOCKED_COLUMN_PATTERN = 'password|token|secret|key|pin|hash|credential';
export const EXPLORE_BLOCKED_COLUMN_RE = /password|token|secret|key|pin|hash|credential/i;
/** Innocent names that would otherwise be blocked by the substring rule. Empty on purpose; pinned by a test (any addition is a reviewed diff). */
export const EXPLORE_COLUMN_PATTERN_EXCEPTIONS: readonly string[] = [];
export const isBlockedColumnName = (name: string): boolean => !EXPLORE_COLUMN_PATTERN_EXCEPTIONS.includes(name.toLowerCase()) && EXPLORE_BLOCKED_COLUMN_RE.test(name);

/** The role the Explore connection must log in as (the pooler form is `coop_explore_ro.<project-ref>`). */
export const EXPLORE_ROLE = 'coop_explore_ro';

/** The allowlisted functions (spec 4.2 step 6). Lives here so the E_FUNCTION message can list them; parse.ts re-exports it as EXPLORE_FUNCTIONS. */
export const EXPLORE_FUNCTION_NAMES = [
  'count', 'sum', 'avg', 'min', 'max', 'string_agg', 'percentile_cont',
  'round', 'floor', 'ceil', 'ceiling', 'abs',
  'lower', 'upper', 'initcap', 'length', 'substr', 'substring', 'split_part', 'btrim', 'ltrim', 'rtrim', 'replace', 'concat', 'left', 'right',
  'date_trunc', 'date_part', 'extract', 'timezone', 'to_char', 'now',
  'row_number', 'rank', 'dense_rank', 'lag', 'lead',
  'jsonb_array_length', 'jsonb_extract_path_text',
  'generate_series',
] as const;

export type ExploreErrorCode =
  | 'E_INPUT' | 'E_EMPTY' | 'E_TOO_LONG' | 'E_NUL_BYTE' | 'E_CONTROL_CHARS' | 'E_SYNTAX' | 'E_MULTI_STATEMENT' | 'E_NOT_SELECT'
  | 'E_SELECT_INTO' | 'E_LOCKING' | 'E_DML_IN_CTE' | 'E_WRAPPER_MISMATCH' | 'E_RECURSIVE' | 'E_VALUES' | 'E_PARAM' | 'E_NODE'
  | 'E_SELECT_STAR' | 'E_CONSTANT_COLUMN' | 'E_TOO_MANY_COLUMNS' | 'E_CROSS_JOIN' | 'E_LATERAL' | 'E_TOO_MANY_RELATIONS' | 'E_TOO_DEEP'
  | 'E_RELATION' | 'E_CATALOG' | 'E_FUNCTION' | 'E_FUNCTION_DENIED' | 'E_OPERATOR' | 'E_CAST' | 'E_BLOCKED_COLUMN' | 'E_TIMEOUT'
  | 'E_COLUMN' | 'E_GROUPING' | 'E_AMBIGUOUS' | 'E_TYPE' | 'E_DIV_ZERO' | 'E_DATA' | 'E_RESULT_TOO_BIG' | 'E_DB_DENIED' | 'E_DB_OTHER'
  | 'E_UNAVAILABLE' | 'E_CALLS' | 'E_RATE_DAY' | 'E_DISABLED';

/** R repairable, S soft trip, H hard trip (ends the turn), L limit (not fixable by SQL). */
export type ExploreErrorClass = 'R' | 'S' | 'H' | 'L';

export const EXPLORE_ERROR_CLASS: Record<ExploreErrorCode, ExploreErrorClass> = {
  E_INPUT: 'R', E_EMPTY: 'R', E_TOO_LONG: 'R', E_NUL_BYTE: 'H', E_CONTROL_CHARS: 'H', E_SYNTAX: 'R', E_MULTI_STATEMENT: 'H', E_NOT_SELECT: 'H',
  E_SELECT_INTO: 'H', E_LOCKING: 'H', E_DML_IN_CTE: 'H', E_WRAPPER_MISMATCH: 'H', E_RECURSIVE: 'R', E_VALUES: 'R', E_PARAM: 'R', E_NODE: 'R',
  E_SELECT_STAR: 'R', E_CONSTANT_COLUMN: 'R', E_TOO_MANY_COLUMNS: 'R', E_CROSS_JOIN: 'R', E_LATERAL: 'R', E_TOO_MANY_RELATIONS: 'R', E_TOO_DEEP: 'R',
  E_RELATION: 'R', E_CATALOG: 'H', E_FUNCTION: 'R', E_FUNCTION_DENIED: 'H', E_OPERATOR: 'S', E_CAST: 'R', E_BLOCKED_COLUMN: 'S', E_TIMEOUT: 'R',
  E_COLUMN: 'R', E_GROUPING: 'R', E_AMBIGUOUS: 'R', E_TYPE: 'R', E_DIV_ZERO: 'R', E_DATA: 'R', E_RESULT_TOO_BIG: 'R', E_DB_DENIED: 'H', E_DB_OTHER: 'R',
  E_UNAVAILABLE: 'L', E_CALLS: 'L', E_RATE_DAY: 'L', E_DISABLED: 'L',
};

export const EXPLORE_ERROR_MESSAGES: Record<ExploreErrorCode, string> = {
  E_INPUT: 'Send {purpose, sql, step} with step probe or final.',
  E_EMPTY: 'The SQL is empty.',
  E_TOO_LONG: 'The SQL is longer than 2000 characters. Use fewer columns or a simpler query.',
  E_NUL_BYTE: 'The SQL contains a NUL byte.',
  E_CONTROL_CHARS: 'The SQL contains hidden control or direction characters.',
  E_SYNTAX: 'SQL syntax error near character <n>.',
  E_MULTI_STATEMENT: 'Only one statement is allowed.',
  E_NOT_SELECT: 'Only a SELECT is allowed. Ask Coop cannot change anything.',
  E_SELECT_INTO: 'SELECT INTO is not allowed.',
  E_LOCKING: 'FOR UPDATE and FOR SHARE are not allowed.',
  E_DML_IN_CTE: 'A WITH query may only contain SELECTs.',
  E_WRAPPER_MISMATCH: 'The query could not be validated as sent.',
  E_RECURSIVE: 'WITH RECURSIVE is not allowed.',
  E_VALUES: 'VALUES lists are not allowed; read the data from the views.',
  E_PARAM: 'Query parameters ($1) are not allowed; write the value in the SQL.',
  E_NODE: 'That SQL feature is not allowed (for example sampling, arrays, grouping sets, collations).',
  E_SELECT_STAR: 'Name the columns you need; * and a whole-row reference (t, t::text) are not allowed (count(*) is fine).',
  E_CONSTANT_COLUMN: 'Every output column must come from a column or an aggregate; do not type values into the SELECT list.',
  E_TOO_MANY_COLUMNS: 'At most 12 output columns.',
  E_CROSS_JOIN: 'Use an explicit JOIN ... ON with a real condition (no comma joins, CROSS, NATURAL, or ON true).',
  E_LATERAL: 'LATERAL is not allowed.',
  E_TOO_MANY_RELATIONS: 'At most 8 table references in one query; use CTEs to reduce.',
  E_TOO_DEEP: 'The query is nested too deeply (limit 20).',
  E_RELATION: "Only tables and views in public can be read, by their plain lower-case name (no other schema). Secret tables and other companies' tables are never readable. Call list_tables to see what is.",
  E_CATALOG: 'System catalogs are not readable.',
  E_FUNCTION: `That function is not allowed. Allowed: ${EXPLORE_FUNCTION_NAMES.join(', ')}.`,
  E_FUNCTION_DENIED: 'That function is blocked.',
  E_OPERATOR: 'That operator is not allowed. Allowed: + - * / % = <> < > <= >= || -> ->> LIKE ILIKE ~ ~*.',
  E_CAST: 'That type is not allowed. Allowed: text, integer, bigint, numeric, double precision, date, timestamp, timestamptz, interval.',
  E_BLOCKED_COLUMN: 'That column or JSON key is secret (a word part password, token, secret, key, pin, hash or credential) and is never readable. Write a JSON key as a plain string literal.',
  E_TIMEOUT: 'The query took longer than 5 seconds. Narrow the dates or aggregate more.',
  E_COLUMN: 'A column does not exist in that view. Check the catalog.',
  E_GROUPING: 'Every selected column must be in GROUP BY or inside an aggregate.',
  E_AMBIGUOUS: 'A column name is ambiguous; qualify it with the table alias.',
  E_TYPE: 'Types do not match; add a cast (::numeric, ::text, ::date).',
  E_DIV_ZERO: 'Division by zero; wrap the denominator in nullif(x, 0).',
  E_DATA: 'A value could not be converted (bad date or number).',
  E_RESULT_TOO_BIG: 'One row is larger than 64 KB; select fewer or smaller columns (extract jsonb with ->>).',
  E_DB_DENIED: 'The database refused the query.',
  E_DB_OTHER: 'The database could not run that query. Simplify it.',
  E_UNAVAILABLE: 'Exploratory queries are unavailable right now. Use the registry tools.',
  E_CALLS: 'You have used all 5 exploratory calls for this question. Answer with what you have, and say what is missing.',
  E_RATE_DAY: 'The daily limit of exploratory queries is reached. Registry tools still work.',
  E_DISABLED: 'Exploratory queries are off.',
};

/** Env knobs resolved by config.ts (section 3.6). */
export interface ExploreLimits {
  maxRows: number;
  maxCols: number;
  maxBytes: number;
  timeoutMs: number;
  maxSqlChars: number;
  maxCallsPerQuestion: number;
  maxPerUserDay: number;
  modelRows: number;
  maxRelations: number;
  maxDepth: number;
}

export interface ExploreEnv {
  NODE_ENV?: string;
  EXPLORE_MODE?: string;
  EXPLORE_DATABASE_URL?: string;
  EXPLORE_ALLOWED_EMAILS?: string;
  ALLOWED_EMAILS?: string;
  CHAT_READ_MODE?: string;
  [k: string]: string | undefined;
}

export type ExploreOffReason = 'mode_off' | 'url_missing' | 'url_invalid' | 'url_role' | 'url_not_local' | 'list_empty' | 'user_not_allowed' | 'allowed_emails_unset' | 'not_ro_role';

export type ExploreAccess = {enabled: true; limits: ExploreLimits; databaseUrl: string} | {enabled: false; reason: string};

export type ExploreLint = {code: 'W_NO_STATUS_FILTER'; message: string};

export type ValidateOk = {
  ok: true;
  sql: string; // the exact input, unchanged
  sent: string; // wrapCursor(sql): what the driver will send
  relations: string[];
  /** Every column reference in the statement, resolved to its relation when it is qualified by an alias (null: unqualified or a CTE). */
  columnRefs: {relation: string | null; column: string}[];
  ctes: string[];
  functions: string[];
  outputColumns: string[]; // output names of the outermost SELECT
  fingerprint: string; // 16 hex, shape without literals
  literalsHash: string; // 12 hex, hash of the literal values; the values are never returned
  lints: ExploreLint[];
};
export type ValidateErr = {ok: false; code: ExploreErrorCode; message: string; trip: 'hard' | 'soft' | null; at?: number};
