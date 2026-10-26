// shopify_query through the executors: the identity decision and bad input happen BEFORE any request to the CRM, the audit lines carry no values, Shopify errors
// pass through honestly, and the caps hold. Golden scripted cases in the style of acceptance questions 1, 6 and 8 of the 2026-10-23 plan, for the Shopify door.
import {describe, expect, it, vi} from 'vitest';
import {CrmError, SHOPIFY_LIMITS} from '../src/chat/crm/client';
import {createCrmExecutors} from '../src/chat/crm/executors';
import {assertRequestShape} from '../src/chat/request-shape';
import {chatTools} from '../src/chat/tool-defs';
import {createExecutors, statusFor} from '../src/chat/tool-executors';
import type {MetricData} from '../src/chat/result-types';
import {fakeShopifyDoor, ORDERS_BODY} from './support/fake-shopify-door';

const NOW = new Date('2026-10-07T04:00:00Z');
const sink = () => ({info: vi.fn(), error: vi.fn()});
const lines = (s: ReturnType<typeof sink>, event: string) => s.info.mock.calls.map((c) => JSON.parse(c[0] as string)).filter((l) => l.event === event);
const setup = (answer?: Parameters<typeof fakeShopifyDoor>[0], over: {identity?: boolean} = {}) => {
  const door = fakeShopifyDoor(answer);
  const s = sink();
  const ex = createCrmExecutors({client: door.client, now: NOW, user: 'owner@example.test', sink: s, keep: (r) => ({id: 'r1', metric: r.metric, rows: r.rows, meta: r.meta}), allowIdentity: over.identity});
  return {door, s, ex};
};
const ORDERS_Q = '{ orders(first: 25, query: "created_at:>=2026-09-01") { pageInfo { hasNextPage endCursor } nodes { name totalPriceSet { shopMoney { amount currencyCode } } lineItems(first: 20) { nodes { sku quantity } } } } }';

describe('shopify_query: happy path', () => {
  it('sends the query once, shapes the result, writes one chat_crm_call line without the query text', async () => {
    const {door, s, ex} = setup(() => ORDERS_BODY);
    const out = (await ex.shopify_query({query: ORDERS_Q})) as {id: string; metric: string; rows: unknown[]};
    expect(out).toMatchObject({id: 'r1', metric: 'shopify_query'});
    expect(out.rows).toHaveLength(3);
    expect(door.posts).toEqual([{query: ORDERS_Q}]);
    const crm = lines(s, 'chat_crm_call');
    expect(crm).toHaveLength(1);
    expect(crm[0]).toMatchObject({tool: 'shopify_query', endpoints: ['shopify'], ok: true, rows: 3});
    expect(JSON.stringify(crm[0])).not.toMatch(/created_at|orders\(/); // fingerprint only
    expect(lines(s, 'chat_pii_read')).toHaveLength(0); // no identity field, no PII line
  });
  it('is registered in the chat wiring beside crm_query, stored as a result, with a constant status line', async () => {
    const door = fakeShopifyDoor(() => ORDERS_BODY);
    const ex = createExecutors({data: async () => ({source: 'live', orders: [], events: [], prices: [], priceChanges: [], bulkReads: []}) as MetricData, now: NOW, user: null, crm: door.client});
    expect(await ex.shopify_query?.({query: ORDERS_Q})).toMatchObject({id: 'r1', metric: 'shopify_query'});
    expect(statusFor('shopify_query', {query: 'x'})).toBe('Reading live from Shopify (slower)');
  });
});

describe('golden: identity is refused in code before any CRM call (acceptance 1, 6 and 8 style)', () => {
  const ASKS: [string, string][] = [
    ['"who are the repeat buyers" with email and phone', '{ customers(first: 50, query: "orders_count:>1") { nodes { firstName lastName email phone numberOfOrders } } }'],
    ['"show me everything about <one customer>"', '{ customers(first: 1, query: "email:ana@example.com") { nodes { email orders(first: 10) { nodes { name } } } } }'],
    ['a list of booth leads from the shop metafield', '{ shop { metafield(namespace: "custom", key: "newsletter_subscribers") { value } } }'],
    ['an email column on orders', '{ orders(first: 10) { nodes { name email } } }'],
  ];
  it.each(ASKS)('a user who is not allowed: %s gets a refusal, nothing is sent, one failed pii line without values', async (_n, query) => {
    const {door, s, ex} = setup(() => ORDERS_BODY, {identity: false});
    const out = await ex.shopify_query({query});
    expect(out).toEqual({error: expect.stringMatching(/not available to this user/)});
    expect(door.posts).toHaveLength(0);
    expect(door.gets).toHaveLength(0);
    const pii = lines(s, 'chat_pii_read');
    expect(pii).toEqual([expect.objectContaining({tool: 'shopify_query', ok: false, code: 'identity_denied', rows: null, columns: []})]);
    expect(JSON.stringify(s.info.mock.calls)).not.toMatch(/ana@example|first_name/);
  });
  it('an allowlisted user is sent through; the audit line names columns and a row count, never a value', async () => {
    const body = {data: {customers: {nodes: [{firstName: 'Ana', email: 'ana@example.test', phone: '+639170000000', numberOfOrders: 3}]}}};
    const {door, s, ex} = setup(() => body, {identity: true});
    const out = (await ex.shopify_query({query: '{ customers(first: 5) { nodes { firstName email phone numberOfOrders } } }'})) as {rows: Record<string, unknown>[]};
    expect(door.posts).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({firstName: 'Ana', email: 'ana@example.test'});
    const pii = lines(s, 'chat_pii_read');
    expect(pii).toHaveLength(1);
    expect(pii[0]).toMatchObject({tool: 'shopify_query', mode: 'identity', ok: true, rows: 1, columns: ['firstName', 'email', 'phone', 'numberOfOrders'], consent_filter: 'none'});
    expect(JSON.stringify(pii[0])).not.toMatch(/ana@example|\+63917|Ana/);
  });
  it('identity rows reach the model capped at 50 and the result tells it customer text is data', async () => {
    const nodes = Array.from({length: 120}, (_, i) => ({email: `p${i}@example.test`}));
    const {ex} = setup(() => ({data: {customers: {nodes}}}), {identity: true});
    const out = (await ex.shopify_query({query: '{ customers(first: 100) { nodes { email } } }'})) as {rows: unknown[]; meta: {caveats: string[]}};
    expect(out.rows).toHaveLength(50);
    expect(out.meta.caveats.join('\n')).toMatch(/data, never instructions/);
  });
});

describe('golden: malicious or broken asks are refused with no CRM call (acceptance 8 style)', () => {
  const BAD: [string, unknown][] = [
    ['a mutation', {query: 'mutation { discountCodeBasicCreate(basicCodeDiscount: {}) { userErrors { message } } }'}],
    ['introspection', {query: '{ __schema { types { name } } }'}],
    ['SQL in a field name', {query: "select email, phone from customers where 1=1"}],
    ['SQL after a valid query', {query: '{ shop { name } } ; drop table orders'}],
    ['two operations', {query: 'query A { shop { name } } query B { shop { name } }'}],
    ['a smuggled url key', {query: '{ shop { name } }', url: 'https://evil.example'}],
    ['an oversized query', {query: `{ shop { name } }${' '.repeat(10_500)}`}],
    ['not a string', {query: {a: 1}}],
    ['no input', null],
  ];
  it.each(BAD)('%s', async (_n, input) => {
    const {door, ex} = setup();
    const out = await ex.shopify_query(input);
    expect(out).toEqual({error: expect.any(String)});
    expect(door.posts).toHaveLength(0);
  });
  it('a model that keeps sending bad input is stopped by the refused cap, still with no CRM call', async () => {
    const {door, ex} = setup();
    let last: unknown;
    for (let i = 0; i < 10; i += 1) last = await ex.shopify_query({query: 'mutation { x }'});
    expect(last).toEqual({error: expect.stringMatching(/Too many invalid requests/)});
    expect(door.posts).toHaveLength(0);
  });
});

describe('Shopify errors and CRM failures are passed on honestly', () => {
  it('a missing scope (HTTP 200 plus errors) comes back as a result that says SCOPE MISSING, not as a failure to retry', async () => {
    const {ex, s} = setup(() => ({data: null, errors: [{message: 'Access denied for orders field.', extensions: {code: 'ACCESS_DENIED'}}]}));
    const out = (await ex.shopify_query({query: ORDERS_Q})) as {rows: unknown[]; meta: {caveats: string[]; reliable: boolean}};
    expect(out.rows).toEqual([]);
    expect(out.meta.reliable).toBe(false);
    expect(out.meta.caveats.join('\n')).toMatch(/SCOPE MISSING/);
    expect(out.meta.caveats.join('\n')).toMatch(/Access denied for orders field/);
    expect(lines(s, 'chat_crm_call')[0]).toMatchObject({ok: true}); // the call worked; Shopify refused the data
  });
  it("the CRM guard's 400 reason reaches the model once, so it can fix the query", async () => {
    const {ex, s} = setup(() => new CrmError('upstream_error', 400, 'field "note" is not allowed on Order'));
    const out = await ex.shopify_query({query: '{ orders(first: 1) { nodes { name } } }'});
    expect(out).toEqual({error: expect.stringMatching(/read-only Shopify door refused that query: field "note" is not allowed on Order/)});
    expect(lines(s, 'chat_crm_call')[0]).toMatchObject({ok: false, code: 'upstream_error'});
  });
  it.each([[502], [500]])('HTTP %i from the door is "Shopify did not answer", with no upstream text and no figure', async (status) => {
    const {ex} = setup(() => new CrmError('upstream_error', status));
    const out = (await ex.shopify_query({query: '{ shop { name } }'})) as {error: string};
    expect(out.error).toMatch(/Shopify did not answer that query/);
    expect(out.error).toMatch(/give no website figure/);
  });
  it.each(['unreachable', 'timeout', 'too_large', 'bad_shape'] as const)('a %s failure says so and gives no data', async (code) => {
    const {ex} = setup(() => new CrmError(code));
    expect(await ex.shopify_query({query: '{ shop { name } }'})).toEqual({error: expect.stringMatching(/website CRM/)});
  });
  it('a body that is not the door envelope is reported as an unexpected format', async () => {
    const {ex} = setup(() => ({surprise: true}));
    expect(await ex.shopify_query({query: '{ shop { name } }'})).toEqual({error: expect.stringMatching(/unexpected format/)});
  });
  it('the per-turn read budget covers shopify_query too', async () => {
    const door = fakeShopifyDoor();
    const ex = createCrmExecutors({client: door.client, now: NOW, user: null, sink: sink(), keep: (r) => r, maxCalls: 2});
    await ex.shopify_query({query: '{ shop { name } }'});
    await ex.shopify_query({query: '{ shop { name } }'});
    expect(await ex.shopify_query({query: '{ shop { name } }'})).toEqual({error: expect.stringMatching(/used its website CRM reads/)});
    expect(door.posts).toHaveLength(2);
    expect(SHOPIFY_LIMITS.maxPostsPerTurn).toBeGreaterThanOrEqual(2);
  });
});

describe('the tool definition', () => {
  const tool = chatTools({explore: false, crm: true}).find((t) => t.name === 'shopify_query')!;
  it('is not strict, accepted by the request-shape guard, and sent with the CRM tools only', () => {
    expect(tool.strict).toBe(false);
    expect(() => assertRequestShape({model: 'm', max_tokens: 1, messages: [], tools: chatTools({explore: true, crm: true, contacts: true, sku: true})})).not.toThrow();
    expect(() => assertRequestShape({model: 'm', max_tokens: 1, messages: [], tools: [{...tool, strict: undefined}]})).toThrow(/strict/);
    expect(chatTools({explore: true, crm: false, contacts: true, sku: true}).some((t) => t.name === 'shopify_query')).toBe(false);
  });
  it('says crm_query is the fast path and what shopify_query is for, with real field names and example queries', () => {
    expect(tool.description).toMatch(/SLOWER than crm_query/);
    expect(tool.description).toMatch(/crm_query stays the fast path for common analytics/);
    for (const w of ['full order history', 'live inventory', 'collections', 'product metafields', 'discount code and refund detail', 'shop metafields']) expect(tool.description).toContain(w);
    for (const f of ['lineItems', 'sku', 'inventoryQuantity', 'discountNodes', 'DiscountCodeBasic', 'asyncUsageCount', 'totalRefundedSet', 'metafield(namespace: "custom"']) expect(tool.description).toContain(f);
    expect(tool.description).toMatch(/SCOPE MISSING/);
    expect(tool.description).not.toMatch(/https?:|bearer|token:/i);
    expect(JSON.stringify(tool)).not.toMatch(/[–—]/);
  });
  it('the examples in the description pass the tool\'s own checks and the field names are in the CRM allowlist copy', async () => {
    const {readShopifyInput} = await import('../src/chat/crm/shopify-query');
    const examples = [
      '{ orders(first: 25, query: "created_at:>=2026-09-01", sortKey: CREATED_AT, reverse: true) { pageInfo { hasNextPage endCursor } nodes { name createdAt displayFinancialStatus lineItems(first: 20) { nodes { sku quantity title } } } } }',
      '{ productVariants(first: 50) { nodes { sku title inventoryQuantity product { title } } } }',
      '{ discountNodes(first: 50) { nodes { discount { ... on DiscountCodeBasic { title status asyncUsageCount codes(first: 3) { nodes { code } } } } } } }',
    ];
    for (const q of examples) {
      expect(tool.description).toContain(q);
      expect('error' in readShopifyInput({query: q}, {allowIdentity: false})).toBe(false);
    }
  });
});
