// The gatekeeper for Ask Coop Explore mode: validates ONE read-only SELECT with the real Postgres parser (libpg-query) before it is
// ever sent to the database. Spec section 4. Pure module (no `server-only`, no Next import) so vitest and the proof script can load it.
// Only THIS file imports `libpg-query`. It never throws: an unexpected exception becomes E_WRAPPER_MISMATCH (fail closed).
//
// Layers (spec 5.4): this is layer 2 of 5. It is not the only lock: the role holds SELECT only (every open table and allowlisted view,
// never a secret- or tenant-named one or a secret column; supabase/coop_chat_explore_direct.sql) and no write privilege, and a
// READ ONLY transaction is NOT a barrier by itself (Day 1), so everything here is default-deny:
//   - every AST node type must be on EXPLORE_NODE_TYPES, anything else is E_NODE;
//   - the exact string that will be sent (the DECLARE ... CURSOR FOR wrapper) is parsed too and must equal the standalone SELECT.
import {parse as pgParse} from 'libpg-query';
import {fingerprintStatement} from './fingerprint';
import {DEFAULT_EXPLORE_LIMITS} from './limits';
import {relationRule} from './access';
import {EXPLORE_SECRET_COLUMN_EXCEPTIONS, isSecretJsonKey, isSecretName} from './secret-names';
import {
  EXPLORE_ERROR_CLASS,
  EXPLORE_ERROR_MESSAGES,
  EXPLORE_FUNCTION_NAMES,
  type ExploreErrorCode,
  type ExploreLimits,
  type ExploreLint,
  type ValidateErr,
  type ValidateOk,
} from './types';
import {baseRelation} from './views';

export type {ExploreLint, ValidateErr, ValidateOk} from './types';

export const CURSOR_NAME = 'coop_explore_c';
export const wrapCursor = (sql: string): string => `DECLARE ${CURSOR_NAME} NO SCROLL CURSOR FOR ${sql}`;

/** Allowed functions (spec 4.2 step 6). The parser itself qualifies SQL-standard constructs (`pg_catalog.extract`, `btrim`, `timezone`). */
export const EXPLORE_FUNCTIONS: readonly string[] = EXPLORE_FUNCTION_NAMES;
/** Explicitly denied, in addition to the `pg_*`, `dblink*` and `lo_*` prefixes. */
export const EXPLORE_DENIED_FUNCTIONS: readonly string[] = [
  'set_config', 'current_setting', 'repeat', 'version', 'current_database', 'current_schema', 'current_schemas', 'inet_server_addr', 'inet_client_addr',
  'txid_current', 'nextval', 'currval', 'setval', 'lastval', 'xpath', 'xmlparse',
  // Query-running functions: they run a query given as a STRING, as the login, which this walk never sees (Task 3 review). The
  // *_to_xml* families are also denied by prefix below, so a variant spelling is caught too.
  'query_to_xml', 'query_to_xmlschema', 'query_to_xml_and_xmlschema', 'table_to_xml', 'table_to_xmlschema', 'table_to_xml_and_xmlschema',
  'cursor_to_xml', 'cursor_to_xmlschema', 'schema_to_xml', 'schema_to_xmlschema', 'schema_to_xml_and_xmlschema',
  'database_to_xml', 'database_to_xmlschema', 'database_to_xml_and_xmlschema', 'ts_stat', 'ts_rewrite', 'to_tsquery',
];
const DENIED_PREFIXES: readonly string[] = ['pg_', 'dblink', 'lo_', 'query_to_xml', 'table_to_xml', 'cursor_to_xml', 'schema_to_xml', 'database_to_xml'];
/** A relation name the parser accepts: plain lower-case (a quoted mixed-case or Unicode-escaped look-alike never matches). */
const RELATION_NAME_RE = /^[a-z_][a-z0-9_]*$/;
export const EXPLORE_OPERATORS: readonly string[] = ['+', '-', '*', '/', '%', '=', '<>', '!=', '<', '>', '<=', '>=', '||', '->', '->>', '~~', '~~*', '!~~', '!~~*', '~', '~*', '!~', '!~*'];
/** The parser spells integer as pg_catalog.int4 and double precision as pg_catalog.float8. varchar, bpchar, bool, json, regclass... are not allowed. */
export const EXPLORE_CASTS: readonly string[] = ['text', 'int4', 'int8', 'numeric', 'float8', 'date', 'timestamp', 'timestamptz', 'interval'];
export const EXPLORE_NODE_TYPES: readonly string[] = [
  'SelectStmt', 'WithClause', 'CommonTableExpr', 'ResTarget', 'ColumnRef', 'String', 'Integer', 'Float', 'Boolean', 'A_Const', 'A_Expr', 'BoolExpr',
  'FuncCall', 'TypeCast', 'TypeName', 'RangeVar', 'JoinExpr', 'Alias', 'SortBy', 'CaseExpr', 'CaseWhen', 'NullTest', 'BooleanTest', 'SubLink',
  'CoalesceExpr', 'MinMaxExpr', 'SQLValueFunction', 'WindowDef', 'RangeSubselect', 'RangeFunction', 'List', 'CollateClause',
];

/** Violation priority (spec 4.2). `E_RECURSIVE`, `E_VALUES`, `E_PARAM` sit before the shape rules: see the deviation list in the build report. */
const PRIORITY: ExploreErrorCode[] = [
  'E_NOT_SELECT', 'E_MULTI_STATEMENT', 'E_SELECT_INTO', 'E_LOCKING', 'E_DML_IN_CTE', 'E_CATALOG', 'E_FUNCTION_DENIED', 'E_BLOCKED_COLUMN', 'E_RELATION', 'E_FUNCTION',
  'E_OPERATOR', 'E_CAST', 'E_NODE', 'E_SELECT_STAR', 'E_RECURSIVE', 'E_VALUES', 'E_PARAM', 'E_CONSTANT_COLUMN', 'E_CROSS_JOIN', 'E_LATERAL',
  'E_TOO_MANY_RELATIONS', 'E_TOO_MANY_COLUMNS', 'E_TOO_DEEP',
];

const OP_KINDS = new Set(['AEXPR_OP', 'AEXPR_OP_ANY', 'AEXPR_DISTINCT', 'AEXPR_NOT_DISTINCT', 'AEXPR_NULLIF', 'AEXPR_IN', 'AEXPR_LIKE', 'AEXPR_ILIKE']);
const BETWEEN_KINDS = new Set(['AEXPR_BETWEEN', 'AEXPR_NOT_BETWEEN', 'AEXPR_BETWEEN_SYM', 'AEXPR_NOT_BETWEEN_SYM']);
const SVF_ALLOWED = new Set(['SVFOP_CURRENT_DATE', 'SVFOP_CURRENT_TIMESTAMP', 'SVFOP_LOCALTIMESTAMP']);
const SVF_DENIED = new Set(['SVFOP_CURRENT_USER', 'SVFOP_SESSION_USER', 'SVFOP_USER', 'SVFOP_CURRENT_ROLE', 'SVFOP_CURRENT_CATALOG', 'SVFOP_CURRENT_SCHEMA']);
const DML_NODES = new Set(['InsertStmt', 'UpdateStmt', 'DeleteStmt', 'MergeStmt']);
/** Raw (unwrapped) object fields of the parse tree and the node type each one holds. Any other raw object is an unknown shape: E_NODE. */
const RAW_FIELDS: Record<string, string> = {alias: 'Alias', typeName: 'TypeName', withClause: 'WithClause', intoClause: 'IntoClause', over: 'WindowDef', larg: 'SelectStmt', rarg: 'SelectStmt'};
const MAX_JSON_DEPTH = 200;

const CONTROL_RE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u0001-\u0008\u000b\u000c\u000e-\u001f]/;

type Obj = Record<string, any>;
type ParseFn = (sql: string) => Promise<unknown>;

export interface ValidatorOptions {
  functions?: readonly string[];
  deniedFunctions?: readonly string[];
  deniedPrefixes?: readonly string[];
  nodeTypes?: readonly string[];
  /** Which public relation names may be read (default: relationRule(), every name that is not closed). The database grants are the real lock. */
  relationAllowed?: (name: string) => boolean;
  /** Which column names are secret (default: the whole-word rule of secret-names.ts). */
  secretName?: (name: string) => boolean;
  /** Test seam: a replacement parser (used by the mutation checks of spec 4.8). Production never sets it. */
  parse?: ParseFn;
  /** Test seam for the mutation check "a validator that skips the wrapper check must be caught". Production never sets it. */
  skipWrapperCheck?: boolean;
}

const err = (code: ExploreErrorCode, at?: number): ValidateErr => {
  const cls = EXPLORE_ERROR_CLASS[code];
  const message = code === 'E_SYNTAX' ? (at === undefined ? 'SQL syntax error.' : EXPLORE_ERROR_MESSAGES.E_SYNTAX.replace('<n>', String(at))) : EXPLORE_ERROR_MESSAGES[code];
  const out: ValidateErr = {ok: false, code, message, trip: cls === 'H' ? 'hard' : cls === 'S' ? 'soft' : null};
  if (at !== undefined) out.at = at;
  return out;
};

const stripLoc = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(stripLoc);
  if (v && typeof v === 'object') {
    const out: Obj = {};
    for (const [k, x] of Object.entries(v as Obj)) if (k !== 'location' && k !== 'stmt_len' && k !== 'stmt_location') out[k] = stripLoc(x);
    return out;
  }
  return v;
};

const wrapped = (v: unknown): {type: string; body: Obj} | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1 || !/^[A-Z]/.test(keys[0])) return null;
  const body = (v as Obj)[keys[0]];
  return body && typeof body === 'object' && !Array.isArray(body) ? {type: keys[0], body} : null;
};

const strOf = (n: unknown): string | null => {
  const w = wrapped(n);
  return w && w.type === 'String' && typeof w.body.sval === 'string' ? w.body.sval : null;
};
const namesOf = (list: unknown): (string | null)[] => (Array.isArray(list) ? list.map(strOf) : []);

/** Does the subtree hold at least one node of these types? */
const contains = (v: unknown, types: ReadonlySet<string>, depth = 0): boolean => {
  if (depth > MAX_JSON_DEPTH) return true; // too deep: treat as data (E_TOO_DEEP is reported by the main walk)
  if (Array.isArray(v)) return v.some((x) => contains(x, types, depth + 1));
  if (v && typeof v === 'object') {
    const w = wrapped(v);
    if (w && types.has(w.type)) return true;
    return Object.values(v as Obj).some((x) => contains(x, types, depth + 1));
  }
  return false;
};
const DATA_NODES = new Set(['ColumnRef', 'FuncCall', 'SQLValueFunction']);
const COLUMN_NODES = new Set(['ColumnRef']);

interface State {
  v: Required<Pick<ValidatorOptions, 'functions' | 'deniedFunctions' | 'deniedPrefixes' | 'nodeTypes' | 'relationAllowed' | 'secretName'>>;
  limits: ExploreLimits;
  violations: Set<ExploreErrorCode>;
  relations: string[];
  /** alias (or relation name) -> relation, for resolving column refs; `refs` = every column reference as written (qualifier or null, column). */
  aliases: Map<string, string>;
  /** Secret column names as written; judged after the walk, when every relation of the query is known (the pos_settings.key exception). */
  secretRefs: string[];
  refs: {qualifier: string | null; column: string}[];
  viewRefs: number;
  ctes: string[];
  functions: string[];
  statusSeen: boolean;
  seriesInFrom: WeakSet<object>;
  escapeCalls: WeakSet<object>;
  /** Names that denote a whole ROW when used as a column (relations, aliases, CTEs), and the bare refs to judge against them after the walk. */
  rowNames: Set<string>;
  bareRefs: string[];
  /** Aliases of FROM functions (generate_series): a bare ref to one is its scalar value, not a row. */
  functionAliases: WeakSet<object>;
}

/** Functions whose 2nd..nth arguments are JSON keys (spec 7: a secret-named key is a secret column by another name). */
const JSON_KEY_FUNCTIONS = new Set(['jsonb_extract_path_text']);
const JSON_KEY_OPERATORS = new Set(['->', '->>']);

/**
 * A JSON key operand must be a plain literal: a string that is not secret-named, or an integer index. A computed key cannot be judged,
 * so it is refused too (Task 7 review finding 1: JSON read as text never reaches the scanner's structural key rule).
 */
function checkJsonKey(node: unknown, st: State): void {
  const w = wrapped(node);
  if (!w || w.type !== 'A_Const') {
    st.violations.add('E_BLOCKED_COLUMN');
    return;
  }
  if (w.body.sval !== undefined) {
    const key = (w.body.sval as Obj).sval;
    if (typeof key !== 'string' || st.v.secretName(key.toLowerCase()) || isSecretJsonKey(key)) st.violations.add('E_BLOCKED_COLUMN'); // raw key: its case is a part boundary (R1)
  } else if (w.body.ival === undefined) st.violations.add('E_BLOCKED_COLUMN'); // a float, boolean or NULL key: not a key we read
}

const addUnique = <T>(a: T[], x: T) => {
  if (!a.includes(x)) a.push(x);
};

function walkSelect(body: Obj, scope: ReadonlySet<string>, depth: number, st: State, exists: boolean): void {
  if (depth > st.limits.maxDepth) st.violations.add('E_TOO_DEEP');
  if (body.valuesLists) st.violations.add('E_VALUES');
  if (body.intoClause) st.violations.add('E_SELECT_INTO');
  if (Array.isArray(body.lockingClause) && body.lockingClause.length > 0) st.violations.add('E_LOCKING');
  if (Array.isArray(body.fromClause) && body.fromClause.length > 1) st.violations.add('E_CROSS_JOIN');

  let inner = scope;
  const wc = body.withClause as Obj | undefined;
  if (wc) {
    if (wc.recursive) {
      st.violations.add('E_RECURSIVE');
      inner = new Set(inner); // a recursive CTE sees its own name (and the later ones) while it is walked
      for (const cte of (wc.ctes ?? []) as unknown[]) {
        const n = wrapped(cte)?.body.ctename;
        if (typeof n === 'string') (inner as Set<string>).add(n);
      }
    }
    for (const cte of (wc.ctes ?? []) as unknown[]) {
      const c = wrapped(cte);
      if (!c || c.type !== 'CommonTableExpr') {
        st.violations.add('E_NODE');
        continue;
      }
      const q = wrapped(c.body.ctequery);
      if (q && DML_NODES.has(q.type)) st.violations.add('E_DML_IN_CTE');
      else walkValue(c.body.ctequery, inner, depth + 1, st, 'ctequery', 0);
      inner = new Set(inner).add(String(c.body.ctename));
      addUnique(st.ctes, String(c.body.ctename));
      st.rowNames.add(String(c.body.ctename).toLowerCase());
    }
  }

  // Target list: every item must read data (a column, a function or an aggregate), never a typed-in value (E_CONSTANT_COLUMN).
  if (!exists && Array.isArray(body.targetList)) {
    for (const t of body.targetList as unknown[]) {
      const rt = wrapped(t);
      if (rt && rt.type === 'ResTarget' && !contains(rt.body.val, DATA_NODES)) st.violations.add('E_CONSTANT_COLUMN');
    }
  }

  for (const [k, val] of Object.entries(body)) {
    if (k === 'withClause') continue;
    if (k === 'larg' || k === 'rarg') {
      if (val && typeof val === 'object') walkSelect(val as Obj, inner, depth, st, false);
      continue;
    }
    walkValue(val, inner, depth, st, k, 0);
  }
}

function checkRangeVar(b: Obj, scope: ReadonlySet<string>, st: State): void {
  const name = String(b.relname ?? '');
  const schema = b.schemaname === undefined ? '' : String(b.schemaname);
  st.rowNames.add(name.toLowerCase());
  if (b.inh !== true || (b.relpersistence !== undefined && b.relpersistence !== 'p')) {
    st.violations.add('E_NODE'); // ONLY, temp or unlogged references
    return;
  }
  if (b.catalogname !== undefined) {
    st.violations.add('E_RELATION');
    return;
  }
  const lcSchema = schema.toLowerCase();
  if (lcSchema === 'pg_catalog' || lcSchema === 'information_schema' || lcSchema.startsWith('pg_') || name.toLowerCase().startsWith('pg_')) {
    st.violations.add('E_CATALOG');
    return;
  }
  if (schema === '' && scope.has(name)) return; // a CTE reference, in scope
  if ((schema === '' || schema === 'public') && RELATION_NAME_RE.test(name) && st.v.relationAllowed(name)) {
    st.viewRefs += 1;
    addUnique(st.relations, name);
    st.aliases.set(name, name);
    const alias = b.alias && typeof b.alias === 'object' ? ((b.alias as Obj).aliasname ?? (wrapped(b.alias)?.body.aliasname)) : undefined;
    if (typeof alias === 'string') st.aliases.set(alias, name);
    return;
  }
  st.violations.add('E_RELATION');
}

function checkFuncCall(b: Obj, st: State): void {
  if (st.escapeCalls.has(b)) return;
  const names = namesOf(b.funcname);
  const last = names[names.length - 1];
  if (names.length === 0 || names.some((n) => n === null) || last === null) {
    st.violations.add('E_FUNCTION');
    return;
  }
  const name = last.toLowerCase();
  if (st.v.deniedFunctions.includes(name) || st.v.deniedPrefixes.some((p) => name.startsWith(p))) {
    st.violations.add('E_FUNCTION_DENIED');
    return;
  }
  const qualifiedOk = names.length === 1 || (names.length === 2 && (names[0] as string).toLowerCase() === 'pg_catalog' && names[0] === 'pg_catalog');
  if (!qualifiedOk || !st.v.functions.includes(name)) {
    st.violations.add('E_FUNCTION');
    return;
  }
  addUnique(st.functions, name);
  if (JSON_KEY_FUNCTIONS.has(name)) for (const a of ((b.args ?? []) as unknown[]).slice(1)) checkJsonKey(a, st);
  if (b.func_variadic) st.violations.add('E_FUNCTION');
  if (b.agg_within_group && name !== 'percentile_cont') st.violations.add('E_FUNCTION');
  if (name === 'generate_series' && !st.seriesInFrom.has(b)) st.violations.add('E_FUNCTION'); // FROM-only
}

function checkOperatorNames(names: (string | null)[], st: State): void {
  if (names.length !== 1 || names[0] === null || !EXPLORE_OPERATORS.includes(names[0])) st.violations.add('E_OPERATOR');
}

function checkTypeName(tn: Obj, st: State): void {
  const names = namesOf(tn.names);
  const base = names.length === 2 && names[0] === 'pg_catalog' ? [names[1]] : names;
  if (base.length !== 1 || base[0] === null || !EXPLORE_CASTS.includes(base[0]) || tn.setof || (Array.isArray(tn.arrayBounds) && tn.arrayBounds.length > 0) || tn.pct_type) st.violations.add('E_CAST');
}

function walkNode(type: string, b: Obj, scope: ReadonlySet<string>, depth: number, st: State, jd: number, parentField: string): void {
  // Special nodes with their own codes come BEFORE the allowlist so the model gets a specific, repairable message.
  switch (type) {
    case 'A_Star':
      st.violations.add('E_SELECT_STAR');
      return;
    case 'ParamRef':
      st.violations.add('E_PARAM');
      return;
    case 'LockingClause':
      st.violations.add('E_LOCKING');
      return;
    case 'IntoClause':
      st.violations.add('E_SELECT_INTO');
      return;
    case 'InsertStmt':
    case 'UpdateStmt':
    case 'DeleteStmt':
    case 'MergeStmt':
      st.violations.add('E_DML_IN_CTE');
      return;
    default:
  }
  if (!st.v.nodeTypes.includes(type)) {
    st.violations.add('E_NODE');
    // keep walking: a hard violation deeper down must still win by priority
  }

  switch (type) {
    case 'SelectStmt':
      walkSelect(b, scope, parentField === '' ? 1 : depth + 1, st, false);
      return;
    case 'RangeVar':
      checkRangeVar(b, scope, st);
      break;
    case 'ColumnRef': {
      const names = ((b.fields ?? []) as unknown[]).map(strOf);
      const last = names[names.length - 1];
      if (typeof last === 'string') st.refs.push({qualifier: names.length >= 2 && typeof names[names.length - 2] === 'string' ? (names[names.length - 2] as string) : null, column: last.toLowerCase()});
      // `t` or `public.t` may be a whole row (t::text, concat(t)): judged after the walk, when every relation and alias is known
      if (typeof last === 'string' && (names.length === 1 || (names.length === 2 && names[0]?.toLowerCase() === 'public'))) st.bareRefs.push(last.toLowerCase());
      for (const f of (b.fields ?? []) as unknown[]) {
        const s = strOf(f);
        if (s !== null) {
          const lc = s.toLowerCase();
          if (lc === 'status') st.statusSeen = true;
          if (st.v.secretName(lc)) st.secretRefs.push(lc);
        }
      }
      break;
    }
    case 'FuncCall':
      checkFuncCall(b, st);
      break;
    case 'SQLValueFunction':
      if (SVF_DENIED.has(String(b.op))) st.violations.add('E_FUNCTION_DENIED');
      else if (!SVF_ALLOWED.has(String(b.op))) st.violations.add('E_FUNCTION');
      break;
    case 'A_Expr': {
      const kind = String(b.kind);
      if (OP_KINDS.has(kind)) {
        checkOperatorNames(namesOf(b.name), st);
        const op = namesOf(b.name);
        if (op.length === 1 && op[0] !== null && JSON_KEY_OPERATORS.has(op[0])) checkJsonKey(b.rexpr, st);
      }
      else if (!BETWEEN_KINDS.has(kind)) {
        st.violations.add('E_OPERATOR'); // SIMILAR TO, = ALL, anything new
        if (kind === 'AEXPR_SIMILAR') {
          // the parser rewrites SIMILAR TO's pattern through pg_catalog.similar_to_escape; the operator is the finding, not the function
          const r = wrapped(b.rexpr);
          if (r?.type === 'FuncCall' && namesOf(r.body.funcname).pop() === 'similar_to_escape') st.escapeCalls.add(r.body);
        }
      }
      break;
    }
    case 'TypeCast':
      if (b.typeName && typeof b.typeName === 'object') checkTypeName(b.typeName as Obj, st);
      else st.violations.add('E_CAST');
      break;
    case 'SubLink': {
      const t = String(b.subLinkType);
      if (t === 'ARRAY_SUBLINK') st.violations.add('E_NODE');
      else if (t === 'ALL_SUBLINK') st.violations.add('E_OPERATOR');
      else if (!['EXISTS_SUBLINK', 'ANY_SUBLINK', 'EXPR_SUBLINK'].includes(t)) st.violations.add('E_NODE');
      if (Array.isArray(b.operName)) checkOperatorNames(namesOf(b.operName), st);
      const sub = wrapped(b.subselect);
      for (const [k, val] of Object.entries(b)) {
        if (k === 'subselect' && sub && sub.type === 'SelectStmt') walkSelect(sub.body, scope, depth + 1, st, t === 'EXISTS_SUBLINK');
        else walkValue(val, scope, depth, st, k, jd + 1);
      }
      return;
    }
    case 'JoinExpr': {
      if (b.isNatural) st.violations.add('E_CROSS_JOIN');
      const hasUsing = Array.isArray(b.usingClause) && b.usingClause.length > 0;
      if (!hasUsing && !b.isNatural && (b.quals === undefined || !contains(b.quals, COLUMN_NODES))) st.violations.add('E_CROSS_JOIN');
      break;
    }
    case 'RangeSubselect':
      if (b.lateral) st.violations.add('E_LATERAL');
      break;
    case 'RangeFunction':
      if (b.lateral) st.violations.add('E_LATERAL');
      if (b.alias && typeof b.alias === 'object') st.functionAliases.add(b.alias as object);
      for (const fl of (b.functions ?? []) as unknown[]) {
        const l = wrapped(fl);
        for (const item of (l && l.type === 'List' ? l.body.items ?? [] : []) as unknown[]) {
          const f = wrapped(item);
          if (f && f.type === 'FuncCall') st.seriesInFrom.add(f.body);
        }
      }
      break;
    case 'TypeName':
      checkTypeName(b, st);
      break;
    case 'Alias':
      if (typeof b.aliasname === 'string' && !st.functionAliases.has(b)) st.rowNames.add(b.aliasname.toLowerCase());
      break;
    case 'CollateClause':
      // Only the byte-order collation "C" (the app's label rule: capitalised spelling wins). Any other collation is an unknown shape.
      if (namesOf(b.collname).join('.') !== 'C') st.violations.add('E_NODE');
      break;
    case 'A_Const':
      return; // a literal: its children are bare values ({ival: {ival: 1}}), nothing to walk
    default:
  }
  for (const [k, val] of Object.entries(b)) walkValue(val, scope, depth, st, k, jd + 1);
}

function walkValue(v: unknown, scope: ReadonlySet<string>, depth: number, st: State, parentField: string, jd: number): void {
  if (jd > MAX_JSON_DEPTH) {
    st.violations.add('E_TOO_DEEP');
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) walkValue(x, scope, depth, st, parentField, jd + 1);
    return;
  }
  if (!v || typeof v !== 'object') return;
  if (Object.keys(v).length === 0) return; // an explicit NULL list item
  const w = wrapped(v);
  if (w) {
    walkNode(w.type, w.body, scope, depth, st, jd, parentField === '__top' ? '' : parentField);
    return;
  }
  const rawType = RAW_FIELDS[parentField];
  if (rawType === undefined) {
    st.violations.add('E_NODE'); // an object of a shape we do not know
    return;
  }
  walkNode(rawType, v as Obj, scope, depth, st, jd, parentField);
}

/** Output column names of the outermost SELECT (the left-most arm of a set operation). */
function outputNames(select: Obj): string[] {
  let s = select;
  while (s.op && s.op !== 'SETOP_NONE' && s.larg) s = s.larg as Obj;
  return ((s.targetList ?? []) as unknown[]).map((t) => {
    const rt = wrapped(t);
    if (!rt) return '?column?';
    if (typeof rt.body.name === 'string') return rt.body.name;
    const val = wrapped(rt.body.val);
    if (val?.type === 'ColumnRef') {
      const f = (val.body.fields ?? []) as unknown[];
      return strOf(f[f.length - 1]) ?? '?column?';
    }
    if (val?.type === 'FuncCall') return namesOf(val.body.funcname).pop() ?? '?column?';
    if (val?.type === 'TypeCast') {
      const inner = wrapped(val.body.arg);
      if (inner?.type === 'ColumnRef') return strOf(((inner.body.fields ?? []) as unknown[]).slice(-1)[0]) ?? '?column?';
    }
    return '?column?';
  });
}

let refOptions: Promise<unknown> | undefined;
/** The `options` bitmask the real parser gives `DECLARE c NO SCROLL CURSOR FOR select 1`: the wrapper must produce exactly this (no HOLD, no SCROLL, no BINARY). */
const referenceCursorOptions = (): Promise<unknown> =>
  (refOptions ??= pgParse(wrapCursor('select 1')).then((a) => (a as {stmts: {stmt: Obj}[]}).stmts[0].stmt.DeclareCursorStmt.options));

const pickViolation = (set: Set<ExploreErrorCode>): ExploreErrorCode | null => PRIORITY.find((c) => set.has(c)) ?? null;

export type ExploreValidator = (sql: unknown, limits?: Partial<ExploreLimits>) => Promise<ValidateOk | ValidateErr>;

/** Builds a validator. Production uses `validateExploreSql` (all defaults); the options exist only so the mutation checks can break one rule at a time. */
export function createExploreValidator(opts: ValidatorOptions = {}): ExploreValidator {
  const parseFn: ParseFn = opts.parse ?? ((s) => pgParse(s));
  const v = {
    functions: opts.functions ?? EXPLORE_FUNCTIONS,
    deniedFunctions: opts.deniedFunctions ?? EXPLORE_DENIED_FUNCTIONS,
    deniedPrefixes: opts.deniedPrefixes ?? DENIED_PREFIXES,
    nodeTypes: opts.nodeTypes ?? EXPLORE_NODE_TYPES,
    relationAllowed: opts.relationAllowed ?? relationRule(),
    secretName: opts.secretName ?? isSecretName,
  };

  return async function validate(sql: unknown, limitsIn: Partial<ExploreLimits> = {}): Promise<ValidateOk | ValidateErr> {
    const limits: ExploreLimits = {...DEFAULT_EXPLORE_LIMITS, ...limitsIn};
    try {
      // 1. input
      if (typeof sql !== 'string') return err('E_INPUT');
      if (sql.trim() === '') return err('E_EMPTY');
      if (sql.length > limits.maxSqlChars) return err('E_TOO_LONG');
      if (sql.includes('\u0000')) return err('E_NUL_BYTE');
      if (CONTROL_RE.test(sql)) return err('E_CONTROL_CHARS');

      // 2. parse standalone
      let ast: {stmts?: {stmt?: Obj}[]};
      try {
        ast = (await parseFn(sql)) as typeof ast;
      } catch (e) {
        const d = (e as {sqlDetails?: {cursorPosition?: number}}).sqlDetails;
        if (d) return err('E_SYNTAX', typeof d.cursorPosition === 'number' ? d.cursorPosition : undefined);
        throw e;
      }
      const stmts = ast.stmts ?? [];
      if (stmts.length === 0) return err('E_EMPTY');
      if (stmts.length > 1) return err('E_MULTI_STATEMENT');
      const stmt = stmts[0].stmt ?? {};
      const top = wrapped(stmt);
      if (!top || top.type !== 'SelectStmt') return err('E_NOT_SELECT');

      // 3. judge what will be sent (lesson guard-must-judge-what-it-will-use.md)
      const sent = wrapCursor(sql);
      if (!opts.skipWrapperCheck) {
        let wrappedAst: {stmts?: {stmt?: Obj}[]};
        try {
          wrappedAst = (await parseFn(sent)) as typeof wrappedAst;
        } catch (e) {
          if ((e as {sqlDetails?: unknown}).sqlDetails) return err('E_WRAPPER_MISMATCH');
          throw e;
        }
        const ws = wrappedAst.stmts ?? [];
        const d = ws.length === 1 ? wrapped(ws[0].stmt)?.body : undefined;
        const refOptions = await referenceCursorOptions();
        const q = d && wrapped(d.query);
        if (!d || wrapped(ws[0].stmt)?.type !== 'DeclareCursorStmt' || d.portalname !== CURSOR_NAME || d.options !== refOptions || !q || q.type !== 'SelectStmt' ||
          JSON.stringify(stripLoc(d.query)) !== JSON.stringify(stripLoc(stmt))) {
          return err('E_WRAPPER_MISMATCH');
        }
      }

      // 4-10. one generic, default-deny walk
      const st: State = {v, limits, violations: new Set(), relations: [], aliases: new Map(), secretRefs: [], refs: [], viewRefs: 0, ctes: [], functions: [], statusSeen: false, seriesInFrom: new WeakSet(), escapeCalls: new WeakSet(), rowNames: new Set(), bareRefs: [], functionAliases: new WeakSet()};
      walkSelect(top.body, new Set(), 1, st, false);
      // A secret column is refused unless it is a reviewed exception whose table is read by this query (pos_settings.key).
      const bases = st.relations.map(baseRelation);
      const exempt = (c: string): boolean =>
        EXPLORE_SECRET_COLUMN_EXCEPTIONS.some((e) => e.endsWith(`.${c}`) && bases.includes(e.slice(0, e.length - c.length - 1)));
      if (st.secretRefs.some((c) => !exempt(c))) st.violations.add('E_BLOCKED_COLUMN');
      // A whole-row reference turns every column (and any JSON in it) into one text value: refused like *, whatever wraps it.
      if (st.bareRefs.some((r) => st.rowNames.has(r))) st.violations.add('E_SELECT_STAR');
      if (st.viewRefs > limits.maxRelations) st.violations.add('E_TOO_MANY_RELATIONS');
      const outputColumns = outputNames(top.body);
      if (outputColumns.length > limits.maxCols) st.violations.add('E_TOO_MANY_COLUMNS');
      const bad = pickViolation(st.violations);
      if (bad) return err(bad);

      // 11. lints (never fail)
      const lints: ExploreLint[] = [];
      if (st.relations.some((r) => baseRelation(r) === 'pos_orders') && !st.statusSeen) {
        lints.push({code: 'W_NO_STATUS_FILTER', message: 'This query counts voided orders unless you filter status.'});
      }
      const fp = fingerprintStatement(top.body);
      const columnRefs: ValidateOk['columnRefs'] = [];
      for (const r of st.refs) {
        const relation = r.qualifier !== null ? (st.aliases.get(r.qualifier) ?? null) : null;
        if (!columnRefs.some((c) => c.relation === relation && c.column === r.column)) columnRefs.push({relation, column: r.column});
      }
      return {ok: true, sql, sent, relations: st.relations, columnRefs, ctes: st.ctes, functions: st.functions, outputColumns, fingerprint: fp.fingerprint, literalsHash: fp.literalsHash, lints};
    } catch {
      return err('E_WRAPPER_MISMATCH'); // fail closed; the caller logs it as a trip
    }
  };
}

export const validateExploreSql: ExploreValidator = createExploreValidator();
