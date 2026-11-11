// RET-00 reconciliation (plan 2026-11-10 B0): the base website-customer questions run through the REAL Ask Coop executors over a fake CRM,
// and every number is checked against an answer written down by hand first. Owner rules (2026-11-09): an order counts in any payment
// status except a test order; spent = paid orders only (test excluded); acquired = PH month of the first order; repeat = 2+ counted
// orders all time; consent null reads "unknown" and is never a filter.
import {describe, expect, it} from 'vitest';
import {createCrmExecutors} from '../src/chat/crm/executors';
import {projectOrder} from '../src/crm-project';
import {fakeCrmClient} from './support/crm-fixtures';
import {REPEAT_TARGET_PCT} from '../src/chat/crm/tools';
import {runChatLoop} from '../src/chat/loop';
import {createReportSession} from '../src/chat/report-session';
import {CHAT_TOOLS} from '../src/chat/tool-defs';
import {createExecutors} from '../src/chat/tool-executors';
import type {ChatBlock} from '../src/chat/block-types';
import {FakeModel, sink, toolTurn, toolUse} from './support/fake-model';

const NOW = new Date('2026-11-10T04:00:00Z'); // PH 2026-11-10 12:00

const cust = (id: string, createdAt: string, emailMarketingState: string | null = null, membershipTier: string | null = null) => ({
  shopifyCustomerId: id, email: `${id}@example.com`, firstName: `F${id}`, lastName: `L${id}`, phone: null, ordersCount: null, totalSpent: null,
  membershipTier, petName: null, petBirthday: null, emailMarketingState, createdAt, updatedAt: createdAt,
});

const CUSTOMERS = [
  cust('c01', '2026-08-01T10:00:00+08:00', 'subscribed'), // no orders
  cust('c02', '2026-08-02T10:00:00+08:00'), // no orders
  cust('c03', '2026-08-03T10:00:00+08:00'), // ONLY a test order: stays a non-buyer
  cust('c04', '2026-10-31T23:00:00+08:00'), // 1 paid, 2026-10-31 23:30 PH (PH October)
  cust('c05', '2026-11-01T00:05:00+08:00'), // 1 paid, 2026-11-01 00:10 PH (PH November, UTC October)
  cust('c06', '2026-09-15T09:00:00+08:00', 'unsubscribed'), // 1 paid
  cust('c07', '2026-09-20T09:00:00+08:00'), // 1 paid + 1 paid TEST: must NOT be a repeat buyer
  cust('c08', '2026-10-10T09:00:00+08:00'), // 1 pending: an order, no spend
  cust('c09', '2026-08-05T09:00:00+08:00'), // paid + VOIDED: 2 orders, spend of the paid one
  cust('c10', '2026-09-01T09:00:00+08:00', null, 'gold'), // 2 paid
  cust('c11', '2026-07-10T09:00:00+08:00'), // paid, refunded, paid TEST (raw as an object)
  cust('c12', '2026-05-01T09:00:00+08:00', null, 'platinum'), // 4 paid + 1 CANCELLED (refunded)
];

let n = 9000;
const ord = (cid: string, createdAt: string, financialStatus: string, totalPrice: string, raw: unknown = JSON.stringify({test: false})) => {
  n += 1;
  return {
    shopifyOrderId: String(n), shopifyCustomerId: cid, orderNumber: `#${n}`, email: `${cid}@example.com`, totalPrice, currency: 'PHP', financialStatus,
    fulfillmentStatus: null, lineItems: JSON.stringify([{title: 'Chicken Jerky', quantity: 1, price: totalPrice}]), createdAt, processedAt: createdAt,
    updatedAt: createdAt, fulfilledAt: null, reviewRequestSentAt: null, reviewSubmittedAt: null, raw,
  };
};
const TEST_RAW_STRING = JSON.stringify({test: true, note: 'SECRET-RAW'});

const ORDERS = [
  ord('c03', '2026-10-20T10:00:00+08:00', 'paid', '999.00', TEST_RAW_STRING),
  ord('c04', '2026-10-31T23:30:00+08:00', 'paid', '500.00'),
  ord('c05', '2026-11-01T00:10:00+08:00', 'paid', '300.00'),
  ord('c06', '2026-09-15T10:00:00+08:00', 'paid', '200.00'),
  ord('c07', '2026-09-20T10:00:00+08:00', 'paid', '100.00'),
  ord('c07', '2026-10-05T10:00:00+08:00', 'paid', '900.00', TEST_RAW_STRING),
  ord('c08', '2026-10-10T10:00:00+08:00', 'pending', '250.00'),
  ord('c09', '2026-08-05T10:00:00+08:00', 'paid', '600.00'),
  ord('c09', '2026-08-20T10:00:00+08:00', 'voided', '600.00'),
  ord('c10', '2026-09-01T10:00:00+08:00', 'paid', '100.00'),
  ord('c10', '2026-10-01T10:00:00+08:00', 'paid', '150.00'),
  ord('c11', '2026-07-10T10:00:00+08:00', 'paid', '100.00'),
  ord('c11', '2026-07-20T10:00:00+08:00', 'refunded', '200.00'),
  ord('c11', '2026-08-10T10:00:00+08:00', 'paid', '300.00', {test: true}),
  ord('c12', '2026-06-01T10:00:00+08:00', 'paid', '100.00'),
  ord('c12', '2026-07-01T10:00:00+08:00', 'paid', '100.00'),
  ord('c12', '2026-08-01T10:00:00+08:00', 'paid', '100.00'),
  ord('c12', '2026-09-01T10:00:00+08:00', 'paid', '100.00'),
  ord('c12', '2026-10-02T10:00:00+08:00', 'refunded', '100.00', JSON.stringify({test: false, cancelled_at: '2026-10-03T10:00:00+08:00'})),
];

// ---------- ANSWERS, written by hand before the code ----------
const ANSWER = {
  customers: 12,
  buyers: ['c04', 'c05', 'c06', 'c07', 'c08', 'c09', 'c10', 'c11', 'c12'],
  nonBuyers: ['c01', 'c02', 'c03'],
  ordersPer: {c01: 0, c02: 0, c03: 0, c04: 1, c05: 1, c06: 1, c07: 1, c08: 1, c09: 2, c10: 2, c11: 2, c12: 5} as Record<string, number>,
  totalOrders: 16,
  spentPer: {c01: 0, c02: 0, c03: 0, c04: 500, c05: 300, c06: 200, c07: 100, c08: 0, c09: 600, c10: 250, c11: 100, c12: 400} as Record<string, number>,
  totalSpent: 2450,
  firstOrder: {c04: '2026-10-31', c05: '2026-11-01', c06: '2026-09-15', c07: '2026-09-20', c08: '2026-10-10', c09: '2026-08-05', c10: '2026-09-01', c11: '2026-07-10', c12: '2026-06-01'} as Record<string, string>,
  lastOrder: {c04: '2026-10-31', c05: '2026-11-01', c06: '2026-09-15', c07: '2026-09-20', c08: '2026-10-10', c09: '2026-08-20', c10: '2026-10-01', c11: '2026-07-20', c12: '2026-10-02'} as Record<string, string>,
  daysSinceLast: {c04: 10, c05: 9, c11: 113} as Record<string, number>,
  newByFirstOrderMonth: [
    {group: '2026-06', customers: 1},
    {group: '2026-07', customers: 1},
    {group: '2026-08', customers: 1},
    {group: '2026-09', customers: 3},
    {group: '2026-10', customers: 2},
    {group: '2026-11', customers: 1},
    {group: 'no orders', customers: 3},
  ],
  repeat: ['c09', 'c10', 'c11', 'c12'],
  ordersBucket: [
    {group: '0', customers: 3, orders: 0},
    {group: '1', customers: 5, orders: 5},
    {group: '2', customers: 3, orders: 6},
    {group: '4+', customers: 1, orders: 5},
  ],
  lastOrderDesc: ['c05', 'c04', 'c08', 'c12', 'c10', 'c07', 'c06', 'c09', 'c11'],
  consent: {unknown: 10, subscribed: 1, unsubscribed: 1} as Record<string, number>,
};

type Row = Record<string, unknown>;
type R = {rows: Row[]; columns: {key: string}[]; meta: {checks: {code: string; status: string; text: string; values?: Record<string, number>}[]}; error?: string};
const BASE = {joined_from: '', joined_to: '', tier: 'all', buyers: 'all', group_by: 'none', sort: 'newest', limit: 100, offset: 0};
const bodies = (orders: unknown[] = ORDERS, customers: unknown[] = CUSTOMERS) => ({customers: {customers}, orders: {orders}, membership: {platinumThreshold: 2000, programStart: '2026-07-01'}});

async function customers(input: Record<string, unknown> = {}, b: Record<string, unknown> = bodies()): Promise<R> {
  const {client} = fakeCrmClient(b as never);
  const ex = createCrmExecutors({client, now: NOW, user: 'test@example.com', keep: (r) => r, maxCalls: 99, sink: {info: () => undefined, warn: () => undefined, error: () => undefined} as never});
  return (await ex.list_crm_customers({...BASE, ...input})) as R;
}
const id = (r: Row): string => String(r.email).slice(0, 3);
const byId = (r: R): Record<string, Row> => Object.fromEntries(r.rows.map((x) => [id(x), x]));
const sum = (r: R, key: string): number => r.rows.reduce((s, x) => s + Number(x[key] ?? 0), 0);

describe('B1: projectOrder carries the test flag from raw, and never raw itself', () => {
  it('reads raw.test from a JSON string or an object; absent or junk is false', () => {
    expect(projectOrder(ORDERS[0]).test).toBe(true);
    expect(projectOrder({shopifyOrderId: 1, raw: {test: true}}).test).toBe(true);
    expect(projectOrder({shopifyOrderId: 1, raw: JSON.stringify({test: false})}).test).toBe(false);
    expect(projectOrder({shopifyOrderId: 1}).test).toBe(false);
    expect(projectOrder({shopifyOrderId: 1, raw: '{not json'}).test).toBe(false);
    expect(projectOrder({shopifyOrderId: 1, raw: {test: 'true'}}).test).toBe(false);
    expect(JSON.stringify(projectOrder(ORDERS[0]))).not.toMatch(/SECRET-RAW|"raw"/);
  });
});

describe('AC1: each base question through the real executors matches the hand-written answer', () => {
  it('total customers, buyers, orders per customer, total orders and total spent', async () => {
    const all = await customers();
    expect(all.rows).toHaveLength(ANSWER.customers);
    const rows = byId(all);
    for (const [c, v] of Object.entries(ANSWER.ordersPer)) expect([c, rows[c].orders]).toEqual([c, v]);
    for (const [c, v] of Object.entries(ANSWER.spentPer)) expect([c, rows[c].spent]).toEqual([c, v]);
    expect(sum(all, 'orders')).toBe(ANSWER.totalOrders);
    expect(sum(all, 'spent')).toBe(ANSWER.totalSpent);
    expect((await customers({buyers: 'buyers'})).rows.map(id).sort()).toEqual(ANSWER.buyers);
    expect((await customers({buyers: 'non_buyers'})).rows.map(id).sort()).toEqual(ANSWER.nonBuyers);
  });

  it('first and last order (PH day) and days since the last order', async () => {
    const rows = byId(await customers());
    for (const [c, d] of Object.entries(ANSWER.firstOrder)) expect([c, rows[c].first_order]).toEqual([c, d]);
    for (const [c, d] of Object.entries(ANSWER.lastOrder)) expect([c, rows[c].last_order]).toEqual([c, d]);
    for (const [c, d] of Object.entries(ANSWER.daysSinceLast)) expect([c, rows[c].days_since_last_order]).toEqual([c, d]);
    for (const c of ANSWER.nonBuyers) expect([rows[c].first_order, rows[c].last_order, rows[c].days_since_last_order]).toEqual([null, null, null]);
  });

  it('new customers per first-order month (PH), non-buyers in their own bucket', async () => {
    const r = await customers({group_by: 'first_order_month'});
    expect(r.rows.map((x) => ({group: x.group, customers: x.customers}))).toEqual(ANSWER.newByFirstOrderMonth);
  });

  it('repeat buyers = min_orders 2, all time; orders per customer as buckets', async () => {
    const repeat = await customers({min_orders: 2});
    expect(repeat.rows.map(id).sort()).toEqual(ANSWER.repeat);
    expect(repeat.meta.checks.find((c) => c.code === 'reconciles')?.values?.customers).toBe(ANSWER.repeat.length);
    const b = await customers({group_by: 'orders_bucket'});
    expect(b.rows.map((x) => ({group: x.group, customers: x.customers, orders: x.orders}))).toEqual(ANSWER.ordersBucket);
  });

  it('sorts by last order, newest or oldest first; customers with no order go last either way', async () => {
    expect((await customers({buyers: 'buyers', sort: 'last_order_desc'})).rows.map(id)).toEqual(ANSWER.lastOrderDesc);
    expect((await customers({buyers: 'buyers', sort: 'last_order_asc'})).rows.map(id)).toEqual([...ANSWER.lastOrderDesc].reverse());
    for (const sort of ['last_order_desc', 'last_order_asc']) {
      const r = await customers({sort});
      expect(r.rows.slice(-3).map(id).sort()).toEqual(ANSWER.nonBuyers);
    }
  });

  it('consent: null reads "unknown", in the list and in the groups', async () => {
    const rows = byId(await customers());
    expect(rows.c02.email_marketing).toBe('unknown');
    expect(rows.c01.email_marketing).toBe('subscribed');
    const g = await customers({group_by: 'email_marketing'});
    expect(Object.fromEntries(g.rows.map((x) => [x.group, x.customers]))).toEqual(ANSWER.consent);
  });

  it('min_orders and the new enums are closed: anything else is refused before any read', async () => {
    for (const bad of [{min_orders: 7}, {min_orders: '2'}, {min_orders: -1}, {group_by: 'first_order_week'}, {sort: 'last_order'}]) {
      expect((await customers(bad)).error).toBeTypeOf('string');
    }
  });
});

describe('AC2: a test order counts toward neither orders nor spend', () => {
  it('never makes a 1-order customer a repeat buyer (c07), and a test-only customer stays a non-buyer (c03)', async () => {
    const rows = byId(await customers());
    expect([rows.c07.orders, rows.c07.spent, rows.c07.last_order]).toEqual([1, 100, '2026-09-20']);
    expect([rows.c03.orders, rows.c03.spent]).toEqual([0, 0]);
    expect([rows.c11.orders, rows.c11.spent, rows.c11.last_order]).toEqual([2, 100, '2026-07-20']);
    const repeat = (await customers({min_orders: 2})).rows.map(id);
    expect(repeat).not.toContain('c07');
  });
});

describe('AC3: voided and cancelled orders count toward orders, not spend', () => {
  it('c09 (voided) and c12 (cancelled, refunded)', async () => {
    const rows = byId(await customers());
    expect([rows.c09.orders, rows.c09.spent]).toEqual([2, 600]);
    expect([rows.c12.orders, rows.c12.spent]).toEqual([5, 400]);
  });
});

describe('AC4: the PH month boundary', () => {
  it('23:30 PH on 31 Oct lands in October; 00:10 PH on 1 Nov (still October in UTC) lands in November', async () => {
    const rows = byId(await customers());
    expect(rows.c04.first_order).toBe('2026-10-31');
    expect(rows.c05.first_order).toBe('2026-11-01');
    const months = await customers({group_by: 'first_order_month', joined_from: '2026-10-31', joined_to: '2026-11-01'});
    expect(months.rows.map((x) => ({group: x.group, customers: x.customers}))).toEqual([{group: '2026-10', customers: 1}, {group: '2026-11', customers: 1}]);
  });
});

describe('AC5: a CRM list read of exactly 1,000 rows warns of partial coverage (the Worker caps silently)', () => {
  const warned = (r: R) => r.meta.checks.some((c) => c.code === 'partial_coverage' && c.status === 'warn' && /1,000/.test(c.text));
  const manyOrders = (k: number) => Array.from({length: k}, (_, i) => ord('c12', '2026-09-01T10:00:00+08:00', 'paid', '1.00', String(i)));
  const manyCustomers = (k: number) => Array.from({length: k}, (_, i) => cust(`x${i}`, '2026-09-01T10:00:00+08:00'));
  it('orders at 1,000 rows warn; 999 do not', async () => {
    expect(warned(await customers({}, bodies(manyOrders(1000))))).toBe(true);
    expect(warned(await customers({}, bodies(manyOrders(999))))).toBe(false);
  });
  it('customers at 1,000 rows warn; the fixture does not', async () => {
    expect(warned(await customers({}, bodies(ORDERS, manyCustomers(1000))))).toBe(true);
    expect(warned(await customers())).toBe(false);
  });
});

// ---------- RET-02 (Stage 2): the repeat buyer rate check and the default charts ----------
// Hand answer on the fixture: buyers = 9 (c04..c12), repeat = 4 (c09, c10, c11, c12), 4 / 9 = 44.4%. The 25% is a plan TARGET.
const repeatCheck = (r: R) => r.meta.checks.find((c) => c.code === 'repeat_rate');

describe('RET-02 AC1: orders_bucket carries a deterministic repeat_rate check', () => {
  it('X of Y buyers, the rate to one decimal, and the 25% labelled as a target', async () => {
    const c = repeatCheck(await customers({group_by: 'orders_bucket'}));
    expect(c?.values).toEqual({repeat: 4, buyers: 9, rate_pct: 44.4, target_pct: 25});
    expect(c?.text).toBe('Repeat buyer rate (owner rule): 4 of 9 buyers (44.4%). Target 25% (plan target, not an actual).');
    expect(REPEAT_TARGET_PCT).toBe(25);
  });
  it('the live case reads "20 of 140 buyers (14.3%)"', async () => {
    const live = [
      ...Array.from({length: 46}, (_, i) => cust(`n${i}`, '2026-08-01T10:00:00+08:00')),
      ...Array.from({length: 140}, (_, i) => cust(`b${i}`, '2026-08-01T10:00:00+08:00')),
    ];
    const orders = Array.from({length: 140}, (_, i) => ord(`b${i}`, '2026-09-01T10:00:00+08:00', 'paid', '100.00'));
    for (let i = 0; i < 20; i += 1) orders.push(ord(`b${i}`, '2026-10-01T10:00:00+08:00', 'paid', '100.00'));
    const c = repeatCheck(await customers({group_by: 'orders_bucket'}, bodies(orders, live)));
    expect(c?.text).toContain('20 of 140 buyers (14.3%)');
  });
  it('no rate when min_orders 2+ already keeps only repeat buyers (it would read 100%)', async () => {
    expect(repeatCheck(await customers({group_by: 'orders_bucket', min_orders: 2}))).toBeUndefined();
  });
  it('only orders_bucket carries it', async () => {
    for (const group_by of ['none', 'first_order_month', 'tier']) expect(repeatCheck(await customers({group_by}))).toBeUndefined();
  });
});

describe('RET-02 AC2: no buyers reads "no buyers", never a divide by zero; the target is never an actual', () => {
  it('non-buyers only: no percentage, rate null', async () => {
    const c = repeatCheck(await customers({group_by: 'orders_bucket', buyers: 'non_buyers'}));
    expect(c?.values).toEqual({repeat: 0, buyers: 0, rate_pct: null, target_pct: 25});
    expect(c?.text).toMatch(/no buyers/);
    expect(c?.text).not.toMatch(/NaN|Infinity|\d%\)/);
    expect(c?.text).toMatch(/Target 25% \(plan target, not an actual\)/);
  });
  it('the 25 appears only as the target, never as the rate', async () => {
    const c = repeatCheck(await customers({group_by: 'orders_bucket'}));
    expect(c?.values?.rate_pct).not.toBe(25);
    expect(c?.text.match(/25%/g)).toHaveLength(1);
    expect(c?.text).toMatch(/Target 25%/);
  });
});

describe('RET-02 AC3: both groupings draw a bar chart by default, without the "no orders" row', () => {
  async function drawn(group_by: string) {
    const {client} = fakeCrmClient(bodies() as never);
    const blocks: ChatBlock[] = [];
    const executors = createExecutors({data: async () => ({source: 'mock', orders: [], events: [], prices: [], priceChanges: [], bulkReads: []}) as never, now: NOW, user: null, crm: client, emitBlock: (b) => blocks.push(b), report: createReportSession()});
    const model = new FakeModel((k) => (k === 1 ? toolTurn('', toolUse('a', 'list_crm_customers', {...BASE, group_by})) : {text: ['Here it is.'], stop_reason: 'end_turn'}));
    await runChatLoop({client: model, model: 'fake', maxTokens: 100, effort: 'medium', system: [{type: 'text', text: 'S'}], tools: CHAT_TOOLS, messages: [{role: 'user', content: 'q'}], preamble: '[context]', executors, emit: () => undefined, user: null, sink: sink()});
    expect(model.requests).toHaveLength(2); // no extra model call
    expect(blocks).toHaveLength(1);
    const b = blocks[0];
    if (b.kind !== 'chart') throw new Error(`chart expected, got ${b.kind}`);
    return b;
  }
  it('orders_bucket: bars of buyers by orders in bucket order, the 0 bucket only in the table twin', async () => {
    const b = await drawn('orders_bucket');
    expect(b.chart.form).toBe('bar');
    expect(b.chart.rows.map((r) => [r.group, r.customers])).toEqual([['1', 5], ['2', 3], ['4+', 1]]);
    expect(b.twin.rows.map((r) => r.group)).toEqual(['0', '1', '2', '4+']);
    expect(b.caveats.join(' ')).toMatch(/no orders \(3\)/);
  });
  it('first_order_month: monthly bars in calendar order, never folded, "no orders" only in the table twin', async () => {
    const b = await drawn('first_order_month');
    expect(b.chart.form).toBe('bar');
    expect(b.chart.folded).toBeNull();
    expect(b.chart.rows.map((r) => r.group)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    expect(b.twin.rows.map((r) => r.group)).toContain('no orders');
  });
  it('a plain list is not auto-drawn as a chart', async () => {
    const {client} = fakeCrmClient(bodies() as never);
    const blocks: ChatBlock[] = [];
    const executors = createExecutors({data: async () => ({}) as never, now: NOW, user: null, crm: client, emitBlock: (b) => blocks.push(b), report: createReportSession()});
    const model = new FakeModel((k) => (k === 1 ? toolTurn('', toolUse('a', 'list_crm_customers', BASE)) : {text: ['ok'], stop_reason: 'end_turn'}));
    await runChatLoop({client: model, model: 'fake', maxTokens: 100, effort: 'medium', system: [{type: 'text', text: 'S'}], tools: CHAT_TOOLS, messages: [{role: 'user', content: 'q'}], preamble: '[context]', executors, emit: () => undefined, user: null, sink: sink()});
    expect(blocks).toHaveLength(0);
  });
});

describe('Test orders are named, so the CRM order total does not look like a contradiction (staging: 58 of 58 test orders)', () => {
  const testCheck = (r: R) => r.meta.checks.find((c) => c.code === 'test_orders');
  it('says how many captured orders are test orders, every grouping', async () => {
    for (const group_by of ['none', 'orders_bucket']) {
      const c = testCheck(await customers({group_by}));
      expect(c?.values).toEqual({test_orders: 3, orders: ORDERS.length});
      expect(c?.text).toMatch(new RegExp(`3 of ${ORDERS.length} captured website orders are Shopify test orders`));
      expect(c?.text).toMatch(/CRM's own order total includes them/);
    }
  });
  it('all orders test: no buyers, and the note explains why', async () => {
    const allTest = ORDERS.map((o) => ({...o, raw: TEST_RAW_STRING}));
    const r = await customers({group_by: 'orders_bucket'}, bodies(allTest));
    expect(repeatCheck(r)?.values?.buyers).toBe(0);
    expect(testCheck(r)?.text).toMatch(`${ORDERS.length} of ${ORDERS.length}`);
  });
  it('no test orders: no note', async () => {
    const real = ORDERS.map((o) => ({...o, raw: JSON.stringify({test: false})}));
    expect(testCheck(await customers({}, bodies(real)))).toBeUndefined();
  });
});
