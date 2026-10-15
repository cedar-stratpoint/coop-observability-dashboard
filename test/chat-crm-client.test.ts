import {describe, expect, it, vi} from 'vitest';
import {logCrmCall} from '../src/chat/audit';
import {resolveCrmAccess} from '../src/chat/crm/config';
import {CRM_LIMITS, CrmError, createCrmClient} from '../src/chat/crm/client';
import {paramsFingerprint} from '../src/chat/explore/fingerprint';

type Call = {url: string; init: RequestInit};
function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({url, init});
    return respond(url, init);
  }) as typeof globalThis.fetch;
  return {fetch, calls};
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), {status, headers: {'content-type': 'application/json'}});
const TOKEN = 'tok-SECRET-123';
const client = (respond: Parameters<typeof fakeFetch>[0], limits = {}) => {
  const f = fakeFetch(respond);
  return {c: createCrmClient({baseUrl: 'https://crm.example/worker', token: TOKEN, fetch: f.fetch, limits}), calls: f.calls};
};

describe('resolveCrmAccess (fail closed)', () => {
  it('needs both env values and a clean https URL (http only on loopback)', () => {
    expect(resolveCrmAccess({})).toEqual({enabled: false, reason: 'not_configured'});
    expect(resolveCrmAccess({CRM_API_URL: 'https://crm.example'})).toEqual({enabled: false, reason: 'not_configured'});
    expect(resolveCrmAccess({CRM_API_URL: 'https://crm.example/w/', CRM_API_READ_TOKEN: 't'})).toEqual({enabled: true, baseUrl: 'https://crm.example/w', token: 't', tools: true});
    expect(resolveCrmAccess({CRM_API_URL: 'http://localhost:8787', CRM_API_READ_TOKEN: 't'})).toMatchObject({enabled: true, baseUrl: 'http://localhost:8787'});
    for (const bad of ['http://crm.example', 'https://u:p@crm.example', 'https://crm.example?x=1', 'https://crm.example#f', 'javascript:alert(1)', 'not a url']) {
      expect(resolveCrmAccess({CRM_API_URL: bad, CRM_API_READ_TOKEN: 't'})).toEqual({enabled: false, reason: 'url_invalid'});
    }
  });
  it('CHAT_CRM_TOOLS=off hides the tools only', () => {
    expect(resolveCrmAccess({CRM_API_URL: 'https://crm.example', CRM_API_READ_TOKEN: 't', CHAT_CRM_TOOLS: 'OFF'})).toMatchObject({enabled: true, tools: false});
  });
});

describe('createCrmClient', () => {
  it('refuses a base URL carrying credentials or a query instead of silently dropping them', () => {
    for (const baseUrl of ['https://u:p@crm.example', 'https://u@crm.example/w', 'https://crm.example/w?x=1']) {
      expect(() => createCrmClient({baseUrl, token: TOKEN, fetch: fakeFetch(() => json({})).fetch})).toThrow(expect.objectContaining({code: 'refused'}));
    }
  });

  it('treats a null query like no query', async () => {
    const {c, calls} = client(() => json({}));
    await c.get('metrics', null as unknown as undefined);
    expect(calls[0].url).toBe('https://crm.example/worker/api/metrics');
  });

  it('sends one GET to base path + endpoint path with the bearer token, no redirects, no caching', async () => {
    const {c, calls} = client(() => json({customers: 3}));
    const r = await c.get('metrics');
    expect(r).toMatchObject({endpoint: 'metrics', body: {customers: 3}, cached: false});
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://crm.example/worker/api/metrics');
    expect(calls[0].init).toMatchObject({method: 'GET', redirect: 'error', cache: 'no-store', headers: {Authorization: `Bearer ${TOKEN}`, Accept: 'application/json'}});
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reads each endpoint once per turn, failures included', async () => {
    const ok = client(() => json({orders: []}));
    await ok.c.get('orders');
    const again = await ok.c.get('orders');
    expect(again.cached).toBe(true);
    expect(ok.calls).toHaveLength(1);
    const down = client(() => { throw new TypeError('fetch failed'); });
    await expect(down.c.get('orders')).rejects.toMatchObject({code: 'unreachable'});
    await expect(down.c.get('orders')).rejects.toMatchObject({code: 'unreachable'});
    expect(down.calls).toHaveLength(1);
  });

  it('maps every failure to a code, never to the URL, the token or upstream text', async () => {
    const cases: [Parameters<typeof fakeFetch>[0], string][] = [
      [() => new Response(`Bearer ${TOKEN} invalid`, {status: 401}), 'upstream_error'],
      [() => new Response('not json', {status: 200}), 'bad_shape'],
      [() => new Response('{}', {status: 200, headers: {'content-length': String(CRM_LIMITS.maxResponseBytes + 1)}}), 'too_large'],
      [() => { throw new TypeError(`connect https://crm.example/worker?token=${TOKEN}`); }, 'unreachable'],
    ];
    for (const [respond, code] of cases) {
      const {c} = client(respond);
      const err = await c.get('metrics').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CrmError);
      expect((err as CrmError).code).toBe(code);
      expect(`${(err as Error).message} ${String(err)} ${JSON.stringify(err)}`).not.toMatch(/SECRET|crm\.example/);
    }
  });

  it('caps a streamed body without a content-length', async () => {
    const big = () => new Response(new ReadableStream({start(ctl) { ctl.enqueue(new Uint8Array(600)); ctl.enqueue(new Uint8Array(600)); ctl.close(); }}));
    const {c} = client(big, {maxResponseBytes: 1000});
    await expect(c.get('orders')).rejects.toMatchObject({code: 'too_large'});
  });

  it('times out', async () => {
    const {c} = client((_u, init) => new Promise<Response>((_r, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))), {timeoutMs: 20});
    await expect(c.get('metrics')).rejects.toMatchObject({code: 'timeout'});
  });

  it('caps GETs per turn', async () => {
    const {c, calls} = client(() => json({}), {maxGetsPerTurn: 2});
    await c.get('metrics');
    await c.get('customers');
    await expect(c.get('orders')).rejects.toMatchObject({code: 'call_cap'});
    expect(calls).toHaveLength(2);
  });
});

describe('audit helpers', () => {
  it('paramsFingerprint: 12 hex, key order does not matter, values do', () => {
    const a = paramsFingerprint({from: '2026-09-01', to: '2026-09-30'});
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(paramsFingerprint({to: '2026-09-30', from: '2026-09-01'})).toBe(a);
    expect(paramsFingerprint({from: '2026-09-02', to: '2026-09-30'})).not.toBe(a);
    expect(paramsFingerprint(undefined)).toMatch(/^[0-9a-f]{12}$/);
  });
  it('logCrmCall writes one chat_crm_call line with ids and counts only', () => {
    const info = vi.fn();
    logCrmCall({tool: 'list_crm_orders', endpoints: ['orders'], paramsFp: 'abcdef012345', ok: true, code: null, rows: 2, bytes: 900, ms: 12, user: 'o@z.test'}, {info, error: vi.fn()});
    expect(JSON.parse(info.mock.calls[0][0] as string)).toEqual({event: 'chat_crm_call', tool: 'list_crm_orders', endpoints: ['orders'], params_fp: 'abcdef012345', ok: true, code: null, rows: 2, bytes: 900, ms: 12, user: 'o@z.test'});
  });
});
