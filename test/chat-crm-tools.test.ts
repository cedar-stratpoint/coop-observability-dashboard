import {describe, expect, it, vi} from 'vitest';
import {CRM_ERROR_TEXT, createCrmExecutors} from '../src/chat/crm/executors';
import {crmRangeOrders, crmCheckoutsResult, fitBytes, crmCustomersResult, crmMetricsResult, crmOrdersResult, readCheckoutsInput, readCustomersInput, readOrdersInput, safeText, UNTRUSTED_NOTE, type CrmGet} from '../src/chat/crm/tools';
import {CHAT_TOOLS, chatTools} from '../src/chat/tool-defs';
import {createExecutors, statusFor} from '../src/chat/tool-executors';
import {assertRequestShape} from '../src/chat/request-shape';
import type {MetricData, MetricResult} from '../src/chat/result-types';
import {CRM_BODIES, fakeCrmClient} from './support/crm-fixtures';
import {projectOrderChat} from '../src/crm-project';

const NOW = new Date('2026-10-07T04:00:00Z');
const get = (): CrmGet => (e) => fakeCrmClient().client.get(e);
const ORD = {from: '2026-09-28', to: '2026-09-30', financial_status: 'all', group_by: 'none', limit: 10, offset: 0};
const CUS = {joined_from: '', joined_to: '', tier: 'all', buyers: 'all', group_by: 'none', sort: 'spend_desc', limit: 10, offset: 0};
const CHK = {from: '2026-09-28', to: '2026-09-30', stage: 'all', status: 'all', group_by: 'none', limit: 10, offset: 0};
const req = <T>(v: T | {error: string}): T => {
  if (v !== null && typeof v === 'object' && 'error' in v) throw new Error(v.error);
  return v as T;
};
const checks = (r: MetricResult) => r.meta.checks.map((c) => c.text).join('\n');

describe('list_crm_orders', () => {
  it('lists PH-day orders newest first, with totals from code and the untrusted note (Review Focus 2)', async () => {
    const r = await crmOrdersResult(req(readOrdersInput(ORD)), get());
    expect(r.rows).toEqual([
      {order: '#1001', placed: '2026-09-30', email: 'ana@example.com', total: 1000, units: 2, payment: 'paid', fulfillment: 'fulfilled'},
      {order: '#1003', placed: '2026-09-28', email: 'ana@example.com', total: 300, units: 1, payment: 'paid', fulfillment: 'unfulfilled'},
    ]);
    expect(checks(r)).toMatch(/2 orders, ₱1,300 revenue/);
    expect(r.meta.caveats).toContain(UNTRUSTED_NOTE);
    expect(r.metric).toBe('crm_orders');
  });

  it('1 Oct 00:00 PH is October; a status filter applies; no line items means units unknown', async () => {
    const r = await crmOrdersResult(req(readOrdersInput({...ORD, from: '2026-10-01', to: '2026-10-01', financial_status: 'pending'})), get());
    expect(r.rows).toEqual([{order: '#1002', placed: '2026-10-01', email: 'ben@example.com', total: 700.5, units: null, payment: 'pending', fulfillment: 'unfulfilled'}]);
  });

  it('group_by day fills empty days with zero and recomputes AOV per day', async () => {
    const r = await crmOrdersResult(req(readOrdersInput({...ORD, group_by: 'day'})), get());
    expect(r.columns.map((c) => [c.key, c.role])).toEqual([['period', 'time'], ['orders', 'measure'], ['revenue', 'measure'], ['aov', 'measure'], ['units', 'measure']]);
    expect(r.rows).toEqual([
      {period: '2026-09-28', orders: 1, revenue: 300, aov: 300, units: 1},
      {period: '2026-09-29', orders: 0, revenue: 0, aov: null, units: null},
      {period: '2026-09-30', orders: 1, revenue: 1000, aov: 1000, units: 2},
    ]);
  });

  it('pages a list and says how to get the next page (Review Focus 4)', async () => {
    const r = await crmOrdersResult(req(readOrdersInput({...ORD, from: '2026-09-01', to: '2026-10-31', limit: 10, offset: 1})), get());
    expect(r.rows.map((x) => x.order)).toEqual(['#1001', '#1003']);
    expect(checks(r)).toMatch(/Rows 2 to 3 of 3\./);
  });

  it('refuses missing dates, a day grouping over 92 days, a bad limit and any extra parameter', () => {
    expect(readOrdersInput({...ORD, from: ''})).toEqual({error: expect.stringMatching(/Ask the owner/)});
    expect(readOrdersInput({...ORD, from: '2026-01-01', to: '2026-06-30', group_by: 'day'})).toEqual({error: expect.stringMatching(/at most 92 days/)});
    expect(readOrdersInput({...ORD, limit: 7})).toEqual({error: expect.stringMatching(/limit must be one of: 10, 25, 50, 100/)});
    expect(readOrdersInput({...ORD, url: 'https://evil.example'})).toEqual({error: expect.stringMatching(/Use exactly these parameters/)});
    expect(readOrdersInput({...ORD, offset: -1})).toEqual({error: expect.stringMatching(/offset/)});
  });
});

describe('list_crm_customers', () => {
  it('orders and spend come from captured orders (paid only), never Shopify counters; contacts are present (owner decision)', async () => {
    const r = await crmCustomersResult(req(readCustomersInput(CUS)), get(), NOW);
    expect(r.rows[0]).toEqual({name: 'Ana Cruz', email: 'ana@example.com', phone: '+639170000001', tier: 'gold', orders: 2, spent: 1300, spend_ytd: 1300, pet: 'Mochi', pet_birthday: '2020-05-01', email_marketing: 'subscribed', joined: '2026-07-02'});
    expect(r.rows.find((x) => x.name === 'Ben')).toMatchObject({tier: 'guest', orders: 1, spent: 0});
    expect(JSON.stringify(r)).not.toMatch(/SECRET|apiKey|99999/);
    expect(checks(r)).toMatch(/membership year starts 2026-07-01/);
  });

  it('cleans and caps customer-entered text (Review Focus 1)', async () => {
    const r = await crmCustomersResult(req(readCustomersInput(CUS)), get(), NOW);
    const pet = String(r.rows.find((x) => x.name === 'Ben')?.pet);
    expect(pet).not.toMatch(/[\u0000‮]/);
    expect(pet.length).toBeLessThanOrEqual(121);
    expect(pet.endsWith('…')).toBe(true);
    expect(r.meta.caveats).toContain(UNTRUSTED_NOTE);
    expect(safeText('  a\u0007b  ')).toBe('a b');
    expect(safeText('')).toBeNull();
    expect(safeText(5)).toBeNull();
  });

  it('pet_birthday is customer-entered text, so its column is text, not date', async () => {
    const r = await crmCustomersResult(req(readCustomersInput(CUS)), get(), NOW);
    expect(r.columns.find((c) => c.key === 'pet_birthday')?.unit).toBe('text');
  });

  it('filters by tier, buyers and join dates; groups by tier with counts from code', async () => {
    const one = async (over: object) => (await crmCustomersResult(req(readCustomersInput({...CUS, ...over})), get(), NOW)).rows.map((x) => x.name);
    expect(await one({tier: 'guest'})).toEqual(['Ben']);
    expect(await one({buyers: 'non_buyers'})).toEqual(['Cy Lim']);
    expect(await one({joined_from: '2026-09-01', joined_to: '2026-09-30'})).toEqual(['Ben']);
    const g = await crmCustomersResult(req(readCustomersInput({...CUS, group_by: 'tier'})), get(), NOW);
    expect(g.rows).toEqual([{group: 'gold', customers: 1, spent: 1300, orders: 2}, {group: 'guest', customers: 1, spent: 0, orders: 1}, {group: 'platinum', customers: 1, spent: 0, orders: 0}]);
  });

  it('an unreadable membership config falls back and says so', async () => {
    const bodies = {...CRM_BODIES};
    delete bodies.membership; // fakeCrmClient: a missing endpoint is "unreachable"
    const noMembership = fakeCrmClient(bodies).client;
    const r = await crmCustomersResult(req(readCustomersInput(CUS)), (e) => noMembership.get(e), NOW);
    expect(checks(r)).toMatch(/membership settings could not be read/);
    expect(checks(r)).toMatch(/membership year starts 2026-07-01/);
  });
});

describe('list_crm_checkouts', () => {
  it('lists carts with stage and status from code, never the recovery link or raw', async () => {
    const r = await crmCheckoutsResult(req(readCheckoutsInput(CHK)), get());
    expect(r.rows).toEqual([
      {started: '2026-09-29', email: 'eve@example.com', value: 400, stage: 'Payment', status: 'Recovered', reminders: 1, winback: 'sent'},
      {started: '2026-09-29', email: 'dee@example.com', value: 850, stage: 'Shipping', status: 'Active', reminders: 2, winback: 'not sent'},
    ]);
    expect(JSON.stringify(r)).not.toMatch(/SECRET|checkouts\//);
  });
  it('groups by stage, biggest value first', async () => {
    const r = await crmCheckoutsResult(req(readCheckoutsInput({...CHK, from: '2026-09-20', group_by: 'stage'})), get());
    expect(r.rows).toEqual([{group: 'Shipping', carts: 1, value: 850}, {group: 'Payment', carts: 1, value: 400}, {group: 'Started', carts: 1, value: 120}]);
  });
});

describe('get_crm_metrics', () => {
  it('one row of the ten CRM numbers, nothing else', async () => {
    const r = await crmMetricsResult(get(), NOW);
    expect(r.rows).toEqual([{customers: 3, orders: 3, total_revenue: 2000.5, orders_7d: 1, revenue_7d: 700.5, abandoned_active: 2, recovered: 1, reminded: 3, revenue_recovered: 400, recovery_rate: 33.3}]);
    expect(JSON.stringify(r)).not.toMatch(/SECRET/);
    expect(checks(r)).toMatch(/all time/);
  });
});

describe('createCrmExecutors', () => {
  const sink = () => ({info: vi.fn(), error: vi.fn()});
  const lines = (s: ReturnType<typeof sink>) => s.info.mock.calls.map((c) => JSON.parse(c[0] as string)).filter((l) => l.event === 'chat_crm_call');

  it('stores the result through keep and writes one audit line', async () => {
    const s = sink();
    const {client} = fakeCrmClient();
    const ex = createCrmExecutors({client, now: NOW, user: 'o@z.test', sink: s, keep: (r) => ({kept: r.metric})});
    expect(await ex.list_crm_orders(ORD)).toEqual({kept: 'crm_orders'});
    expect(lines(s)).toEqual([{event: 'chat_crm_call', tool: 'list_crm_orders', endpoints: ['orders'], params_fp: expect.stringMatching(/^[0-9a-f]{12}$/), ok: true, code: null, rows: 2, bytes: expect.any(Number), ms: expect.any(Number), user: 'o@z.test'}]);
  });

  it('an unreachable CRM gives the honest text and an audit line with the code (Review Focus 3)', async () => {
    const s = sink();
    const ex = createCrmExecutors({client: fakeCrmClient({}).client, now: NOW, user: null, sink: s, keep: (r) => r});
    expect(await ex.list_crm_orders(ORD)).toEqual({error: CRM_ERROR_TEXT.unreachable});
    expect(lines(s)[0]).toMatchObject({ok: false, code: 'unreachable', endpoints: ['orders']});
  });

  it('caps calls per turn and refuses bad input with zero GETs', async () => {
    const s = sink();
    const f = fakeCrmClient();
    const ex = createCrmExecutors({client: f.client, now: NOW, user: null, sink: s, keep: (r) => r, maxCalls: 1});
    expect(await ex.list_crm_orders({...ORD, method: 'POST'})).toEqual({error: expect.stringMatching(/Use exactly these parameters/)});
    await ex.get_crm_metrics({});
    expect(await ex.get_crm_metrics({})).toEqual({error: CRM_ERROR_TEXT.call_cap});
    expect(f.gets).toEqual(['metrics']);
    expect(lines(s).map((l) => l.code)).toEqual(['input', null, 'call_cap']);
  });

  it('refused calls do not use up the CRM budget, but have their own cap', async () => {
    const s = sink();
    const f = fakeCrmClient();
    const ex = createCrmExecutors({client: f.client, now: NOW, user: null, sink: s, keep: (r) => r, maxCalls: 2, maxRefused: 3});
    const bad = {...ORD, method: 'POST'};
    for (let i = 0; i < 3; i++) expect(await ex.list_crm_orders(bad)).toEqual({error: expect.stringMatching(/Use exactly these parameters/)});
    expect(await ex.list_crm_orders(bad)).toEqual({error: CRM_ERROR_TEXT.refused_cap});
    expect(CRM_ERROR_TEXT.refused_cap).toBe('Too many invalid requests this turn.');
    expect(await ex.get_crm_metrics({})).not.toHaveProperty('error');
    expect(await ex.get_crm_metrics({})).not.toHaveProperty('error');
    expect(await ex.get_crm_metrics({})).toEqual({error: CRM_ERROR_TEXT.call_cap});
    expect(f.gets).toEqual(['metrics', 'metrics']);
  });

  it('fitBytes counts UTF-8 bytes, not UTF-16 units', () => {
    const rows = Array.from({length: 40}, (_, i) => ({n: i, t: '🐶'.repeat(1000)})); // 2 UTF-16 units but 4 bytes each
    const out = fitBytes(rows);
    expect(new TextEncoder().encode(JSON.stringify(out.rows)).length).toBeLessThanOrEqual(65_536);
    expect(out.cut).toBeGreaterThan(0);
  });

  it('a non-CRM error is logged as internal and rethrown (dispatchToolCall reports a generic failure)', async () => {
    const s = sink();
    const client = {get: async () => { throw new TypeError('bug'); }};
    const ex = createCrmExecutors({client, now: NOW, user: null, sink: s, keep: (r) => r});
    await expect(ex.get_crm_metrics({})).rejects.toThrow(TypeError);
    expect(lines(s)[0]).toMatchObject({ok: false, code: 'internal'});
  });
});

describe('wiring', () => {
  const data = (): MetricData => ({source: 'live', orders: [], events: [], prices: [], priceChanges: [], bulkReads: []});

  it('createExecutors adds the four CRM tools only with a client, and stores results as r1, r2', async () => {
    const without = createExecutors({data: async () => data(), now: NOW, user: null});
    expect(Object.keys(without).filter((k) => k.includes('crm'))).toEqual([]);
    const ex = createExecutors({data: async () => data(), now: NOW, user: null, crm: fakeCrmClient().client});
    expect(Object.keys(ex).filter((k) => k.includes('crm')).sort()).toEqual(['get_crm_metrics', 'list_crm_checkouts', 'list_crm_customers', 'list_crm_orders']);
    const r = (await ex.list_crm_orders?.(ORD)) as {id: string; rows: unknown[]};
    expect(r.id).toBe('r1');
    expect(r.rows).toHaveLength(2);
    expect(statusFor('list_crm_orders', ORD)).toBe('Looking up website orders');
  });

  it('chatTools: CRM tools after get_channel_report, run_query after query_metric, set_report_title last, at most 20, all strict with no optionals', () => {
    const t = chatTools({explore: true, crm: true});
    const names = t.map((x) => x.name);
    expect(names.slice(names.indexOf('get_channel_report'), names.indexOf('get_channel_report') + 5)).toEqual(['get_channel_report', 'get_crm_metrics', 'list_crm_orders', 'list_crm_customers', 'list_crm_checkouts']);
    expect(names[names.indexOf('query_metric') + 1]).toBe('run_query');
    expect(names[names.length - 1]).toBe('set_report_title');
    expect(t.length).toBeLessThanOrEqual(20);
    for (const d of t) expect(d.input_schema.required.length).toBe(Object.keys(d.input_schema.properties).length);
    expect(chatTools({explore: false, crm: false})).toEqual(CHAT_TOOLS);
    expect(chatTools({explore: true, crm: true})).toBe(t); // memoised
    expect(() => assertRequestShape({model: 'm', max_tokens: 1, messages: [], tools: t})).not.toThrow();
  });
});

describe('line items never reach the model raw (Task 1 review carry-over)', () => {
  const LEAKY = {
    shopifyOrderId: 9, orderNumber: '#1009', shopifyCustomerId: 'c1', email: 'ana@example.com', totalPrice: '500', currency: 'PHP', financialStatus: 'paid', fulfillmentStatus: null,
    createdAt: '2026-09-29T04:00:00Z', fulfilledAt: null, note: 'SECRET gift note', note_attributes: [{name: 'msg', value: 'SECRET'}],
    lineItems: JSON.stringify([{title: 'Chicken Jerky', quantity: 2, price: '250', sku: 'SECRET-SKU', vendor: 'SECRET-VENDOR', properties: [{name: 'Gift message', value: 'SECRET'}], total_discount: '10.00'}]),
  };
  const bodies = {...CRM_BODIES, orders: {orders: [LEAKY]}};
  const leaky = (): CrmGet => (e) => fakeCrmClient(bodies).client.get(e);

  it('projectOrderChat keeps only {title, quantity, price, discount} per item and no free-text field', () => {
    const o = projectOrderChat(LEAKY);
    expect(o.lineItems).toEqual([{title: 'Chicken Jerky', quantity: 2, price: 250, discount: 10}]);
    expect(JSON.stringify(o)).not.toContain('SECRET');
    expect(projectOrderChat({...LEAKY, lineItems: null}).lineItems).toEqual([]);
    expect(projectOrderChat({...LEAKY, lineItems: 'not json'}).lineItems).toEqual([]);
  });

  it('no tool result carries the SECRET text, in a list, a grouping or the channel rollup input', async () => {
    const list = await crmOrdersResult(req(readOrdersInput({...ORD, from: '2026-09-01', to: '2026-10-31'})), leaky());
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({order: '#1009', units: 2});
    const grouped = await crmOrdersResult(req(readOrdersInput({...ORD, group_by: 'day'})), leaky());
    const cust = await crmCustomersResult(req(readCustomersInput(CUS)), leaky(), NOW);
    const range = await crmRangeOrders(leaky());
    for (const r of [list, grouped, cust, range]) expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(range).toEqual([{createdAt: '2026-09-29T04:00:00Z', totalPrice: '500', lineItems: [{title: 'Chicken Jerky', quantity: 2, price: 250, total_discount: 10}]}]);
  });
});
