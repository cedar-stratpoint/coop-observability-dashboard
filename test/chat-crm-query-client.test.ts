import {describe, expect, it} from 'vitest';
import {CRM_ENDPOINTS, CRM_LIMITS, CrmError, MAX_SPEC_CHARS, createCrmClient} from '../src/chat/crm/client';

const calls: {url: string; method?: string; auth: string | null}[] = [];
const make = (limits = {}) => {
  calls.length = 0;
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({url: String(input), method: init.method, auth: new Headers(init.headers).get('authorization')});
    return new Response(JSON.stringify({ok: true}), {status: 200, headers: {'content-type': 'application/json'}});
  }) as typeof globalThis.fetch;
  return createCrmClient({baseUrl: 'https://crm.example/worker', token: 'tok-SECRET', fetch, limits});
};

describe('the client for crm_query: GET only, a catalog read, one string query parameter', () => {
  it('reads the catalog with the read token and no query string', async () => {
    await make().get('catalog');
    expect(calls[0]).toMatchObject({url: 'https://crm.example/worker/api/catalog', auth: 'Bearer tok-SECRET'});
    expect(calls[0].method ?? 'GET').toBe('GET');
  });
  it('sends one JSON spec, URL-encoded, on /api/query', async () => {
    const spec = JSON.stringify({table: 'orders', select: [{agg: 'count'}], filters: [{column: 'created_at', op: 'gte', value: '2026-09-01'}]});
    await make().get('query', {spec});
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe('/worker/api/query');
    expect([...u.searchParams.keys()]).toEqual(['spec']);
    expect(u.searchParams.get('spec')).toBe(spec);
    expect(calls[0].url).not.toMatch(/ |"|\{/); // encoded
  });
  it.each([
    ['not JSON', {spec: 'select 1'}],
    ['an array', {spec: '[1]'}],
    ['an empty spec', {spec: ''}],
    ['a spec over the character cap', {spec: JSON.stringify({table: 'x'.repeat(MAX_SPEC_CHARS)})}],
    ['a number for the spec', {spec: 5 as unknown as string}],
    ['an unknown parameter', {spec: '{}', sql: 'select 1'} as never],
  ])('refuses %s', async (_n, query) => {
    await expect(make().get('query', query)).rejects.toMatchObject({code: 'refused'});
    expect(calls).toHaveLength(0);
  });
  it('other endpoints still take integers only; a spec on them is refused', async () => {
    await expect(make().get('orders', {spec: '{}'})).rejects.toBeInstanceOf(CrmError);
    await expect(make().get('orders', {limit: 5})).rejects.toMatchObject({code: 'refused'}); // no integer parameters are allowed there either
    expect(Object.keys(CRM_ENDPOINTS)).toEqual(expect.arrayContaining(['catalog', 'query']));
  });
  it('page reads have their own budget: the normal cap is untouched, the paged one ends with call_cap', async () => {
    const c = make({maxGetsPerTurn: 2, maxPagedGets: 3});
    for (let i = 0; i < 3; i += 1) await c.get('query', {spec: JSON.stringify({table: 'orders', n: i})}, {paged: true});
    await expect(c.get('query', {spec: JSON.stringify({table: 'orders', n: 9})}, {paged: true})).rejects.toMatchObject({code: 'call_cap'});
    await c.get('catalog');
    await c.get('query', {spec: JSON.stringify({table: 'orders', n: 10})});
    await expect(c.get('query', {spec: JSON.stringify({table: 'orders', n: 11})})).rejects.toMatchObject({code: 'call_cap'});
    expect(CRM_LIMITS.maxPagedGets).toBe(60);
  });
});
