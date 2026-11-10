// RET-06 (Stage 6, plan 2026-11-10-customer-code-cohorts-stage6): cohorts by the discount code on a customer's first counted order.
// Owner rules: the key is the first counted order's first code (test orders skipped), upper-cased; "no code" without one; BDAY- codes
// identify one person, so they read "birthday voucher" and the code itself is never kept; BUNDLE- codes collapse to "BUNDLE (auto)".
// Per cohort: buyers, repeat buyers (2+ counted orders) and the rate to one decimal, computed in code; under 5 buyers = a small group.
// One fixture goes through the shared compute (src/crm-compute.ts) and through list_crm_customers. Answers are written by hand first.
import {describe, expect, it} from 'vitest';
import {createCrmExecutors} from '../src/chat/crm/executors';
import {runChatLoop} from '../src/chat/loop';
import {createReportSession} from '../src/chat/report-session';
import {CHAT_TOOLS, CRM_TOOLS} from '../src/chat/tool-defs';
import {createExecutors} from '../src/chat/tool-executors';
import type {ChatBlock} from '../src/chat/block-types';
import {codeCohorts, enrichCustomers, firstOrderCode, SMALL_COHORT} from '../src/crm-compute';
import {projectCustomer, projectOrder, projectOrderChat} from '../src/crm-project';
import {fakeCrmClient} from './support/crm-fixtures';
import {FakeModel, sink, toolTurn, toolUse} from './support/fake-model';

const NOW = new Date('2026-11-10T04:00:00Z');

const cust = (id: string) => ({
  shopifyCustomerId: id, email: `${id}@example.com`, firstName: `F${id}`, lastName: null, phone: null, ordersCount: null, totalSpent: null,
  membershipTier: null, petName: null, petBirthday: null, emailMarketingState: null, createdAt: '2026-05-01T10:00:00+08:00', updatedAt: null,
});
let n = 7000;
const ord = (cid: string, createdAt: string, codes: string[] | null, test = false) => {
  n += 1;
  const raw: Record<string, unknown> = {test};
  if (codes) raw.discount_codes = codes.map((code) => ({code, amount: '300.00', type: 'fixed_amount'}));
  return {
    shopifyOrderId: String(n), shopifyCustomerId: cid, orderNumber: `#${n}`, email: `${cid}@example.com`, totalPrice: '500.00', currency: 'PHP', financialStatus: 'paid',
    fulfillmentStatus: null, lineItems: null, createdAt, fulfilledAt: null, reviewRequestSentAt: null, reviewSubmittedAt: null, raw: JSON.stringify(raw),
  };
};

const BDAY = 'BDAY-SECRETXYZ9';
const CUSTOMERS = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'w1', 'b1', 'u1', 'u2', 'n1', 'n2', 'm1', 'z1'].map(cust);
const ORDERS = [
  // GRAND300: 6 buyers; g1 and g2 come back with another code, which must not move them
  ord('g1', '2026-08-01T10:00:00+08:00', ['grand300']),
  ord('g1', '2026-09-01T10:00:00+08:00', ['WELCOME35']),
  ord('g2', '2026-08-02T10:00:00+08:00', ['GRAND300']),
  ord('g2', '2026-10-02T10:00:00+08:00', ['ZOOMY300']),
  ord('g3', '2026-08-03T10:00:00+08:00', ['GRAND300']),
  ord('g4', '2026-08-04T10:00:00+08:00', ['GRAND300']),
  ord('g5', '2026-08-05T10:00:00+08:00', ['GRAND300']),
  ord('g6', '2026-08-06T10:00:00+08:00', ['GRAND300']),
  // a test order first (GRAND300), then the real first order (WELCOME35): cohort WELCOME35
  ord('w1', '2026-07-01T10:00:00+08:00', ['GRAND300'], true),
  ord('w1', '2026-07-05T10:00:00+08:00', ['welcome35']),
  // a birthday voucher first, then a repeat: "birthday voucher", the code itself never kept
  ord('b1', '2026-06-01T10:00:00+08:00', [BDAY]),
  ord('b1', '2026-07-01T10:00:00+08:00', null),
  // BUNDLE- codes collapse
  ord('u1', '2026-09-01T10:00:00+08:00', ['BUNDLE-AB12']),
  ord('u2', '2026-09-02T10:00:00+08:00', ['bundle-cd34']),
  // no code: an empty list and no key at all
  ord('n1', '2026-09-03T10:00:00+08:00', []),
  ord('n2', '2026-09-04T10:00:00+08:00', null),
  // several codes: the first listed
  ord('m1', '2026-09-05T10:00:00+08:00', ['FAM40', 'WEB50']),
  // z1: no orders, not a buyer, in no cohort
];

// ---------- ANSWERS, by hand ----------
const ANSWER = {
  firstCode: {g1: 'GRAND300', g2: 'GRAND300', g6: 'GRAND300', w1: 'WELCOME35', b1: 'birthday voucher', u1: 'BUNDLE (auto)', u2: 'BUNDLE (auto)', n1: 'no code', n2: 'no code', m1: 'FAM40', z1: null} as Record<string, string | null>,
  // biggest first, ties by name
  cohorts: [
    {group: 'GRAND300', buyers: 6, repeat: 2, ratePct: 33.3, small: false},
    {group: 'BUNDLE (auto)', buyers: 2, repeat: 0, ratePct: 0, small: true},
    {group: 'no code', buyers: 2, repeat: 0, ratePct: 0, small: true},
    {group: 'birthday voucher', buyers: 1, repeat: 1, ratePct: 100, small: true},
    {group: 'FAM40', buyers: 1, repeat: 0, ratePct: 0, small: true},
    {group: 'WELCOME35', buyers: 1, repeat: 0, ratePct: 0, small: true},
  ],
  buyers: 13,
};

const enriched = () => enrichCustomers(CUSTOMERS.map(projectCustomer), ORDERS.map(projectOrder), '2026-01-01');

type Row = Record<string, unknown>;
type R = {rows: Row[]; columns: {key: string; unit: string}[]; meta: {measure: string; chart_view?: {key: string; omit: string[]; note: string | null}; checks: {code: string; status: string; text: string; values?: Record<string, unknown>}[]}; error?: string};
const BODIES = {customers: {customers: CUSTOMERS}, orders: {orders: ORDERS}, membership: {platinumThreshold: 2000, programStart: '2026-07-01'}};
const BASE = {joined_from: '', joined_to: '', tier: 'all', buyers: 'all', group_by: 'first_order_code', sort: 'newest', limit: 100, offset: 0};
async function chat(input: Record<string, unknown> = {}): Promise<R> {
  const f = fakeCrmClient(BODIES as never);
  const ex = createCrmExecutors({client: f.client, now: NOW, user: 'test@example.com', keep: (r) => r, maxCalls: 99, sink: {info: () => undefined, warn: () => undefined, error: () => undefined} as never});
  return (await ex.list_crm_customers({...BASE, ...input})) as R;
}

describe('S6.1 projectOrder carries the discount codes, codes only', () => {
  it('reads raw.discount_codes (string or object raw), upper-cased and trimmed, amounts dropped', () => {
    expect(projectOrder({shopifyOrderId: 1, raw: JSON.stringify({discount_codes: [{code: ' grand300 ', amount: '300', type: 'fixed_amount'}, {code: 'WEB50'}]})}).discountCodes).toEqual(['GRAND300', 'WEB50']);
    expect(projectOrder({shopifyOrderId: 1, raw: {discount_codes: [{code: 'FAM40'}]}}).discountCodes).toEqual(['FAM40']);
    expect(JSON.stringify(projectOrder({shopifyOrderId: 1, raw: {discount_codes: [{code: 'FAM40', amount: '40.00'}]}}))).not.toMatch(/40\.00/);
  });
  it('junk is no code: no raw, bad JSON, a non-array, entries without a string code', () => {
    for (const raw of [undefined, '', 'not json', JSON.stringify({discount_codes: 'GRAND300'}), JSON.stringify({discount_codes: [null, 7, {code: 9}, {code: '  '}]})]) {
      expect(projectOrder({shopifyOrderId: 1, raw}).discountCodes).toEqual([]);
    }
  });
  it('a BDAY- code is reduced to its prefix: the live voucher code is never kept (page or chat)', () => {
    const raw = JSON.stringify({discount_codes: [{code: 'bday-SECRETXYZ9'}]});
    expect(projectOrder({shopifyOrderId: 1, raw}).discountCodes).toEqual(['BDAY-']);
    expect(JSON.stringify(projectOrderChat({shopifyOrderId: 1, raw}))).not.toMatch(/SECRET/);
  });
});

describe('S6.2 firstOrderCode and codeCohorts: the shared core', () => {
  it('the key: first listed code, BDAY masked, BUNDLE collapsed, "no code" without one', () => {
    expect(firstOrderCode(['GRAND300', 'WEB50'])).toBe('GRAND300');
    expect(firstOrderCode([])).toBe('no code');
    expect(firstOrderCode(['BDAY-'])).toBe('birthday voucher');
    expect(firstOrderCode(['BDAY-ABC'])).toBe('birthday voucher');
    expect(firstOrderCode(['BUNDLE-AB12'])).toBe('BUNDLE (auto)');
    expect(firstOrderCode(['zoomy300'])).toBe('ZOOMY300');
  });
  it('a customer belongs to the code of the FIRST counted order, never a later one, and a test order never sets it', () => {
    const got = Object.fromEntries(enriched().map((c) => [c.shopifyCustomerId, c.firstOrderCode]));
    for (const [id, code] of Object.entries(ANSWER.firstCode)) expect([id, got[id]]).toEqual([id, code]);
  });
  it('per cohort: buyers, repeat buyers, rate to one decimal and the small-group flag; buyers sum to all buyers', () => {
    const cohorts = codeCohorts(enriched());
    expect(cohorts).toEqual(ANSWER.cohorts);
    expect(cohorts.reduce((s, c) => s + c.buyers, 0)).toBe(ANSWER.buyers);
    expect(SMALL_COHORT).toBe(5);
  });
  it('orders without discountCodes (hand-built) read as "no code"', () => {
    const e = enrichCustomers([projectCustomer(cust('h1'))], [{shopifyCustomerId: 'h1', email: null, financialStatus: 'paid', totalPrice: '1', createdAt: '2026-01-01T00:00:00Z'}], '2026-01-01');
    expect(e[0].firstOrderCode).toBe('no code');
  });
});

describe('S6.3 list_crm_customers group_by first_order_code', () => {
  it('rows: code, buyers, repeat, rate_pct; parity with the shared compute (the page core)', async () => {
    const r = await chat();
    expect(r.error).toBeUndefined();
    expect(r.columns.map((c) => [c.key, c.unit])).toEqual([['group', 'text'], ['buyers', 'count'], ['repeat', 'count'], ['rate_pct', 'percent']]);
    const page = codeCohorts(enriched()).map((c) => ({group: c.group, buyers: c.buyers, repeat: c.repeat, rate_pct: c.ratePct}));
    expect(r.rows).toEqual(page);
    expect(r.meta.measure).toBe('rate_pct');
  });
  it('a BDAY- code never appears as a cohort name, or anywhere in the result', async () => {
    const r = await chat();
    expect(r.rows.map((x) => x.group)).toContain('birthday voucher');
    expect(JSON.stringify(r)).not.toMatch(/BDAY|SECRET/);
  });
  it('says the 25% is a target, the buyers reconcile, and the small groups are flagged and kept out of the chart', async () => {
    const r = await chat();
    const text = r.meta.checks.map((c) => c.text).join(' ');
    expect(text).toMatch(/Target 25% \(plan target, not an actual\)/);
    expect(r.meta.checks.find((c) => c.code === 'reconciles' && c.values?.buyers === ANSWER.buyers)).toBeDefined();
    const small = r.meta.checks.find((c) => c.code === 'small_sample');
    expect(small?.text).toMatch(/under 5 buyers/);
    expect(r.meta.chart_view?.omit).toEqual(['BUNDLE (auto)', 'no code', 'birthday voucher', 'FAM40', 'WELCOME35']);
    expect(r.meta.chart_view?.note).toMatch(/5 cohorts under 5 buyers/);
  });
  it('non-buyers are in no cohort; filters still apply (min_orders 2 keeps only repeat buyers)', async () => {
    expect((await chat()).rows.map((x) => x.group)).not.toContain('no orders');
    const two = await chat({min_orders: 2});
    expect(two.rows).toEqual([{group: 'GRAND300', buyers: 2, repeat: 2, rate_pct: 100}, {group: 'birthday voucher', buyers: 1, repeat: 1, rate_pct: 100}]);
  });
  it('the grammar stays closed: an unknown group is refused', async () => {
    expect((await chat({group_by: 'event'})).error).toBeDefined();
  });
});

describe('S6.3 the cohort result is drawn as a bar chart by default', () => {
  it('bars of the rate for cohorts of 5+ buyers; every cohort in the table twin', async () => {
    const big = [...CUSTOMERS, ...['k1', 'k2', 'k3', 'k4', 'k5'].map(cust)];
    const more = [...ORDERS, ...['k1', 'k2', 'k3', 'k4', 'k5'].map((id, i) => ord(id, `2026-10-0${i + 1}T10:00:00+08:00`, ['EAST300'])), ord('k1', '2026-10-20T10:00:00+08:00', null)];
    const {client} = fakeCrmClient({customers: {customers: big}, orders: {orders: more}, membership: BODIES.membership} as never);
    const blocks: ChatBlock[] = [];
    const executors = createExecutors({data: async () => ({}) as never, now: NOW, user: null, crm: client, emitBlock: (b) => blocks.push(b), report: createReportSession()});
    const model = new FakeModel((k) => (k === 1 ? toolTurn('', toolUse('a', 'list_crm_customers', BASE)) : {text: ['ok'], stop_reason: 'end_turn'}));
    await runChatLoop({client: model, model: 'fake', maxTokens: 100, effort: 'medium', system: [{type: 'text', text: 'S'}], tools: CHAT_TOOLS, messages: [{role: 'user', content: 'q'}], preamble: '[context]', executors, emit: () => undefined, user: null, sink: sink()});
    expect(blocks).toHaveLength(1);
    const b = blocks[0];
    if (b.kind !== 'chart') throw new Error(`chart expected, got ${b.kind}`);
    expect(b.chart.form).toBe('bar');
    expect(b.chart.rows.map((r) => [r.group, r.rate_pct])).toEqual([['GRAND300', 33.3], ['EAST300', 20]]);
    expect(b.twin.rows).toHaveLength(7);
  });
});

describe('S6.4 the tool says how to route cohort questions and never to guess the event', () => {
  const def = CRM_TOOLS.find((t) => t.name === 'list_crm_customers')!;
  it('names first_order_code for cohort / promo / event questions and asks the owner for the event-to-code mapping', () => {
    expect((def.input_schema as unknown as {properties: {group_by: {enum: string[]}}}).properties.group_by.enum).toContain('first_order_code');
    expect(def.description).toMatch(/first_order_code/);
    expect(def.description).toMatch(/cohort/i);
    expect(def.description).toMatch(/never guess/i);
  });
});
