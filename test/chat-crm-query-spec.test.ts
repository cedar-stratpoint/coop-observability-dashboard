import {describe, expect, it} from 'vitest';
import {FALLBACK_CATALOG, parseCatalog, type Catalog} from '../src/chat/crm/query-catalog';
import {checkExpr, isErr, readQueryInput, type QueryRequest} from '../src/chat/crm/query-spec';
import {CATALOG_BODY, V2_CATALOG_BODY} from './support/fake-crm-query';

const cat = parseCatalog(CATALOG_BODY) as Catalog;
const cat2 = parseCatalog(V2_CATALOG_BODY) as Catalog;
const WIN = [{column: 'created_at', op: 'gte', value: '2026-09-01'}, {column: 'created_at', op: 'lte', value: '2026-09-30'}];
const ok = (input: unknown, c: Catalog = cat, allowIdentity = false): Extract<QueryRequest, {kind: 'query'}> => {
  const r = readQueryInput(input, c, {allowIdentity});
  if (isErr(r)) throw new Error(r.error);
  return r as Extract<QueryRequest, {kind: 'query'}>;
};
const err = (input: unknown, c: Catalog = cat, allowIdentity = false): string => {
  const r = readQueryInput(input, c, {allowIdentity});
  if (!isErr(r)) throw new Error('expected a refusal: ' + JSON.stringify(r));
  return r.error;
};

describe('parseCatalog', () => {
  it('reads the CRM catalog shape and drops anything that is not a plain name', () => {
    expect(cat.version).toBe('2026-10-23.1');
    expect(cat.tables.map((t) => t.name)).toContain('order_lines');
    expect(cat.identity?.cap).toBe(50);
    expect(cat.special).toBe('customers_with_min_orders');
    const evil = parseCatalog({catalog_version: 'x', tables: [{name: 'orders; drop table x', columns: []}, {name: 'ok', columns: [{name: 'a b', type: 'text'}, {name: 'fine', type: 'number', class: 'identity'}]}]});
    expect(evil?.tables.map((t) => t.name)).toEqual(['ok']);
    expect(evil?.tables[0].columns.map((c) => c.name)).toEqual(['fine']);
  });
  it('is null for a body that is not a catalog (the fallback is used)', () => {
    expect(parseCatalog(null)).toBeNull();
    expect(parseCatalog({tables: []})).toBeNull();
    expect(parseCatalog({catalog_version: 'x', tables: []})).toBeNull();
    expect(FALLBACK_CATALOG.tables.map((t) => t.name)).toEqual(['orders', 'order_lines', 'checkouts', 'customers']);
  });
});

describe('readQueryInput: valid shapes', () => {
  it('a grouped aggregate with a bucket and an order', () => {
    const r = ok({table: 'orders', filters: WIN, select: [{agg: 'count', as: 'orders'}, {agg: 'sum', column: 'total_price', as: 'revenue'}], group_by: [{column: 'created_at', bucket: 'week'}], order_by: [{by: 'revenue', dir: 'desc'}]});
    expect(r.aggregate).toBe(true);
    expect(r.spec.group_by).toEqual([{column: 'created_at', bucket: 'week'}]);
    expect(r.columns).toEqual(['created_at_week', 'orders', 'revenue']);
  });
  it('repeat buyers, count_distinct on email and a row list', () => {
    expect(ok({table: 'orders', filters: WIN, select: [{agg: 'customers_with_min_orders', min: 2, as: 'repeat'}, {agg: 'count_distinct', column: 'email', as: 'emails'}]}).aggregate).toBe(true);
    expect(ok({table: 'orders', filters: WIN, select: ['order_number', 'total_price'], limit: 25}).spec.limit).toBe(25);
  });
  it('describe takes only a table', () => {
    expect(readQueryInput({describe: true}, cat, {allowIdentity: false})).toEqual({kind: 'describe', table: null});
    expect(readQueryInput({describe: true, table: 'orders'}, cat, {allowIdentity: false})).toEqual({kind: 'describe', table: 'orders'});
    expect(err({describe: true, table: 'orders', select: ['x']})).toMatch(/only an optional table/);
    expect(err({describe: true, table: 'nope'})).toMatch(/table must be one of/);
  });
});

describe('readQueryInput: refusals (closed shape, catalog ids, caps)', () => {
  it.each([
    ['unknown top key', {table: 'orders', filters: WIN, select: ['order_number'], sql: 'select 1'}, /unknown key/],
    ['unknown table', {table: 'users', select: ['x']}, /table must be one of/],
    ['sql in the table name', {table: 'orders; drop table orders', select: ['x']}, /table must be one of/],
    ['unknown column', {table: 'orders', filters: WIN, select: ['password']}, /not a column/],
    ['sql in a column', {table: 'orders', filters: WIN, select: ['order_number, email from customers --']}, /not a column/],
    ['homoglyph column', {table: 'orders', filters: WIN, select: ['ordеr_number']}, /not a column/],
    ['email row by row', {table: 'orders', filters: WIN, select: ['email']}, /not a column|cannot be returned/],
    ['email sum', {table: 'orders', filters: WIN, select: [{agg: 'sum', column: 'email'}]}, /not allowed|not a column/],
    ['email filter', {table: 'orders', filters: [...WIN, {column: 'email', op: 'eq', value: 'a@example.com'}], select: [{agg: 'count'}]}, /cannot be filtered/],
    ['email group', {table: 'orders', filters: WIN, select: [{agg: 'count'}], group_by: ['email']}, /not a groupable/],
    ['unknown op', {table: 'orders', filters: [...WIN, {column: 'financial_status', op: 'like', value: '%'}], select: [{agg: 'count'}]}, /op must be one of/],
    ['text value too long', {table: 'orders', filters: [...WIN, {column: 'financial_status', op: 'eq', value: 'x'.repeat(101)}], select: [{agg: 'count'}]}, /at most 100/],
    ['control char value', {table: 'orders', filters: [...WIN, {column: 'financial_status', op: 'eq', value: 'a\u0000b'}], select: [{agg: 'count'}]}, /text value/],
    ['bad date', {table: 'orders', filters: [{column: 'created_at', op: 'gte', value: 'yesterday'}, {column: 'created_at', op: 'lte', value: '2026-09-30'}], select: [{agg: 'count'}]}, /YYYY-MM-DD/],
    ['no date window', {table: 'orders', select: [{agg: 'count'}]}, /needs a date window/],
    ['half a window', {table: 'orders', filters: [WIN[0]], select: [{agg: 'count'}]}, /needs a date window/],
    ['window too long', {table: 'orders', filters: [{column: 'created_at', op: 'between', value: ['2026-01-01', '2026-09-30']}], select: [{agg: 'count'}]}, /at most 90 days/],
    ['huge limit', {table: 'orders', filters: WIN, select: ['order_number'], limit: 100000}, /limit is at most 200/],
    ['grouped huge limit', {table: 'orders', filters: WIN, select: [{agg: 'count'}], group_by: ['financial_status'], limit: 501}, /at most 500/],
    ['group without aggregate', {table: 'orders', filters: WIN, select: ['order_number'], group_by: ['financial_status']}, /needs at least one aggregate/],
    ['mixed columns and aggregates', {table: 'orders', filters: WIN, select: ['order_number', {agg: 'count'}]}, /only aggregates/],
    ['rows from an aggregate-only table', {table: 'customers', select: ['orders_count']}, /aggregate-only|cannot be returned/],
    ['order by something not output', {table: 'orders', filters: WIN, select: [{agg: 'count', as: 'n'}], order_by: [{by: 'email'}]}, /must be one of the names/],
    ['bad cursor', {table: 'orders', filters: WIN, select: ['order_number'], cursor: 'x; drop'}, /cursor/],
    ['cursor on an aggregate', {table: 'orders', filters: WIN, select: [{agg: 'count'}], group_by: ['financial_status'], cursor: 'abc'}, /row-level/],
    ['duplicate output names', {table: 'orders', filters: WIN, select: [{agg: 'count', as: 'n'}, {agg: 'sum', column: 'total_price', as: 'n'}]}, /used twice/],
    ['as with sql', {table: 'orders', filters: WIN, select: [{agg: 'count', as: 'n); drop'}]}, /short lowercase name/],
    ['unknown select key', {table: 'orders', filters: WIN, select: [{agg: 'count', raw: '1'}]}, /unknown key/],
    ['too many selects', {table: 'orders', filters: WIN, select: Array.from({length: 13}, () => 'order_number')}, /at most 12/],
    ['a giant filter list', {table: 'orders', filters: Array.from({length: 13}, () => WIN[0]), select: [{agg: 'count'}]}, /at most 12/],
    ['in with too many values', {table: 'orders', filters: [...WIN, {column: 'financial_status', op: 'in', value: Array.from({length: 51}, () => 'a')}], select: [{agg: 'count'}]}, /1 to 50/],
    ['detail something else', {table: 'customers', detail: 'all'}, /can only be "identity"/],
    ['deliver all on an aggregate', {table: 'orders', filters: WIN, select: [{agg: 'count'}], deliver: 'all'}, /row lists/],
    ['tz made up', {table: 'orders', filters: WIN, select: [{agg: 'count'}], tz: 'Mars/Base'}, /tz must be one of/],
    ['not an object', 'select * from customers', /Use only these parameters/],
    ['array', [], /Use only these parameters/],
  ])('refuses %s', (_n, input, re) => {
    expect(err(input)).toMatch(re);
  });
  it('refuses a spec over the character cap', () => {
    const many = {table: 'orders', filters: [...WIN, {column: 'financial_status', op: 'in', value: Array.from({length: 50}, (_, i) => `status_${i}_${'x'.repeat(40)}`)}], select: [{agg: 'count'}]};
    expect(err(many)).toMatch(/too long/);
  });
});

describe('identity detail', () => {
  const IDQ = {table: 'customers', detail: 'identity', filters: [{column: 'orders_count', op: 'gte', value: 2}], order_by: [{by: 'total_spent'}], limit: 50};
  it('is refused for a user who is not allowed, even before the catalog matters', () => {
    expect(err(IDQ, cat, false)).toMatch(/not available to this user/);
  });
  it('is allowed for an allowlisted user, only on customers, capped at 50 to the model, with no select or group_by', () => {
    const r = ok(IDQ, cat, true);
    expect(r.identity).toBe(true);
    expect(r.spec.detail).toBe('identity');
    expect(err({...IDQ, limit: 51}, cat, true)).toMatch(/at most 50/);
    expect(ok({...IDQ, limit: 500, deliver: 'all'}, cat, true).spec.limit).toBe(50);
    expect(err({...IDQ, table: 'orders'}, cat, true)).toMatch(/customers table only/);
    expect(err({...IDQ, select: ['email']}, cat, true)).toMatch(/fixed set of fields/);
    expect(err({...IDQ, group_by: ['membership_tier']}, cat, true)).toMatch(/fixed set of fields/);
    expect(err({...IDQ, filters: [{column: 'phone', op: 'eq', value: '0917'}]}, cat, true)).toMatch(/not available/);
    expect(err({...IDQ, order_by: [{by: 'email'}]}, cat, true)).toMatch(/order_by/);
  });
  it('an identity filter on the stored email works (look one person up)', () => {
    expect(ok({table: 'customers', detail: 'identity', filters: [{column: 'email', op: 'eq', value: 'ana.lim@example.com'}]}, cat, true).spec.filters).toEqual([{column: 'email', op: 'eq', value: 'ana.lim@example.com'}]);
  });
});

describe('v2 keys: closed, and refused unless the catalog offers them', () => {
  const base = {table: 'order_lines', filters: WIN, select: [{agg: 'sum', column: 'quantity', as: 'units'}, {agg: 'sum', column: 'line_gross', as: 'gross'}, {agg: 'sum', column: 'refunded_amount', as: 'refunded'}], group_by: ['sku']};
  it('v1 catalog: joins, computed, having and top_n are refused with a clear message', () => {
    expect(err({...base, computed: [{as: 'rate', expr: 'refunded / gross'}]})).toMatch(/does not offer computed/);
    expect(err({...base, having: [{by: 'units', op: 'gte', value: 5}]})).toMatch(/does not offer HAVING/);
    expect(err({...base, top_n: {n: 5, per: 'sku', by: 'units'}})).toMatch(/does not offer top-N/);
    expect(err({...base, joins: ['order_lines']})).toMatch(/does not offer joins/);
  });
  it('v2 catalog: computed, having and top_n pass and travel in canonical form', () => {
    const r = ok({...base, computed: [{as: 'rate', expr: 'round(refunded / gross, 4)'}], having: [{by: 'units', op: 'gte', value: 5}], top_n: {n: 5, per: 'sku', by: 'units'}, order_by: [{by: 'rate'}]}, cat2);
    expect(r.spec.computed).toEqual([{as: 'rate', expr: 'round(refunded / gross, 4)'}]);
    expect(r.spec.having).toEqual([{by: 'units', op: 'gte', value: 5}]);
    expect(r.spec.top_n).toEqual({n: 5, per: 'sku', by: 'units', dir: 'desc'});
  });
  it('v2 catalog still refuses bad v2 input', () => {
    expect(err({...base, computed: [{as: 'rate', expr: 'refunded / secret'}]}, cat2)).toMatch(/not a column or a name/);
    expect(err({...base, computed: [{as: 'rate', expr: 'refunded; drop table x'}]}, cat2)).toMatch(/unexpected/);
    expect(err({...base, computed: [{as: 'units', expr: '1'}]}, cat2)).toMatch(/new short lowercase name/);
    expect(err({...base, having: [{by: 'email', op: 'gte', value: 1}]}, cat2)).toMatch(/must be one of the names/);
    expect(err({...base, top_n: {n: 500, per: 'sku', by: 'units'}}, cat2)).toMatch(/1 to 50/);
    expect(err({...base, top_n: {n: 5, per: 'sku', by: 'units', x: 1}}, cat2)).toMatch(/unknown key/);
    expect(err({...base, joins: ['customers']}, cat2)).toMatch(/joins item must be one of/);
  });
});

describe('checkExpr: the tiny grammar', () => {
  const names = new Set(['a', 'b', 'gross']);
  it.each(['a + b', 'a / b', '(a + b) * 2', 'round(a / b, 4)', 'round((a - b) / gross, 2) * 100', '12.5'])('accepts %s', (e) => {
    expect(checkExpr(e, names)).toBeNull();
  });
  it.each(['a ^ b', 'a; b', "a' or '1", 'sqrt(a)', 'a b', 'round(a)', 'round(a, 9)', '((((((((a))))))))', 'c + a', '', 'a +', '(a', 'a - - b x'])('refuses %j', (e) => {
    expect(checkExpr(e, names)).not.toBeNull();
  });
  it('refuses a long expression', () => {
    expect(checkExpr('a+'.repeat(100) + 'a', names)).toMatch(/at most/);
  });
});
