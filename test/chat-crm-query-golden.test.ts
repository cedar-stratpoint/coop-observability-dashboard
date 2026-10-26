// Scripted golden cases for acceptance questions 1 to 6 and 8 of knowledge/tasks/2026-10-23-crm-flexible-read-and-customer-data-plan.md
// (section 6), against the FAKE CRM: the "model" is the script (it sends the spec a good model would send), everything else is the real
// tool path: validation, allowlist, CRM client contract, shaping, notes, audit. Synthetic data only. Questions 7 and 9 are other pieces.
import {beforeEach, describe, expect, it} from 'vitest';
import type {ChatBlock} from '../src/chat/block-types';
import {createCrmExecutors} from '../src/chat/crm/executors';
import {resetCatalogCache} from '../src/chat/crm/query-catalog';
import type {MetricResult} from '../src/chat/result-types';
import {aggBody, fakeQueryCrm, V2_CATALOG_BODY, type FakeCrmOptions} from './support/fake-crm-query';

const NOW = new Date('2026-10-07T04:00:00Z');
const SEP = [{column: 'created_at', op: 'gte', value: '2026-09-01'}, {column: 'created_at', op: 'lte', value: '2026-09-30'}];
const checks = (r: MetricResult): string => r.meta.checks.map((c) => c.text).join('\n');

function ask(opts: FakeCrmOptions & {identity?: boolean} = {}) {
  const crm = fakeQueryCrm(opts);
  const lines: string[] = [];
  const blocks: ChatBlock[] = [];
  const stored: MetricResult[] = [];
  const ex = createCrmExecutors({
    client: crm.client, now: NOW, user: 'owner@example.test', allowIdentity: opts.identity === true, emitBlock: (b) => blocks.push(b),
    sink: {info: (s: string) => lines.push(s), error: (s: string) => lines.push(s)} as never,
    keep: (r) => (stored.push(r), {id: `r${stored.length}`, rows: r.rows, columns: r.columns, meta: r.meta}),
  });
  return {...crm, ex, lines, blocks, stored, queries: () => crm.calls.filter((c) => c.endpoint === 'query')};
}
beforeEach(() => resetCatalogCache());

const PEOPLE = [
  {customer_ref: 'c1', full_name: 'Ana Persona', email: 'ana.persona@example.com', phone: '09170000001', pet_name: 'Biscuit', pet_birthday: '2022-03-04', membership_tier: 'gold', orders: 3, total_spent: 2400, last_order_skus: 'ZMYFDMEATBEFWHL01'},
  {customer_ref: 'c2', full_name: 'Ben Sample', email: 'ben.sample@example.com', phone: '09170000002', pet_name: 'Mochi', pet_birthday: null, membership_tier: null, orders: 2, total_spent: 900, last_order_skus: 'ZMYFDCHKJERKY01'},
];
const identityBody = (rows: unknown[]) => ({table: 'customers', mode: 'identity', columns: ['customer_ref', 'full_name', 'email', 'phone', 'pet_name', 'pet_birthday', 'membership_tier', 'orders', 'total_spent', 'last_order_skus'].map((name) => ({name, meaning: '', type: ['orders', 'total_spent'].includes(name) ? 'number' : 'text'})), rows, row_count: rows.length, truncated: false, partial: false, next_cursor: null, window: null, notes: [], untrusted_text_fields: ['full_name', 'pet_name'], catalog_version: '2026-10-23.1'});

describe('Q1: repeat buyers in September, and who are they', () => {
  const answer = (s: Record<string, unknown>) => (s.detail === 'identity' ? identityBody(PEOPLE) : aggBody([{name: 'repeat_buyers', agg: 'customers_with_min_orders'}, {name: 'emails', agg: 'count_distinct'}], [{repeat_buyers: 2, emails: 41}]));
  const COUNT = {table: 'orders', filters: SEP, select: [{agg: 'customers_with_min_orders', min: 2, as: 'repeat_buyers'}, {agg: 'count_distinct', column: 'email', as: 'emails'}]};
  const WHO = {table: 'customers', detail: 'identity', filters: [{column: 'orders_count', op: 'gte', value: 2}], order_by: [{by: 'orders_count', dir: 'desc'}], limit: 50};

  it('an allowlisted user gets the count and the people: name, pet, tier, orders, spent, email, phone (at most 50 rows)', async () => {
    const h = ask({answer, identity: true});
    const count = (await h.ex.crm_query(COUNT)) as {rows: {repeat_buyers: number}[]};
    expect(count.rows[0].repeat_buyers).toBe(2);
    const who = (await h.ex.crm_query(WHO)) as {rows: Record<string, unknown>[]};
    expect(who.rows).toHaveLength(2);
    expect(Object.keys(who.rows[0])).toEqual(expect.arrayContaining(['full_name', 'pet_name', 'membership_tier', 'orders', 'total_spent', 'email', 'phone']));
    expect(who.rows.length).toBeLessThanOrEqual(50);
  });
  it('a user who is not allowlisted gets the count only; identity never reaches the CRM', async () => {
    const h = ask({answer, identity: false});
    expect(((await h.ex.crm_query(COUNT)) as {rows: unknown[]}).rows).toHaveLength(1);
    expect(await h.ex.crm_query(WHO)).toMatchObject({error: expect.stringMatching(/not available to this user.*counts and totals only/)});
    expect(h.queries().every((c) => c.spec?.detail !== 'identity')).toBe(true);
  });
});

describe('Q2: discount codes used most in Q3', () => {
  const Q3 = [{column: 'created_at', op: 'between', value: ['2026-07-01', '2026-09-30']}];
  const SELECT = [{agg: 'count', as: 'uses'}, {agg: 'sum', column: 'amount', as: 'given'}];
  it('a quarter is 92 days, over the 90-day window: the refusal says how to go on, then a month-bucketed query passes', async () => {
    const h = ask({answer: () => aggBody([{name: 'code'}, {name: 'created_at_month'}, {name: 'uses', agg: 'count'}, {name: 'given', agg: 'sum', meaning: 'sum of amount'}], [{code: 'WELCOME10', created_at_month: '2026-07', uses: 50, given: 5000}, {code: 'PAWS15', created_at_month: '2026-07', uses: 21, given: 3150}], {notes: ['Birthday vouchers (BDAY-...) are single use and excluded.']})});
    const refused = (await h.ex.crm_query({table: 'order_discount_codes', filters: Q3, select: SELECT, group_by: ['code']})) as {error: string};
    expect(refused.error).toMatch(/at most 90 days.*month/);
    expect(h.queries()).toEqual([]);
    const out = (await h.ex.crm_query({table: 'order_discount_codes', filters: Q3, select: SELECT, group_by: ['code', {column: 'created_at', bucket: 'month'}], order_by: [{by: 'uses', dir: 'desc'}], limit: 10})) as {rows: {code: string}[]};
    expect(out.rows.map((r) => r.code)).toEqual(['WELCOME10', 'PAWS15']);
    expect(JSON.stringify(out.rows)).not.toMatch(/BDAY/);
    expect(checks(h.stored[0])).toMatch(/Birthday vouchers .* excluded/);
    expect(h.stored[0].columns.map((c) => c.role)).toEqual(['category', 'time', 'measure', 'measure']);
  });
});

describe('Q3: abandoned carts last month and what they are worth', () => {
  it('count and value, and the answer is told when the result is partial', async () => {
    const h = ask({answer: () => aggBody([{name: 'carts', agg: 'count'}, {name: 'value', agg: 'sum', meaning: 'sum of total_price'}], [{carts: 212, value: 148_300.5}], {partial: true, notes: ['1 group with fewer than 3 customers was hidden, so totals over these rows are partial.']})});
    await h.ex.crm_query({table: 'checkouts', filters: [...SEP, {column: 'converted_at', op: 'is_null', value: true}], select: [{agg: 'count', as: 'carts'}, {agg: 'sum', column: 'total_price', as: 'value'}]});
    const r = h.stored[0];
    expect(r.rows).toEqual([{carts: 212, value: 148_300.5}]);
    expect(r.columns.map((c) => c.unit)).toEqual(['count', 'PHP']);
    expect(checks(r)).toMatch(/partial yes/);
    expect(r.meta.coverage).toBe('partial');
  });
});

describe('Q4: refund rate per SKU, last 90 days', () => {
  const REFUND = {table: 'order_lines', filters: [{column: 'created_at', op: 'between', value: ['2026-07-09', '2026-10-06']}], select: [{agg: 'sum', column: 'refunded_amount', as: 'refunded'}, {agg: 'sum', column: 'line_gross', as: 'gross'}], group_by: ['sku'], order_by: [{by: 'gross', dir: 'desc'}]};
  const rows = [{sku: 'ZMYFDMEATBEFWHL01', refunded: 300, gross: 12_000}, {sku: null, refunded: 0, gross: 800}];
  it('with a v1 CRM the parts come from aggregates and the model states the formula; a line without a SKU is its own group, not dropped', async () => {
    const h = ask({answer: () => aggBody([{name: 'sku'}, {name: 'refunded', agg: 'sum'}, {name: 'gross', agg: 'sum'}], rows)});
    const out = (await h.ex.crm_query(REFUND)) as {rows: {sku: string}[]};
    expect(out.rows.map((r) => r.sku)).toEqual(['ZMYFDMEATBEFWHL01', '(no value)']);
    expect(h.queries()[0].spec).toMatchObject({table: 'order_lines', group_by: ['sku']});
    expect(await h.ex.crm_query({...REFUND, computed: [{as: 'rate', expr: 'refunded / gross'}]})).toMatchObject({error: expect.stringMatching(/does not offer computed/)});
  });
  it('with a v2 CRM the rate is computed by the CRM from a closed expression', async () => {
    const h = ask({catalog: V2_CATALOG_BODY, answer: () => aggBody([{name: 'sku'}, {name: 'refunded', agg: 'sum'}, {name: 'gross', agg: 'sum'}, {name: 'rate', agg: 'computed', meaning: 'round(refunded / gross, 4)'}], rows.map((r) => ({...r, rate: r.gross ? Math.round((r.refunded / r.gross) * 10_000) / 10_000 : null})))});
    const out = (await h.ex.crm_query({...REFUND, computed: [{as: 'rate', expr: 'round(refunded / gross, 4)'}]})) as {rows: {rate: number}[]};
    expect(out.rows[0].rate).toBe(0.025);
    expect(h.queries()[0].spec?.computed).toEqual([{as: 'rate', expr: 'round(refunded / gross, 4)'}]);
    expect(checks(h.stored[0])).toMatch(/rate: round\(refunded \/ gross, 4\)/); // the definition travels with the answer
  });
});

describe('Q5: weekly units per SKU for the top 5 SKUs since 1 Aug', () => {
  it('top-N per group (v2) gives a chart-ready shape: a week axis, a SKU category and a units measure', async () => {
    const rows = ['A', 'B'].flatMap((s) => ['2026-08-03', '2026-08-10'].map((w, i) => ({sku: `SKU-${s}`, created_at_week: w, units: 10 + i})));
    const h = ask({catalog: V2_CATALOG_BODY, answer: () => aggBody([{name: 'sku'}, {name: 'created_at_week'}, {name: 'units', agg: 'sum'}], rows)});
    const out = (await h.ex.crm_query({table: 'order_lines', filters: [{column: 'created_at', op: 'between', value: ['2026-08-01', '2026-10-06']}], select: [{agg: 'sum', column: 'quantity', as: 'units'}], group_by: ['sku', {column: 'created_at', bucket: 'week'}], top_n: {n: 5, per: 'sku', by: 'units'}, order_by: [{by: 'created_at_week', dir: 'asc'}]})) as {rows: unknown[]};
    expect(out.rows).toHaveLength(4);
    expect(h.stored[0].columns.map((c) => c.role)).toEqual(['category', 'time', 'measure']);
    expect(h.queries()[0].spec?.top_n).toEqual({n: 5, per: 'sku', by: 'units', dir: 'desc'});
  });
  it('a v1 CRM refuses top_n in code with a way forward', async () => {
    const h = ask();
    expect(await h.ex.crm_query({table: 'order_lines', filters: SEP, select: [{agg: 'sum', column: 'quantity', as: 'units'}], group_by: ['sku'], top_n: {n: 5, per: 'sku', by: 'units'}})).toMatchObject({error: expect.stringMatching(/does not offer top-N/)});
    expect(h.queries()).toEqual([]);
  });
});

describe('Q6: everything about one customer (allowlisted only)', () => {
  it('identity by email, then the order history by the opaque customer_ref', async () => {
    const h = ask({identity: true, answer: (s) => (s.detail === 'identity' ? identityBody([PEOPLE[0]]) : {...aggBody([{name: 'order_number'}, {name: 'created_at', type: 'date'}, {name: 'total_price', type: 'number'}], [{order_number: '#1042', created_at: '2026-09-12T03:00:00Z', total_price: 800}]), mode: 'rows'})});
    const who = (await h.ex.crm_query({table: 'customers', detail: 'identity', filters: [{column: 'email', op: 'eq', value: 'ana.persona@example.com'}]})) as {rows: {customer_ref: string; email: string}[]};
    expect(who.rows[0].email).toBe('ana.persona@example.com');
    const hist = (await h.ex.crm_query({table: 'orders', filters: [{column: 'created_at', op: 'between', value: ['2026-07-10', '2026-10-07']}, {column: 'customer_ref', op: 'eq', value: who.rows[0].customer_ref}], select: ['order_number', 'created_at', 'total_price']})) as {rows: unknown[]};
    expect(hist.rows).toHaveLength(1);
    expect(h.lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'chat_pii_read')).toHaveLength(1);
  });
  it('a user who is not allowlisted is refused and nothing is read', async () => {
    const h = ask({identity: false});
    expect(await h.ex.crm_query({table: 'customers', detail: 'identity', filters: [{column: 'email', op: 'eq', value: 'ana.persona@example.com'}]})).toMatchObject({error: expect.stringMatching(/not available/)});
    expect(h.calls).toEqual([]);
  });
});

describe('Q8: malicious requests', () => {
  it.each([
    ['sql as a request', 'select email, phone from customers where 1=1'],
    ['email and phone as columns', {table: 'customers', select: ['email', 'phone']}],
    ['an unknown column', {table: 'orders', filters: SEP, select: ['credit_card']}],
    ['a huge limit', {table: 'orders', filters: SEP, select: ['order_number'], limit: 99_999}],
    ['sql in a name', {table: 'orders', filters: SEP, select: [{agg: 'count', as: "n'); drop table orders; --"}]}],
  ])('%s: refused in code with a clear message, no query sent, nothing leaked', async (_n, input) => {
    const h = ask({identity: false, rows: 3});
    const out = (await h.ex.crm_query(input)) as {error: string};
    expect(out.error.length).toBeGreaterThan(10);
    expect(h.queries()).toEqual([]);
    expect(h.blocks).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(/@example\.com|0917/);
  });
});
