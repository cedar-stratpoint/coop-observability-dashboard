// The GET-only website CRM client for Ask Coop (spec 4.2; knowledge/best-practices/chat-readonly-api-tools.md). Pure: `fetch` is
// injected, so vitest drives it with a fake and no real CRM is needed. Rules, each pinned by a test:
//  - GET only (a constant), one base URL, endpoints by id from a frozen allowlist, a typed query allowlist (empty in wave 1);
//  - `redirect: 'error'` (a 30x never carries the bearer token anywhere), a timeout, a streamed byte cap;
//  - one read per endpoint per turn (memoised, failures included), a per-turn GET cap;
//  - errors carry a code only: never the URL, the token or upstream text.
// There is no path under the Worker's admin surface here, and there must never be one: a POST there starts a real customer email batch.

export type CrmParamType = 'int';
const endpoint = (path: string, query: Record<string, CrmParamType> = {}) => Object.freeze({path, query: Object.freeze({...query}) as Readonly<Record<string, CrmParamType>>});

/** Wave 1 sends no query parameters: the tools filter and page in code over one read per endpoint. */
export const CRM_ENDPOINTS = Object.freeze({
  metrics: endpoint('/api/metrics'),
  customers: endpoint('/api/customers'),
  orders: endpoint('/api/orders'),
  checkouts: endpoint('/api/checkouts'),
  membership: endpoint('/api/membership-config'),
});
export type CrmEndpointId = keyof typeof CRM_ENDPOINTS;

export const CRM_LIMITS = Object.freeze({
  timeoutMs: 5000,
  maxResponseBytes: 4_000_000,
  maxGetsPerTurn: 8,
  maxToolCallsPerTurn: 6,
  maxRowsPerResult: 100,
  maxResultBytes: 65_536,
});
export type CrmLimits = {-readonly [K in keyof typeof CRM_LIMITS]: number};

export type CrmErrorCode = 'refused' | 'call_cap' | 'timeout' | 'unreachable' | 'upstream_error' | 'too_large' | 'bad_shape';

/** A failed CRM read. The message is the code only: never a URL, a token or upstream text. */
export class CrmError extends Error {
  readonly code: CrmErrorCode;
  constructor(code: CrmErrorCode) {
    super(`crm ${code}`);
    this.name = 'CrmError';
    this.code = code;
  }
}

export interface CrmRead {
  endpoint: CrmEndpointId;
  body: unknown;
  /** Bytes of the response body (a memo hit repeats the original count; the audit line counts only reads with `cached: false`). */
  bytes: number;
  ms: number;
  /** True when this turn already read the endpoint and the same body was reused (no request was sent). */
  cached: boolean;
}

export interface CrmClient {
  get(endpoint: CrmEndpointId, query?: Readonly<Record<string, number>>): Promise<CrmRead>;
}

export interface CrmClientConfig {
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
  limits?: Partial<CrmLimits>;
  clock?: () => number;
}

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const failureCode = (e: unknown): CrmErrorCode => (e instanceof CrmError ? e.code : (e as {name?: unknown} | null)?.name === 'TimeoutError' ? 'timeout' : 'unreachable');

async function readCapped(res: Response, max: number): Promise<{text: string; bytes: number}> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new CrmError('too_large');
  }
  if (!res.body) return {text: '', bytes: 0};
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > max) {
      await reader.cancel().catch(() => undefined);
      throw new CrmError('too_large');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return {text: new TextDecoder().decode(all), bytes};
}

/** One client per chat request (the memo and the GET cap are per turn). */
export function createCrmClient(cfg: CrmClientConfig): CrmClient {
  const limits: CrmLimits = {...CRM_LIMITS, ...cfg.limits};
  const clock = cfg.clock ?? Date.now;
  const base = new URL(cfg.baseUrl);
  if (base.username || base.password || base.search) throw new CrmError('refused'); // never silently drop what the operator configured
  const basePath = base.pathname.replace(/\/+$/, '');
  const memo = new Map<string, Promise<Omit<CrmRead, 'cached'>>>();
  let gets = 0;

  function urlFor(id: CrmEndpointId, query: Readonly<Record<string, number>>): string {
    const spec = CRM_ENDPOINTS[id];
    const keys = Object.keys(query).sort();
    for (const k of keys) {
      const v = query[k];
      if (!has(spec.query, k) || !Number.isInteger(v) || v < 0 || v > 100_000) throw new CrmError('refused');
    }
    const qs = keys.length ? `?${keys.map((k) => `${k}=${query[k]}`).join('&')}` : '';
    const url = `${base.origin}${basePath}${spec.path}${qs}`;
    const check = new URL(url);
    if (check.origin !== base.origin || check.pathname !== `${basePath}${spec.path}`) throw new CrmError('refused');
    return url;
  }

  async function load(id: CrmEndpointId, url: string): Promise<Omit<CrmRead, 'cached'>> {
    const t0 = clock();
    try {
      const res = await cfg.fetch(url, {
        method: 'GET',
        headers: {Authorization: `Bearer ${cfg.token}`, Accept: 'application/json'},
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(limits.timeoutMs),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new CrmError('upstream_error');
      }
      const {text, bytes} = await readCapped(res, limits.maxResponseBytes);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new CrmError('bad_shape');
      }
      return {endpoint: id, body, bytes, ms: clock() - t0};
    } catch (e) {
      throw new CrmError(failureCode(e)); // a fresh error: never the original message, which may hold the URL
    }
  }

  return {
    async get(id, query) {
      if (typeof id !== 'string' || !has(CRM_ENDPOINTS, id)) throw new CrmError('refused');
      const url = urlFor(id, query ?? {});
      const hit = memo.get(url);
      if (hit) return {...(await hit), ms: 0, cached: true};
      if (gets >= limits.maxGetsPerTurn) throw new CrmError('call_cap');
      gets += 1;
      const p = load(id, url);
      memo.set(url, p);
      return {...(await p), cached: false};
    },
  };
}
