// The GET-only website CRM client for Ask Coop (spec 4.2; knowledge/best-practices/chat-readonly-api-tools.md). Pure: `fetch` is
// injected, so vitest drives it with a fake and no real CRM is needed. Rules, each pinned by a test:
//  - GET only (a constant), one base URL, endpoints by id from a frozen allowlist, a typed query allowlist (only /api/query takes one: a JSON `spec` of at most 4,096 characters, the CRM's own cap);
//  - `redirect: 'error'` (a 30x never carries the bearer token anywhere), a timeout, a streamed byte cap;
//  - one read per endpoint per turn (memoised, failures included), a per-turn GET cap;
//  - errors carry a code only: never the URL, the token or upstream text.
// ONE narrowly scoped POST exists: `postShopify`, for exactly /api/shopify/query (the CRM's read-only GraphQL door, whose guard is the CRM's). It is not a generic POST:
// the path is a constant, the body is {query, variables} and nothing else, and the other endpoints cannot be reached with it (a test pins this).
// There is no path under the Worker's admin surface here, and there must never be one: a POST there starts a real customer email batch.

import {QUERY_LIMITS} from './query-config';

export type CrmParamType = 'int' | 'spec' | 'day' | 'word';
export const MAX_SPEC_CHARS = QUERY_LIMITS.maxSpecChars;
const endpoint = (path: string, query: Record<string, CrmParamType> = {}) => Object.freeze({path, query: Object.freeze({...query}) as Readonly<Record<string, CrmParamType>>});

/** The list tools send no query parameters (they filter and page in code over one read per endpoint). `query` carries the crm_query spec; `catalog` is the whitelist it is checked against. */
export const CRM_ENDPOINTS = Object.freeze({
  metrics: endpoint('/api/metrics'),
  customers: endpoint('/api/customers'),
  orders: endpoint('/api/orders'),
  checkouts: endpoint('/api/checkouts'),
  membership: endpoint('/api/membership-config'),
  catalog: endpoint('/api/catalog'),
  query: endpoint('/api/query', {spec: 'spec'}),
  /** compare_sku's website channel: units and net sales per SKU for a window (zoomy-crm docs/api-sales.md). */
  productSales: endpoint('/api/products/sales', {from: 'day', to: 'day', group_by: 'word', limit: 'int', financial_status: 'word'}),
});

/** The ONLY path the client may POST to (the CRM's read-only Shopify GraphQL door). Not a map and not extensible: a second path is a code change plus a test. */
export const SHOPIFY_POST_PATH = '/api/shopify/query';
/** The CRM's own request limits for that door (docs/api-shopify-query.md); the CRM stays the authority. */
export const SHOPIFY_LIMITS = Object.freeze({bodyBytes: 20_000, queryChars: 10_000, variablesBytes: 8_000, timeoutMs: 20_000, maxPostsPerTurn: 3});
export interface ShopifyBody {
  query: string;
  variables?: Record<string, unknown>;
}
export type CrmEndpointId = keyof typeof CRM_ENDPOINTS;

export const CRM_LIMITS = Object.freeze({
  timeoutMs: 5000,
  maxResponseBytes: 4_000_000,
  maxGetsPerTurn: 8,
  /** GETs a crm_query "all" walk may add in one turn (its pages), counted apart from the normal cap. */
  maxPagedGets: 60,
  maxToolCallsPerTurn: 6,
  maxRowsPerResult: 100,
  maxResultBytes: 65_536,
});
export type CrmLimits = {-readonly [K in keyof typeof CRM_LIMITS]: number};

export type CrmErrorCode = 'refused' | 'call_cap' | 'timeout' | 'unreachable' | 'upstream_error' | 'too_large' | 'bad_shape';

/** A failed CRM read. The message is the code only: never a URL, a token or upstream text. */
export class CrmError extends Error {
  readonly code: CrmErrorCode;
  /** The HTTP status of an `upstream_error` (a number, safe to show: it says 401 versus 404 versus 500 without any upstream text). */
  readonly status?: number;
  /** Only for a 400 from the Shopify door: the CRM guard's own reason (a short sentence about the query, no data), so the model can fix its query. Never any other upstream text. */
  readonly reason?: string;
  constructor(code: CrmErrorCode, status?: number, reason?: string) {
    super(`crm ${code}`);
    this.name = 'CrmError';
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}

export interface CrmRead {
  endpoint: CrmEndpointId | 'shopify';
  body: unknown;
  /** Bytes of the response body (a memo hit repeats the original count; the audit line counts only reads with `cached: false`). */
  bytes: number;
  ms: number;
  /** True when this turn already read the endpoint and the same body was reused (no request was sent). */
  cached: boolean;
}

export interface CrmClient {
  /** `paged`: one page of a crm_query walk, counted against maxPagedGets instead of maxGetsPerTurn. */
  get(endpoint: CrmEndpointId, query?: Readonly<Record<string, number | string>>, opts?: {paged?: boolean}): Promise<CrmRead>;
  /** The one POST: a GraphQL query to the CRM's read-only Shopify door. Not memoised (a query may be repeated on purpose), counted against SHOPIFY_LIMITS.maxPostsPerTurn. */
  postShopify(payload: ShopifyBody): Promise<CrmRead>;
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
  let pagedGets = 0;
  let posts = 0;

  function urlFor(id: CrmEndpointId, query: Readonly<Record<string, number | string>>): string {
    const spec = CRM_ENDPOINTS[id];
    const keys = Object.keys(query).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = query[k];
      if (!has(spec.query, k)) throw new CrmError('refused');
      if (spec.query[k] === 'int') {
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 100_000) throw new CrmError('refused');
        parts.push(`${k}=${v}`);
      } else if (spec.query[k] === 'day') {
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new CrmError('refused');
        parts.push(`${k}=${v}`);
      } else if (spec.query[k] === 'word') {
        if (typeof v !== 'string' || !/^[a-z_]{1,30}$/.test(v)) throw new CrmError('refused');
        parts.push(`${k}=${v}`);
      } else {
        // a `spec`: JSON text of an object, short, encoded as one query value (the Worker compiles it against its own catalog)
        if (typeof v !== 'string' || v.length === 0 || v.length > MAX_SPEC_CHARS) throw new CrmError('refused');
        let parsed: unknown;
        try {
          parsed = JSON.parse(v);
        } catch {
          throw new CrmError('refused');
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CrmError('refused');
        parts.push(`${k}=${encodeURIComponent(v)}`);
      }
    }
    const qs = parts.length ? `?${parts.join('&')}` : '';
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
        throw new CrmError('upstream_error', res.status);
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
      throw new CrmError(failureCode(e), e instanceof CrmError ? e.status : undefined); // a fresh error: never the original message, which may hold the URL; the status is a number and safe
    }
  }

  async function loadPost(url: string, payload: ShopifyBody): Promise<Omit<CrmRead, 'cached' | 'endpoint'>> {
    const t0 = clock();
    try {
      const res = await cfg.fetch(url, {
        method: 'POST',
        headers: {Authorization: `Bearer ${cfg.token}`, Accept: 'application/json', 'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(Math.max(limits.timeoutMs, SHOPIFY_LIMITS.timeoutMs)), // Shopify answers slower than D1
      });
      if (!res.ok) {
        let reason: string | undefined;
        if (res.status === 400) {
          // the guard's refusal: {"error": "<why>"}, a sentence about the query. Read at most 2 KB, keep 300 characters, nothing else is ever echoed.
          try {
            const {text} = await readCapped(res, 2048);
            const e = (JSON.parse(text) as {error?: unknown}).error;
            if (typeof e === 'string') reason = e.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
          } catch {
            reason = undefined;
          }
        } else await res.body?.cancel().catch(() => undefined);
        throw new CrmError('upstream_error', res.status, reason);
      }
      const {text, bytes} = await readCapped(res, limits.maxResponseBytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new CrmError('bad_shape');
      }
      const body = parsed;
      return {body, bytes, ms: clock() - t0};
    } catch (e) {
      throw new CrmError(failureCode(e), e instanceof CrmError ? e.status : undefined, e instanceof CrmError ? e.reason : undefined);
    }
  }

  return {
    async postShopify(payload) {
      const keys = payload !== null && typeof payload === 'object' ? Object.keys(payload) : [];
      const variables = (payload as ShopifyBody | null)?.variables;
      if (keys.some((k) => k !== 'query' && k !== 'variables') || typeof payload?.query !== 'string' || payload.query.trim() === '' || payload.query.length > SHOPIFY_LIMITS.queryChars) throw new CrmError('refused');
      if (variables !== undefined && (variables === null || typeof variables !== 'object' || Array.isArray(variables))) throw new CrmError('refused');
      if (new TextEncoder().encode(JSON.stringify(payload)).length > SHOPIFY_LIMITS.bodyBytes) throw new CrmError('refused');
      if (posts >= SHOPIFY_LIMITS.maxPostsPerTurn) throw new CrmError('call_cap');
      posts += 1;
      const url = `${base.origin}${basePath}${SHOPIFY_POST_PATH}`;
      if (new URL(url).pathname !== `${basePath}${SHOPIFY_POST_PATH}`) throw new CrmError('refused');
      return {endpoint: 'shopify' as const, ...(await loadPost(url, payload)), cached: false};
    },
    async get(id, query, opts) {
      if (typeof id !== 'string' || !has(CRM_ENDPOINTS, id)) throw new CrmError('refused');
      const url = urlFor(id, query ?? {});
      const hit = memo.get(url);
      if (hit) return {...(await hit), ms: 0, cached: true};
      if (opts?.paged === true) {
        if (pagedGets >= limits.maxPagedGets) throw new CrmError('call_cap');
        pagedGets += 1;
      } else {
        if (gets >= limits.maxGetsPerTurn) throw new CrmError('call_cap');
        gets += 1;
      }
      const p = load(id, url);
      memo.set(url, p);
      return {...(await p), cached: false};
    },
  };
}
