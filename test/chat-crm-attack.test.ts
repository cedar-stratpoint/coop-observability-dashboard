// Train 4, spec 4.5: the GET-only CRM client against hostile inputs. Fake fetch only; every case asserts what was (not) sent.
import {describe, expect, it} from 'vitest';
import {CRM_ENDPOINTS, CrmError, createCrmClient, type CrmEndpointId} from '../src/chat/crm/client';
import {resolveCrmAccess} from '../src/chat/crm/config';
import {loadDirs, strip} from './support/chat-arch-scan';

const TOKEN = 'tok-SECRET-attack';
function harness(respond: (url: string, init: RequestInit) => Response | Promise<Response> = () => new Response('{}')) {
  const calls: {url: string; init: RequestInit}[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({url: String(input), init});
    return respond(String(input), init);
  }) as typeof globalThis.fetch;
  return {c: createCrmClient({baseUrl: 'https://crm.example/w', token: TOKEN, fetch}), calls};
}

describe('no POST, no other method', () => {
  it('every request is GET, and the client takes no method', async () => {
    const {c, calls} = harness();
    for (const id of Object.keys(CRM_ENDPOINTS) as CrmEndpointId[]) await c.get(id);
    const before = calls.length;
    // @ts-expect-error: get() has no third (init) parameter; a method cannot be passed
    await c.get('metrics', {}, {method: 'POST'}).catch(() => undefined);
    expect(calls).toHaveLength(before); // the memoised read sent nothing, and no extra request carried the smuggled init
    expect(calls.map((x) => x.init.method)).toEqual(Array(Object.keys(CRM_ENDPOINTS).length).fill('GET'));
  });
  it('the CRM code under src/chat has no other HTTP verb, no admin path and no body; only client.ts calls fetch', () => {
    const files = loadDirs(process.cwd(), ['src']);
    const crm = Object.keys(files).filter((p) => p.startsWith('src/chat/crm/'));
    expect(crm).toEqual(expect.arrayContaining(['src/chat/crm/client.ts', 'src/chat/crm/config.ts']));
    for (const f of crm) {
      const code = strip(files[f], false);
      expect(code, f).not.toMatch(/['"](POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]/i);
      expect(code, f).not.toMatch(/\/admin/);
      expect(code, f).not.toMatch(/\bbody\s*:(?!\s*unknown\b)/);
      // `method:` may only be followed by a quote (the GET literal, or a prose description in tools.ts, whose verbs the line above bans): never by a variable
      expect(code, f).not.toMatch(/\bmethod\s*:\s*[^'"\s]/);
      if (f !== 'src/chat/crm/client.ts') expect(code, f).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(/);
    }
  });
});

describe('no unknown path, no URL from the model', () => {
  it.each(['admin', '/admin', '../admin', 'metrics/../admin', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'https://evil.example/api/metrics', '//evil.example', 'METRICS'])('endpoint id %j is refused with no request', async (id) => {
    const {c, calls} = harness();
    await expect(c.get(id as CrmEndpointId)).rejects.toMatchObject({code: 'refused'});
    expect(calls).toHaveLength(0);
  });
  it('a non-string endpoint is refused', async () => {
    const {c, calls} = harness();
    for (const v of [null, 1, {}, ['metrics']]) await expect(c.get(v as unknown as CrmEndpointId)).rejects.toBeInstanceOf(CrmError);
    expect(calls).toHaveLength(0);
  });
  it('the base path prefix is kept and the host is the base host on every call', async () => {
    const {c, calls} = harness();
    await c.get('orders');
    expect(new URL(calls[0].url).host).toBe('crm.example');
    expect(calls[0].url).toBe('https://crm.example/w/api/orders');
  });
  it.each(['http://crm.example', 'https://crm.example?next=https://evil', 'https://user:pass@crm.example', 'ftp://crm.example', 'file:///etc/passwd', 'https://crm.example#x'])('a base URL like %s turns the client off', (url) => {
    expect(resolveCrmAccess({CRM_API_URL: url, CRM_API_READ_TOKEN: 't'})).toMatchObject({enabled: false});
  });
});

describe('no extra parameter', () => {
  it.each([[{limit: 10}], [{offset: 0}], [{'a&b': 1}], [JSON.parse('{"__proto__": 1}') as Record<string, number>], [{admin: 1}]])('query %j is refused (wave 1 sends none) with no request', async (q) => {
    const {c, calls} = harness();
    await expect(c.get('orders', q)).rejects.toMatchObject({code: 'refused'});
    expect(calls).toHaveLength(0);
  });
});

describe('the token never leaks', () => {
  it('only the Authorization header carries it, and no redirect is followed', async () => {
    const {c, calls} = harness();
    await c.get('metrics');
    expect(calls[0].url).not.toContain(TOKEN);
    expect(calls[0].init.redirect).toBe('error');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });
  it('a redirect attempt, an echoing 401 and a network error all end as codes without the token or the host', async () => {
    const respond: [() => Response, string][] = [
      [() => { throw new TypeError(`redirect to https://evil.example/?t=${TOKEN}`); }, 'unreachable'],
      [() => new Response(`bad token ${TOKEN}`, {status: 401}), 'upstream_error'],
      [() => new Response(`{"echo":"${TOKEN}"`, {status: 200}), 'bad_shape'],
    ];
    for (const [r, want] of respond) {
      const {c} = harness(r);
      const e = await c.get('customers').catch((x: unknown) => x);
      expect(e).toBeInstanceOf(CrmError);
      expect((e as CrmError).code).toBe(want);
      expect(`${String(e)} ${(e as Error).stack ?? ''} ${JSON.stringify(e)}`).not.toMatch(/SECRET|evil\.example|crm\.example/);
    }
  });
  it('CRM_API_READ_TOKEN is READ from env in exactly two files: the chat config and the pages reader (crm-view.tsx only names it in help text)', () => {
    const all = loadDirs(process.cwd(), ['src', 'app', 'components', 'lib']);
    expect(Object.keys(all).filter((f) => /\benv\.CRM_API_READ_TOKEN\b/.test(all[f])).sort()).toEqual(['src/chat/crm/config.ts', 'src/crm-data.ts']);
  });
});

describe('size and time caps (Review Focus 4)', () => {
  it('a body that lies about its length is still cut at the cap', async () => {
    const {c} = harness(() => new Response(new ReadableStream({start(ctl) { for (let i = 0; i < 5; i += 1) ctl.enqueue(new Uint8Array(1_000_000)); ctl.close(); }}), {headers: {'content-length': '10'}}));
    await expect(c.get('orders')).rejects.toMatchObject({code: 'too_large'});
  });
  it('a stalled body read ends as a timeout', async () => {
    const calls: RequestInit[] = [];
    const fetch = (async (_u: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push(init);
      return new Response(new ReadableStream({start(ctl) { init.signal?.addEventListener('abort', () => ctl.error(init.signal?.reason)); }}));
    }) as typeof globalThis.fetch;
    const c = createCrmClient({baseUrl: 'https://crm.example', token: TOKEN, fetch, limits: {timeoutMs: 20}});
    await expect(c.get('orders')).rejects.toMatchObject({code: 'timeout'});
  });
});
