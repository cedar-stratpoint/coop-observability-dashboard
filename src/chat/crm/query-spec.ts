// Validation of the model's `crm_query` input against the CRM query catalog, in code, BEFORE any request (the closed()/oneOf() pattern of
// tools.ts). Every identifier must be an exact catalog id, every value passes a strict check, caps are enforced, and identity detail is
// refused unless the caller is allowlisted. A refusal is a plain MetricError the model can correct; nothing here reads the network. Pure.
// The spec sent on is REBUILT from validated parts, so nothing the model typed outside the closed shape can travel. The CRM re-validates all
// of it and stays the final authority. The key names are the CRM's real ones (zoomy-crm docs/api-query.md): `joins: ["customers"]`, computed select
// items `{expr: node, as}`, `having`, `top_n: {n, by, dir, key | per}`; test/chat-crm-query-contract.test.ts pins them against the CRM's own accept/refuse verdicts.
import type {MetricError} from '../result-types';
import {AGGS, BUCKETS, columnOf, OPS, TZS, tableOf, type CatColumn, type CatTable, type Catalog} from './query-catalog';
import {QUERY_LIMITS as L} from './query-config';

export const IDENTITY_TABLE = 'customers';
export const DELIVER = ['sample', 'all'] as const;

type Scalar = string | number;
export interface WireSpec {
  table: string;
  select: unknown[];
  filters: {column: string; op: string; value?: Scalar | Scalar[] | boolean}[];
  group_by: unknown[];
  order_by: {by: string; dir: 'asc' | 'desc'}[];
  limit?: number;
  cursor?: string;
  tz?: string;
  detail?: 'identity';
  joins?: string[];
  having?: {by: string; op: string; value: number | [number, number]}[];
  top_n?: {n: number; by: string; dir: 'asc' | 'desc'; key?: string; per?: string};
}
/** The CRM's closed expression grammar: a number, {ref}, or {op, args}. */
export type ExprNode = number | {ref: string} | {op: '+' | '-' | '*' | '/' | 'round'; args: ExprNode[]};
export type QueryRequest =
  | {kind: 'describe'; table: string | null}
  | {kind: 'query'; spec: WireSpec; identity: boolean; deliver: (typeof DELIVER)[number]; aggregate: boolean; columns: string[]};

const fail = (error: string): MetricError => ({error});
export const isErr = (v: unknown): v is MetricError => v !== null && typeof v === 'object' && !Array.isArray(v) && typeof (v as {error?: unknown}).error === 'string';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const NAME = /^[a-z][a-z0-9_]{0,40}$/;
const QNAME = /^[a-z][a-z0-9_]{0,40}(\.[a-z][a-z0-9_]{0,40})?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2064\ufeff]/;
const CURSOR = new RegExp(`^[A-Za-z0-9_-]{1,${L.maxCursorChars}}$`);
const show = (v: unknown): string => String(typeof v === 'string' ? v.slice(0, 40) : typeof v).replace(CONTROL, ' ');

/** Rejects a key outside `allowed`; returns an error text or null. */
function closedKeys(o: Record<string, unknown>, allowed: readonly string[], where: string): string | null {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  return extra.length ? `${where}: unknown key ${extra.slice(0, 3).map(show).join(', ')}. Use only: ${allowed.join(', ')}.` : null;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], where: string): T | MetricError {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fail(`${where} must be one of: ${allowed.join(', ')}.`);
}
const list = (v: unknown, max: number, where: string): unknown[] | MetricError => (v === undefined ? [] : Array.isArray(v) && v.length <= max ? v : fail(`${where} must be a list of at most ${max}.`));

function scalar(v: unknown, type: CatColumn['type'], where: string): Scalar | MetricError {
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v) ? v : fail(`${where}: a number is required.`);
  if (typeof v !== 'string' || v.length > L.maxText || CONTROL.test(v)) return fail(`${where}: a text value of at most ${L.maxText} characters is required.`);
  if (type === 'date' && !(DAY.test(v) && realDay(v))) return fail(`${where}: dates are real days as YYYY-MM-DD.`);
  return v;
}

/** A filter value in the right shape for its op. */
function filterValue(op: string, raw: unknown, type: CatColumn['type'], where: string): Scalar | Scalar[] | boolean | undefined | MetricError {
  if (op === 'is_null') return raw === undefined ? undefined : typeof raw === 'boolean' ? raw : fail(`${where}: value is true or false.`);
  if (op === 'in') {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > L.maxIn) return fail(`${where}: value is a list of 1 to ${L.maxIn}.`);
    const out: Scalar[] = [];
    for (const x of raw) {
      const s = scalar(x, type, where);
      if (isErr(s)) return s;
      out.push(s);
    }
    return out;
  }
  if (op === 'between') {
    if (!Array.isArray(raw) || raw.length !== 2) return fail(`${where}: value is [low, high].`);
    const a = scalar(raw[0], type, where);
    const b = scalar(raw[1], type, where);
    return isErr(a) ? a : isErr(b) ? b : [a, b];
  }
  return scalar(raw, type, where);
}

/** Days between two YYYY-MM-DD strings, inclusive; null when either is not a real date. */
function inclusiveDays(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) + 1 : null;
}

/** A real calendar day (the CRM refuses 2026-02-31). */
const realDay = (v: string): boolean => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

const EXPR_OPS = ['+', '-', '*', '/', 'round'] as const;
/** The CRM's computed-column grammar, rebuilt node by node (nothing else travels): a finite number, {ref}, or {op, args}. Depth and node count as the CRM counts them. */
function parseNode(v: unknown, depth: number, count: {n: number}, scope: ReadonlySet<string>, refs: string[]): ExprNode | MetricError {
  count.n += 1;
  if (count.n > L.maxExprNodes) return fail(`expr has at most ${L.maxExprNodes} nodes.`);
  if (depth > L.maxExprDepth) return fail(`expr is nested at most ${L.maxExprDepth} deep.`);
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) <= L.maxExprLiteral ? v : fail(`expr numbers are finite and at most ${L.maxExprLiteral} in size.`);
  if (!isObj(v)) return fail('expr nodes are a number, {ref}, or {op, args}.');
  if ('ref' in v) {
    const e = closedKeys(v, ['ref'], 'expr ref');
    if (e) return fail(e);
    if (typeof v.ref !== 'string' || !NAME.test(v.ref)) return fail('expr ref is the name of an aggregate in this select.');
    if (!scope.has(v.ref)) return fail(`expr: "${show(v.ref)}" is not an aggregate of this select (aggregates or earlier computed items only).`);
    refs.push(v.ref);
    return {ref: v.ref};
  }
  const e = closedKeys(v, ['op', 'args'], 'expr node');
  if (e) return fail(e);
  if (typeof v.op !== 'string' || !(EXPR_OPS as readonly string[]).includes(v.op)) return fail(`expr op is one of ${EXPR_OPS.join(' ')}.`);
  if (!Array.isArray(v.args)) return fail('expr args is a list.');
  const op = v.op as (typeof EXPR_OPS)[number];
  if (op === 'round') {
    if (v.args.length < 1 || v.args.length > 2) return fail('round takes [value] or [value, digits].');
    const x = parseNode(v.args[0], depth + 1, count, scope, refs);
    if (isErr(x)) return x;
    const args: ExprNode[] = [x];
    if (v.args.length === 2) {
      const d = v.args[1];
      if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > L.roundDigits) return fail(`round digits is a whole number from 0 to ${L.roundDigits}.`);
      count.n += 1;
      args.push(d);
    }
    return {op, args};
  }
  if (v.args.length !== 2) return fail(`${op} takes exactly two arguments.`);
  const a = parseNode(v.args[0], depth + 1, count, scope, refs);
  if (isErr(a)) return a;
  const b = parseNode(v.args[1], depth + 1, count, scope, refs);
  if (isErr(b)) return b;
  return {op, args: [a, b]};
}

const TOP = ['table', 'select', 'filters', 'group_by', 'order_by', 'limit', 'cursor', 'tz', 'detail', 'deliver', 'describe', 'joins', 'having', 'top_n'] as const;

function identitySpec(o: Record<string, unknown>, cat: Catalog, wire: WireSpec): WireSpec | MetricError {
  const id = cat.identity;
  if (!id) return fail('Identity detail is not offered by this CRM.');
  if ((o.select !== undefined && !(Array.isArray(o.select) && o.select.length === 0)) || (o.group_by !== undefined && !(Array.isArray(o.group_by) && o.group_by.length === 0))) return fail(`detail "identity" returns a fixed set of fields (${id.fields.join(', ')}); do not pass select or group_by.`);
  for (const k of ['joins', 'having', 'top_n']) if (o[k] !== undefined) return fail(`${k} does not apply to detail "identity".`);
  const filters = list(o.filters, L.maxFilters, 'filters');
  if (isErr(filters)) return filters;
  for (const f of filters) {
    if (!isObj(f)) return fail('filters items are {column, op, value}.');
    const e = closedKeys(f, ['column', 'op', 'value'], 'filter');
    if (e) return fail(e);
    const ops = typeof f.column === 'string' && Object.hasOwn(id.filters, f.column) ? id.filters[f.column] : null;
    if (!ops) return fail(`identity filter: "${show(f.column)}" is not available. Use: ${Object.keys(id.filters).join(', ')}.`);
    const op = oneOf(f.op, ops, `identity filter ${f.column} op`);
    if (isErr(op)) return op;
    const type = f.column === 'orders_count' || f.column === 'total_spent' ? 'number' : f.column === 'created_at' ? 'date' : 'text';
    const value = filterValue(op, f.value, type, `identity filter ${f.column}`);
    if (isErr(value)) return value;
    wire.filters.push({column: f.column as string, op, ...(value === undefined ? {} : {value})});
  }
  const order = list(o.order_by, L.maxOrderBy, 'order_by');
  if (isErr(order)) return order;
  for (const x of order) {
    if (!isObj(x)) return fail('order_by items are {by, dir}.');
    const e = closedKeys(x, ['by', 'dir'], 'order_by item');
    if (e) return fail(e);
    const by = oneOf(x.by, id.orderBy, 'identity order_by.by');
    if (isErr(by)) return by;
    const dir = x.dir === undefined ? 'desc' : oneOf(x.dir, ['asc', 'desc'] as const, 'order_by.dir');
    if (isErr(dir)) return dir;
    wire.order_by.push({by, dir});
  }
  wire.detail = 'identity';
  return wire;
}

/** Validate and normalise one `crm_query` input. `allowIdentity` is the EXPLORE_ALLOWED_EMAILS decision, made by the route. */
export function readQueryInput(input: unknown, cat: Catalog, opts: {allowIdentity: boolean}): QueryRequest | MetricError {
  if (!isObj(input)) return fail(`Use only these parameters: ${TOP.join(', ')}.`);
  const top = closedKeys(input, TOP, 'crm_query');
  if (top) return fail(top);
  if (input.describe !== undefined) {
    if (input.describe !== true) return fail('describe is true, with an optional table.');
    const only = Object.keys(input).filter((k) => k !== 'describe' && k !== 'table');
    if (only.length) return fail('describe takes only an optional table.');
    if (input.table !== undefined && (typeof input.table !== 'string' || !tableOf(cat, input.table))) return fail(`table must be one of: ${cat.tables.map((t) => t.name).join(', ')}.`);
    return {kind: 'describe', table: (input.table as string | undefined) ?? null};
  }
  const tname = oneOf(input.table, cat.tables.map((t) => t.name), 'table');
  if (isErr(tname)) return tname;
  const table = tableOf(cat, tname) as CatTable;
  const identity = input.detail === 'identity';
  if (input.detail !== undefined && !identity) return fail('detail can only be "identity".');
  if (identity && !opts.allowIdentity) return fail('Names, pet names, email and phone are not available to this user. Answer with counts and totals only, and say so.');
  if (identity && table.name !== IDENTITY_TABLE) return fail(`detail "identity" works on the ${IDENTITY_TABLE} table only.`);
  const deliver = input.deliver === undefined ? 'sample' : oneOf(input.deliver, DELIVER, 'deliver');
  if (isErr(deliver)) return deliver;
  const tz = input.tz === undefined ? undefined : oneOf(input.tz, TZS, 'tz');
  if (isErr(tz)) return tz;
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || !CURSOR.test(input.cursor))) return fail('cursor is the next_cursor of the previous result, unchanged.');
  if (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1)) return fail('limit must be a whole number of at least 1.');
  const wire: WireSpec = {table: table.name, select: [], filters: [], group_by: [], order_by: [], ...(tz ? {tz} : {})};

  if (identity) {
    const spec = identitySpec(input, cat, wire);
    if (isErr(spec)) return spec;
    const cap = cat.identity?.cap ?? L.modelIdentity;
    if (typeof input.limit === 'number') {
      if (deliver === 'sample' && input.limit > Math.min(cap, L.modelIdentity)) return fail(`limit is at most ${Math.min(cap, L.modelIdentity)} for detail "identity". For a longer list set deliver "all": the owner gets the full table.`);
      spec.limit = Math.min(input.limit, cap);
    }
    if (typeof input.cursor === 'string') {
      if (spec.order_by.length) return fail('A cursor uses the default order (most orders first): do not pass order_by.');
      spec.cursor = input.cursor;
    }
    if (deliver === 'all' && spec.order_by.length) return fail('deliver "all" pages in the default order (most orders first): do not pass order_by, or leave deliver out for up to 50 rows in your order.');
    return {kind: 'query', spec, identity: true, deliver, aggregate: false, columns: [...(cat.identity?.fields ?? [])]};
  }

  const v2 = cat.features;
  // declared joins
  const joinsIn = list(input.joins, L.maxJoins, 'joins');
  if (isErr(joinsIn)) return joinsIn;
  if (joinsIn.length && !table.joins.length) return fail(`${table.name} has no declared joins. Query one table, or use order_lines for per-SKU questions.`);
  const joins: string[] = [];
  for (const j of joinsIn) {
    const name = oneOf(j, table.joins, `${table.name} can join`);
    if (isErr(name)) return name;
    joins.push(name);
  }
  const colOf = (name: unknown): {col: CatColumn; table: CatTable; id: string} | null => {
    if (typeof name !== 'string' || !QNAME.test(name)) return null;
    const [a, b] = name.split('.');
    if (b === undefined) {
      const c = columnOf(table, a);
      return c ? {col: c, table, id: name} : null;
    }
    const jt = joins.includes(a) ? tableOf(cat, a) : null;
    const c = jt ? columnOf(jt, b) : null;
    return jt && c ? {col: c, table: jt, id: name} : null;
  };

  const selectIn = list(input.select, L.maxSelect, 'select');
  if (isErr(selectIn)) return selectIn;
  const groupIn = list(input.group_by, L.maxGroupBy, 'group_by');
  if (isErr(groupIn)) return groupIn;
  const outNames: string[] = [];
  const aggNames = new Set<string>(); // plain aggregates: what a computed item and top_n.by may use
  const calcItems: {at: number; item: Record<string, unknown>}[] = [];
  const taken = (n: string): boolean => outNames.includes(n);

  const groups: unknown[] = [];
  const groupNames: string[] = [];
  for (const g of groupIn) {
    let column: unknown;
    let bucket: unknown;
    let as: unknown;
    if (typeof g === 'string') column = g;
    else if (isObj(g)) {
      const e = closedKeys(g, ['column', 'bucket', 'as'], 'group_by item');
      if (e) return fail(e);
      ({column, bucket, as} = g);
    } else return fail('group_by items are a column name or {column, bucket}.');
    const c = colOf(column);
    if (!c || !c.col.group || c.col.distinctOnly) return fail(`group_by: "${show(column)}" is not a groupable column of ${table.name}.`);
    if (bucket !== undefined) {
      if (c.col.type !== 'date') return fail('group_by: bucket applies to date columns only.');
      const b = oneOf(bucket, BUCKETS, 'group_by bucket');
      if (isErr(b)) return b;
    }
    if (as !== undefined && (typeof as !== 'string' || !NAME.test(as))) return fail('group_by: "as" must be a short lowercase name (a-z, 0-9, _).');
    const name = (as as string | undefined) ?? (bucket !== undefined ? `${c.id.replace('.', '_')}_${bucket}` : c.id.replace('.', '_'));
    if (taken(name)) return fail(`Output name "${name}" is used twice. Use "as".`);
    outNames.push(name);
    groupNames.push(name);
    groups.push(bucket === undefined && as === undefined ? c.id : {column: c.id, ...(bucket === undefined ? {} : {bucket}), ...(as === undefined ? {} : {as})});
  }

  const selects: unknown[] = [];
  let special = 0;
  let aggCount = 0;
  const rowCols: string[] = [];
  for (const s of selectIn) {
    if (typeof s === 'string') {
      const c = colOf(s);
      if (!c) return fail(`select: "${show(s)}" is not a column of ${table.name} (use describe to list them).`);
      rowCols.push(s);
      selects.push(s);
      if (taken(c.id)) return fail(`Output name "${c.id}" is used twice.`);
      outNames.push(c.id);
    } else if (isObj(s)) {
      const e = closedKeys(s, ['agg', 'column', 'as', 'min', 'expr'], 'select item');
      if (e) return fail(e);
      if (s.as !== undefined && (typeof s.as !== 'string' || !NAME.test(s.as))) return fail('select: "as" must be a short lowercase name (a-z, 0-9, _).');
      let name: string;
      if (s.expr !== undefined) {
        // a computed item {expr, as}: parsed after the loop, because it may use any aggregate of this select
        if (s.agg !== undefined || s.column !== undefined || s.min !== undefined) return fail('select: a computed item is {expr, as} only.');
        if (typeof s.as !== 'string') return fail('select: a computed item needs "as".');
        if (!cat.features.computed) return fail('This CRM does not offer computed columns. Ask for the parts and say the formula; do not compute it yourself.');
        calcItems.push({at: selects.length, item: s});
        selects.push(null);
        name = s.as;
      } else if (cat.special && s.agg === cat.special) {
        if (typeof s.min !== 'number' || !Number.isInteger(s.min) || s.min < 2 || s.min > L.minOrdersMax) return fail(`${cat.special}: min is a whole number from 2 to ${L.minOrdersMax}.`);
        if (s.column !== undefined) return fail(`${cat.special} takes no column.`);
        special += 1;
        name = (s.as as string | undefined) ?? `customers_with_${s.min}_orders`;
        selects.push({agg: s.agg, min: s.min, ...(s.as === undefined ? {} : {as: s.as})});
      } else {
        const agg = oneOf(s.agg, [...AGGS, ...(cat.special ? [cat.special] : [])], 'select agg');
        if (isErr(agg)) return agg;
        if (s.min !== undefined) return fail('select: min applies to the repeat-buyers aggregate only.');
        let cname: string | null = null;
        if (s.column !== undefined) {
          const c = colOf(s.column);
          if (!c) return fail(`select: "${show(s.column)}" is not a column of ${table.name}.`);
          if (!c.col.aggs.includes(agg)) return fail(`select: ${agg} is not allowed on ${table.name}.${c.id}${c.col.distinctOnly ? ' (email is count_distinct only)' : ''}. Allowed: ${c.col.aggs.join(', ') || 'none'}.`);
          cname = c.id;
        } else if (agg !== 'count') return fail(`select: ${agg} needs a column.`);
        name = (s.as as string | undefined) ?? (cname ? `${agg}_${cname.replace('.', '_')}` : agg);
        selects.push({agg, ...(cname ? {column: cname} : {}), ...(s.as === undefined ? {} : {as: s.as})});
        aggNames.add(name);
      }
      if (taken(name)) return fail(`Output name "${name}" is used twice. Use "as".`);
      outNames.push(name);
      aggCount += 1;
    } else return fail('select items are a column name or {agg, column, as}.');
  }
  if (selects.length === 0) return fail(`select must list 1 to ${L.maxSelect} columns or aggregates.`);
  // computed items: over the aggregates of this select and earlier computed items, at least one aggregate each
  const scope = new Set(aggNames);
  const calcNames = new Set<string>();
  for (const {at, item} of calcItems) {
    const refs: string[] = [];
    const node = parseNode(item.expr, 1, {n: 0}, scope, refs);
    if (isErr(node)) return node;
    if (!refs.length) return fail(`expr ${item.as}: it must use at least one aggregate of this select.`);
    selects[at] = {expr: node, as: item.as};
    scope.add(item.as as string);
    calcNames.add(item.as as string);
  }
  const aggregate = aggCount > 0 || groups.length > 0;
  if (groups.length && aggCount === 0) return fail('group_by needs at least one aggregate in select.');
  if (aggregate && rowCols.length) return fail('With aggregates or group_by, select only aggregates: the group keys are returned automatically.');
  if (special && (groups.length || special > 1)) return fail(`${cat.special} is used once and without group_by.`);
  if (special && (calcItems.length || input.having !== undefined || input.top_n !== undefined)) return fail(`${cat.special} cannot be combined with computed items, having or top_n.`);
  if (!aggregate) {
    if (!table.rowLevel) return fail(`${table.name} is aggregate-only: ask for counts or sums (select an aggregate), not rows. Names and contact details need detail "identity".`);
    for (const s of rowCols) if (!colOf(s)?.col.select) return fail(`select: ${s} cannot be returned row by row. ${colOf(s)?.col.group ? 'Group by it with an aggregate instead.' : ''}`.trim());
  }

  // having (v2): only on aggregate or computed names of this select, numbers only
  const havIn = list(input.having, L.maxHaving, 'having');
  if (isErr(havIn)) return havIn;
  if (havIn.length && !cat.features.having) return fail('This CRM does not offer HAVING. Rank with order_by and limit instead.');
  if (havIn.length && !aggregate) return fail('having works with aggregates.');
  const having: NonNullable<WireSpec['having']> = [];
  for (const h of havIn) {
    if (!isObj(h)) return fail('having items are {by, op, value}.');
    const e = closedKeys(h, ['by', 'op', 'value'], 'having item');
    if (e) return fail(e);
    if (typeof h.by !== 'string' || !(aggNames.has(h.by) || calcNames.has(h.by))) return fail('having.by must be an aggregate or computed name of this select.');
    const op = oneOf(h.op, ['eq', 'gte', 'lte', 'between'] as const, 'having op');
    if (isErr(op)) return op;
    const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    if (op === 'between') {
      if (!Array.isArray(h.value) || h.value.length !== 2 || !num(h.value[0]) || !num(h.value[1])) return fail('having between takes [low, high] numbers.');
      having.push({by: h.by, op, value: [h.value[0], h.value[1]]});
    } else {
      if (!num(h.value)) return fail('having value is a number.');
      having.push({by: h.by, op, value: h.value});
    }
  }

  // top-N (v2): `key` keeps the n best values of one group key over the whole filtered set, `per` the n best rows inside each value of it
  let topN: WireSpec['top_n'];
  if (input.top_n !== undefined) {
    if (!cat.features.topN) return fail('This CRM does not offer top-N. Ask for the groups, then rank them.');
    if (!isObj(input.top_n)) return fail('top_n is {n, by, dir, key | per}.');
    const t = input.top_n;
    const e = closedKeys(t, ['n', 'by', 'dir', 'key', 'per'], 'top_n');
    if (e) return fail(e);
    if (groups.length < 2) return fail('top_n needs at least two group_by keys (for a single key use order_by and limit).');
    if (typeof t.n !== 'number' || !Number.isInteger(t.n) || t.n < 1 || t.n > L.maxTopN) return fail(`top_n.n is a whole number from 1 to ${L.maxTopN}.`);
    if ((t.key === undefined) === (t.per === undefined)) return fail('top_n takes exactly one of key or per.');
    const mode = t.key !== undefined ? 'key' : 'per';
    const gname = mode === 'key' ? t.key : t.per;
    if (typeof gname !== 'string' || !groupNames.includes(gname)) return fail(`top_n.${mode} must be one of the group_by names: ${groupNames.join(', ')}.`);
    if (typeof t.by !== 'string' || !aggNames.has(t.by)) return fail('top_n.by must be a plain aggregate name of this select.');
    const dir = t.dir === undefined ? 'desc' : oneOf(t.dir, ['asc', 'desc'] as const, 'top_n.dir');
    if (isErr(dir)) return dir;
    topN = {n: t.n, by: t.by, dir, [mode]: gname};
  }

  // filters
  const filtersIn = list(input.filters, L.maxFilters, 'filters');
  if (isErr(filtersIn)) return filtersIn;
  for (const f of filtersIn) {
    if (!isObj(f)) return fail('filters items are {column, op, value}.');
    const e = closedKeys(f, ['column', 'op', 'value'], 'filter');
    if (e) return fail(e);
    const c = colOf(f.column);
    if (!c || c.col.distinctOnly || c.col.filter.length === 0) return fail(`filter: "${show(f.column)}" cannot be filtered on in ${table.name}.`);
    const op = oneOf(f.op, c.col.filter.filter((x) => (OPS as readonly string[]).includes(x)), `filter ${c.id} op`);
    if (isErr(op)) return op;
    const value = filterValue(op, f.value, c.col.type, `filter ${c.id} ${op}`);
    if (isErr(value)) return value;
    wire.filters.push({column: c.id, op, ...(value === undefined ? {} : {value})});
  }

  // order_by: only names the query outputs
  const orderIn = list(input.order_by, L.maxOrderBy, 'order_by');
  if (isErr(orderIn)) return orderIn;
  for (const x of orderIn) {
    if (!isObj(x)) return fail('order_by items are {by, dir}.');
    const e = closedKeys(x, ['by', 'dir'], 'order_by item');
    if (e) return fail(e);
    if (typeof x.by !== 'string' || !outNames.includes(x.by)) return fail(`order_by.by must be one of the names this query returns: ${outNames.join(', ')}.`);
    const dir = x.dir === undefined ? 'desc' : oneOf(x.dir, ['asc', 'desc'] as const, 'order_by.dir');
    if (isErr(dir)) return dir;
    wire.order_by.push({by: x.by, dir});
  }

  // the date window the table needs
  if (table.windowCol) {
    let from: string | null = null;
    let to: string | null = null;
    for (const f of wire.filters) {
      if (f.column !== table.windowCol) continue;
      const v = f.value;
      const lo = f.op === 'gte' || f.op === 'eq' ? (v as string) : f.op === 'between' ? (v as string[])[0] : null;
      const hi = f.op === 'lte' || f.op === 'eq' ? (v as string) : f.op === 'between' ? (v as string[])[1] : null;
      if (lo && (!from || lo > from)) from = lo;
      if (hi && (!to || hi < to)) to = hi;
    }
    if (!from || !to) return fail(`${table.name} needs a date window: filter ${table.windowCol} with gte and lte (or between) as YYYY-MM-DD. Ask the owner for dates if they gave none.`);
    const days = inclusiveDays(from, to);
    if (days === null || days < 1) return fail(`The date window ${show(from)} to ${show(to)} is not valid.`);
    const monthly = groups.some((g) => isObj(g) && g.bucket === 'month');
    const max = monthly ? L.crmMonthWindowDays : table.maxWindowDays ?? L.crmWindowDays;
    if (days > max) return fail(`The date window is at most ${max} days${monthly ? '' : ` (group by month allows up to ${L.crmMonthWindowDays})`}; yours is ${days}. Split it or group by month.`);
  }

  // limit and cursor. With a cursor the CRM pages by keyset (default order only, page cap 500, no 64 KB cap); a sample for the model stays within the rows it is shown
  const paged = typeof input.cursor === 'string';
  if (paged && aggregate) return fail('cursor works on row-level queries only.');
  if ((paged || deliver === 'all') && wire.order_by.length) return fail('A cursor and deliver "all" use the default order (newest first): do not pass order_by.');
  const cap = aggregate ? cat.groupedCap : paged ? cat.pagedCap : cat.rowCap;
  if (typeof input.limit === 'number') {
    if (input.limit > cap && !(deliver === 'all' && !aggregate)) return fail(`limit is at most ${cap} for this kind of query.${aggregate ? '' : ' For everything set deliver "all": the owner gets the full table.'}`);
    wire.limit = Math.min(input.limit, cap, deliver === 'all' ? cap : cat.rowCap); // a sample page asks for no more than the model is shown, so next_cursor never skips rows
  } else if (paged && deliver !== 'all') wire.limit = cat.rowCap;
  if (paged) wire.cursor = input.cursor as string;
  if (deliver === 'all' && aggregate) return fail('deliver "all" is for row lists. Aggregates return every group already (up to the cap).');
  wire.select = selects;
  wire.group_by = groups;
  if (joins.length) wire.joins = joins;
  if (having.length) wire.having = having;
  if (topN) wire.top_n = topN;
  if (JSON.stringify(wire).length > L.maxSpecChars) return fail(`The query is too long (at most ${L.maxSpecChars} characters). Ask for less at once.`);
  return {kind: 'query', spec: wire, identity: false, deliver, aggregate, columns: outNames};
}
