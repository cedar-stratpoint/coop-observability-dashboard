// A FAKE CRM for crm_query tests: GET /api/catalog (the real final catalog, as a fixture) and GET /api/query?spec= shaped like the final zoomy-crm answers
// (keyset cursors of about 100 characters, cursor "start", paged cap 500, no paging ceiling). Synthetic data only
// (invented names, example.com addresses); no network. `rows` is a numbered synthetic list served with an offset cursor like the real CRM
// (page = min(limit, 200, or 500 with a cursor); `endWalkAt` simulates a walk that ends with no cursor), and `answer` can script any other response (aggregates, errors).
import type {CrmClient, CrmEndpointId, CrmRead} from '../../src/chat/crm/client';
import {CrmError} from '../../src/chat/crm/client';

import catalogJson from '../fixtures/crm-catalog-2026-10-23.1.json';

/** The REAL catalog body of zoomy-crm (branch feat/api-catalog-query, `publicCatalog()` dumped to a fixture; schema metadata only, no customer data). */
export const CATALOG_BODY = catalogJson as Record<string, unknown> & {catalog_version: string};

export interface FakeCrmOptions {
  catalog?: unknown | null;
  /** Numbered synthetic rows served by an offset cursor; the columns are `n`, `label`. */
  rows?: number;
  /** Rows after which the fake stops handing out a cursor (an unexpected end of the walk). */
  endWalkAt?: number;
  /** Scripted answer for a query spec (aggregates, identity, errors). Return undefined to fall through to the row list. */
  answer?: (spec: Record<string, unknown>) => unknown;
  /** Advance a fake clock per query GET (for the time-budget test). */
  onQuery?: () => void;
}

export interface FakeCrm {
  client: CrmClient;
  /** Every GET, in order: endpoint, parsed spec (query only), the paged flag. */
  calls: {endpoint: CrmEndpointId; spec: Record<string, unknown> | null; paged: boolean}[];
}

// The CRM's cursor: base64url of {v: sort value, id: row id}. About 100 characters, so a validator limited to 64 would refuse every real one.
const b64 = (o: number): string => Buffer.from(JSON.stringify({v: 2461000.123456 - o / 1000, id: `gid://shopify/Order/${6000000000000 + o}`, o})).toString('base64url');
const unb64 = (s: string): number => (s === 'start' ? 0 : (JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as {o: number}).o);

export function fakeQueryCrm(opts: FakeCrmOptions = {}): FakeCrm {
  const calls: FakeCrm['calls'] = [];
  const client: CrmClient = {
    async postShopify() {
      throw new CrmError('refused'); // these fakes serve GETs only; the Shopify door has its own fake (test/support/fake-shopify-door.ts)
    },
    async get(endpoint, query, o): Promise<CrmRead> {
      const paged = o?.paged === true;
      if (endpoint === 'catalog') {
        calls.push({endpoint, spec: null, paged});
        if (opts.catalog === null) throw new CrmError('upstream_error', 404);
        return {endpoint, body: opts.catalog ?? CATALOG_BODY, bytes: 100, ms: 1, cached: false};
      }
      if (endpoint !== 'query') throw new CrmError('refused');
      const spec = JSON.parse(String((query ?? {}).spec)) as Record<string, unknown>;
      calls.push({endpoint, spec, paged});
      opts.onQuery?.();
      const scripted = opts.answer?.(spec);
      if (scripted instanceof CrmError) throw scripted;
      if (scripted !== undefined) return {endpoint, body: scripted, bytes: 100, ms: 1, cached: false};
      const total = opts.rows ?? 0;
      const offset = typeof spec.cursor === 'string' ? unb64(spec.cursor) : 0;
      const cap = typeof spec.cursor === 'string' ? 500 : 200; // ROW_CAP_PAGED with a cursor, ROW_CAP_ROWS without
      const limit = Math.min(typeof spec.limit === 'number' ? spec.limit : typeof spec.cursor === 'string' ? 500 : 50, cap);
      const slice = Array.from({length: Math.max(0, Math.min(limit, total - offset))}, (_, i) => ({n: offset + i + 1, label: `Item ${offset + i + 1}`}));
      const more = offset + slice.length < total;
      const stop = more && opts.endWalkAt !== undefined && offset + slice.length > opts.endWalkAt;
      return {
        endpoint,
        bytes: 100,
        cached: false,
        ms: 1,
        body: {table: spec.table, mode: 'rows', columns: [{name: 'n', meaning: 'Row number', type: 'number'}, {name: 'label', meaning: 'Row label', type: 'text'}], rows: slice, row_count: slice.length, truncated: more, partial: false, next_cursor: more && !stop ? b64(offset + slice.length) : null, window: {from: '2026-09-01', to: '2026-09-30', tz: 'Asia/Manila'}, notes: [], untrusted_text_fields: [], catalog_version: CATALOG_BODY.catalog_version},
      };
    },
  };
  return {client, calls};
}

/** A page body the way the CRM answers an aggregate. */
export const aggBody = (columns: {name: string; agg?: string; meaning?: string; type?: string}[], rows: Record<string, unknown>[], o: Record<string, unknown> = {}) => ({
  table: 'orders', mode: 'aggregate', columns: columns.map((c) => ({meaning: '', type: c.agg ? 'number' : 'text', ...c})), rows, row_count: rows.length, truncated: false, partial: false, next_cursor: null, window: {from: '2026-09-01', to: '2026-09-30', tz: 'Asia/Manila'}, notes: [], untrusted_text_fields: [], catalog_version: CATALOG_BODY.catalog_version, ...o,
});
