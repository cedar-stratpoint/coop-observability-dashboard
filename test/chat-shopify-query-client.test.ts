// The ONE POST the CRM client has: a GraphQL query to /api/shopify/query. It is not a generic POST: one constant path, a body of {query, variables} only,
// the read token, no redirect, no other endpoint reachable with it. Fake fetch only.
import {describe, expect, it} from 'vitest';
import {CRM_ENDPOINTS, CrmError, SHOPIFY_LIMITS, SHOPIFY_POST_PATH, createCrmClient, type CrmEndpointId} from '../src/chat/crm/client';

const calls: {url: string; init: RequestInit}[] = [];
const make = (respond: () => Response = () => new Response(JSON.stringify({data: {shop: {name: 'T'}}}), {status: 200})) => {
  calls.length = 0;
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({url: String(input), init});
    return respond();
  }) as typeof globalThis.fetch;
  return createCrmClient({baseUrl: 'https://crm.example/worker', token: 'tok-SECRET', fetch});
};
const Q = '{ shop { name } }';

describe('postShopify', () => {
  it('POSTs exactly {query, variables} to the one path with the read token, no redirects', async () => {
    const r = await make().postShopify({query: Q, variables: {after: null}});
    expect(r.body).toEqual({data: {shop: {name: 'T'}}});
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://crm.example/worker${SHOPIFY_POST_PATH}`);
    expect(SHOPIFY_POST_PATH).toBe('/api/shopify/query');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.redirect).toBe('error');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({query: Q, variables: {after: null}});
    const h = new Headers(calls[0].init.headers);
    expect(h.get('authorization')).toBe('Bearer tok-SECRET');
    expect(h.get('content-type')).toBe('application/json');
  });
  it.each([
    ['an extra key (a path)', {query: Q, path: '/api/admin/send'}],
    ['an extra key (a method)', {query: Q, method: 'DELETE'}],
    ['an extra key (a url)', {query: Q, url: 'https://evil.example'}],
    ['an empty query', {query: '  '}],
    ['a query over the character cap', {query: `{ shop { name } }${' '.repeat(SHOPIFY_LIMITS.queryChars)}`}],
    ['variables that are an array', {query: Q, variables: [1] as never}],
    ['a body over the byte cap', {query: Q, variables: {a: 'x'.repeat(SHOPIFY_LIMITS.bodyBytes)}}],
    ['a non-object', 'select 1' as never],
    ['null', null as never],
  ])('refuses %s with zero requests', async (_n, payload) => {
    await expect(make().postShopify(payload as never)).rejects.toMatchObject({code: 'refused'});
    expect(calls).toHaveLength(0);
  });
  it('is not a generic POST: every GET endpoint stays GET, and the client exposes no other write method', async () => {
    const c = make();
    for (const id of Object.keys(CRM_ENDPOINTS) as CrmEndpointId[]) await c.get(id);
    expect(calls.every((x) => (x.init.method ?? 'GET') === 'GET')).toBe(true);
    expect(Object.keys(c).sort()).toEqual(['get', 'postShopify']);
    // the path cannot be steered: no parameter of postShopify names one
    expect(c.postShopify.length).toBe(1);
  });
  it('a turn gets only a few POSTs', async () => {
    const c = make();
    for (let i = 0; i < SHOPIFY_LIMITS.maxPostsPerTurn; i += 1) await c.postShopify({query: Q});
    await expect(c.postShopify({query: Q})).rejects.toMatchObject({code: 'call_cap'});
    expect(calls).toHaveLength(SHOPIFY_LIMITS.maxPostsPerTurn);
  });
  it('a 400 carries the CRM guard reason (and only that); other statuses carry a number and no upstream text', async () => {
    const guard = await make(() => new Response(JSON.stringify({error: 'field "note" is not allowed on Order', secret: 'tok-SECRET'}), {status: 400})).postShopify({query: Q}).catch((e: CrmError) => e);
    expect(guard).toMatchObject({code: 'upstream_error', status: 400, reason: 'field "note" is not allowed on Order'});
    expect(JSON.stringify(guard)).not.toMatch(/SECRET/);
    const bad = await make(() => new Response(JSON.stringify({error: 'Shopify did not accept the query', detail: 'internal host x'}), {status: 502})).postShopify({query: Q}).catch((e: CrmError) => e);
    expect(bad).toMatchObject({code: 'upstream_error', status: 502});
    expect((bad as CrmError).reason).toBeUndefined();
    const long = await make(() => new Response(JSON.stringify({error: 'x'.repeat(5000)}), {status: 400})).postShopify({query: Q}).catch((e: CrmError) => e);
    expect(((long as CrmError).reason ?? '').length).toBeLessThanOrEqual(300);
  });
  it('a body that is not JSON is bad_shape; a redirect is not followed (fetch is told to error)', async () => {
    await expect(make(() => new Response('<html>', {status: 200})).postShopify({query: Q})).rejects.toMatchObject({code: 'bad_shape'});
    expect(calls[0].init.redirect).toBe('error');
  });
});

describe('productSales: the website channel of compare_sku, GET only with typed parameters', () => {
  it('sends from, to, group_by, limit and financial_status and nothing else', async () => {
    const c = make();
    await c.get('productSales', {from: '2026-10-12', to: '2026-10-18', group_by: 'sku', limit: 200, financial_status: 'paid'});
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe('/worker/api/products/sales');
    expect([...u.searchParams.keys()].sort()).toEqual(['financial_status', 'from', 'group_by', 'limit', 'to']);
    expect(calls[0].init.method).toBe('GET');
  });
  it.each([
    [{from: '12 Oct', to: '2026-10-18'}],
    [{from: '2026-10-12', to: "2026-10-18'; drop"}],
    [{group_by: 'sku; x'}],
    [{group_by: 5 as unknown as string}],
    [{limit: -1}],
    [{spec: '{}'}],
    [{from: '2026-10-12', to: '2026-10-18', tz: 'Asia/Manila'}],
  ])('refuses %j with zero requests', async (query) => {
    await expect(make().get('productSales', query)).rejects.toMatchObject({code: 'refused'});
    expect(calls).toHaveLength(0);
  });
});
