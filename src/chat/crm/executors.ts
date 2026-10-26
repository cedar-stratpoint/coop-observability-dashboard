// The website CRM tool executors (spec 4.2, 4.3): a per-turn call cap, one chat_crm_call audit line per call, honest failure. Pure:
// the GET-only client is injected (src/chat/crm/client.ts), so vitest drives it with a fake.
import type {RangeOrder} from '../../custom-range';
import {logCrmCall, logPiiRead, type AuditSink} from '../audit';
import type {ChatBlock} from '../block-types';
import {paramsFingerprint} from '../explore/fingerprint';
import type {MetricError, MetricResult} from '../result-types';
import {CRM_LIMITS, CrmError, type CrmClient, type CrmEndpointId, type CrmErrorCode, type CrmRead} from './client';
import {loadCatalog, resetCatalogCache} from './query-catalog';
import {runQuery} from './query-run';
import {describeCatalog} from './query-shape';
import {isErr, readQueryInput} from './query-spec';
import {crmCheckoutsResult, crmCustomersResult, crmMetricsResult, crmOrdersResult, crmRangeOrders, isMetricError, readCheckoutsInput, readCustomersInput, readMetricsInput, readOrdersInput, type CrmGet} from './tools';

export const CRM_TOOL_NAMES = ['get_crm_metrics', 'crm_query', 'list_crm_orders', 'list_crm_customers', 'list_crm_checkouts'] as const;
export type CrmToolName = (typeof CRM_TOOL_NAMES)[number];

const SAY = 'Say so plainly and give no website figure; do not guess, and do not use another source in its place.';
export const CRM_ERROR_TEXT: Readonly<Record<CrmErrorCode | 'refused_cap', string>> = Object.freeze({
  unreachable: `The website CRM is unreachable right now. ${SAY}`,
  timeout: `The website CRM did not answer in time, so it is unreachable right now. ${SAY}`,
  upstream_error: `The website CRM returned an error, so its data is not available right now. ${SAY}`,
  too_large: `The website CRM sent more data than Ask Coop reads at once, so an answer would be incomplete. ${SAY}`,
  bad_shape: `The website CRM answered in an unexpected format, so its data is not available right now. ${SAY}`,
  call_cap: 'This question has used its website CRM reads. Answer from the CRM results you already have, or ask the owner to ask a narrower question.',
  refused: 'That website CRM request is not allowed.',
  refused_cap: 'Too many invalid requests this turn.',
});

export interface CrmDeps {
  client: CrmClient;
  user: string | null;
  sink?: AuditSink;
}

/** One CRM read on behalf of `tool`: tracks the GETs, writes one chat_crm_call line, and turns a CrmError into its honest text. Any other error is logged as "internal" and rethrown (dispatchToolCall reports a generic failure). */
export async function tracked<T>(deps: CrmDeps, tool: string, params: unknown, run: (get: CrmGet) => Promise<T>, rowsOf: (value: T) => number | null): Promise<T | MetricError> {
  const endpoints = new Set<CrmEndpointId>();
  const reads: CrmRead[] = [];
  const get: CrmGet = async (endpoint, query) => {
    endpoints.add(endpoint);
    const r = await deps.client.get(endpoint, query);
    reads.push(r);
    return r;
  };
  const t0 = Date.now();
  const line = (ok: boolean, code: string | null, rows: number | null): void =>
    logCrmCall({tool, endpoints: [...endpoints], paramsFp: paramsFingerprint(params), ok, code, rows, bytes: reads.reduce((s, r) => s + (r.cached ? 0 : r.bytes), 0), ms: Date.now() - t0, user: deps.user}, deps.sink);
  try {
    const value = await run(get);
    line(true, null, rowsOf(value));
    return value;
  } catch (e) {
    if (e instanceof CrmError) {
      line(false, e.code, null);
      // the CRM refused the query itself (HTTP 400): the catalog may have changed since it was read, so read it again next time
      if (e.code === 'upstream_error' && e.status === 400) {
        resetCatalogCache();
        return {error: 'The website CRM refused that query as invalid. Call crm_query with describe true (and the table) to see what is allowed now, then correct the query once.'};
      }
      return {error: CRM_ERROR_TEXT[e.code]};
    }
    line(false, 'internal', null);
    throw e;
  }
}

export interface CrmExecutorDeps extends CrmDeps {
  now: Date;
  /** Stores a result in the turn's result store and returns what the model sees (tool-executors.ts: id + compact). */
  keep: (result: MetricResult) => unknown;
  maxCalls?: number;
  /** Cap on refused (bad input) calls, separate from the read budget, so the model cannot loop on bad input. */
  maxRefused?: number;
  /** The caller is on the allowlist that also gates `contacts` (EXPLORE_ALLOWED_EMAILS, decided by the route): only then may crm_query return customer identity (detail "identity"). */
  allowIdentity?: boolean;
  /** Draws a table for the owner (the "all" strategy); absent: no table is drawn and the model is told so. */
  emitBlock?: (block: ChatBlock) => void;
}

export function createCrmExecutors(deps: CrmExecutorDeps): Record<CrmToolName, (input: unknown) => Promise<unknown>> {
  let calls = 0;
  let refused = 0;
  let tables = 0;
  const max = deps.maxCalls ?? CRM_LIMITS.maxToolCallsPerTurn;
  const maxRefused = deps.maxRefused ?? CRM_LIMITS.maxToolCallsPerTurn;
  const refusedLine = (tool: CrmToolName, input: unknown, code: string): void =>
    logCrmCall({tool, endpoints: [], paramsFp: paramsFingerprint(input), ok: false, code, rows: null, bytes: 0, ms: 0, user: deps.user}, deps.sink);
  const tool =
    <R>(name: CrmToolName, read: (input: unknown) => R | MetricError, build: (req: R, get: CrmGet) => Promise<MetricResult>) =>
    async (input: unknown): Promise<unknown> => {
      const req = read(input);
      if (isMetricError(req)) {
        if (refused >= maxRefused) {
          refusedLine(name, input, 'refused_cap');
          return {error: CRM_ERROR_TEXT.refused_cap};
        }
        refused += 1;
        refusedLine(name, input, 'input');
        return req;
      }
      if (calls >= max) {
        refusedLine(name, input, 'call_cap');
        return {error: CRM_ERROR_TEXT.call_cap};
      }
      calls += 1;
      const out = await tracked(deps, name, req, (get) => build(req, get), (r) => r.rows.length);
      return isMetricError(out) ? out : deps.keep(out);
    };
  return {
    get_crm_metrics: tool('get_crm_metrics', readMetricsInput, (_req, get) => crmMetricsResult(get, deps.now)),
    crm_query: async (input: unknown): Promise<unknown> => {
      const identityAsked = input !== null && typeof input === 'object' && !Array.isArray(input) && (input as {detail?: unknown}).detail === 'identity';
      const refuse = (out: MetricError, code: string): MetricError => {
        if (refused >= maxRefused) {
          refusedLine('crm_query', input, 'refused_cap');
          return {error: CRM_ERROR_TEXT.refused_cap};
        }
        refused += 1;
        refusedLine('crm_query', input, code);
        if (identityAsked) logPiiRead({tool: 'crm_query', mode: 'identity', ok: false, code, eventId: null, rows: null, columns: [], user: deps.user}, deps.sink);
        return out;
      };
      // Identity detail is decided here, BEFORE any CRM call (not even the catalog read), for everyone who is not on the allowlist.
      if (identityAsked && deps.allowIdentity !== true) return refuse({error: 'Names, pet names, email and phone are not available to this user. Answer with counts and totals only, and say so.'}, 'identity_denied');
      if (calls >= max) {
        refusedLine('crm_query', input, 'call_cap');
        return {error: CRM_ERROR_TEXT.call_cap};
      }
      const {catalog, source} = await loadCatalog((e, q) => deps.client.get(e, q), deps.now.getTime());
      const req = readQueryInput(input, catalog, {allowIdentity: deps.allowIdentity === true});
      if (isErr(req)) return refuse(req, 'input');
      if (req.kind === 'describe') return describeCatalog(catalog, req.table, deps.allowIdentity === true, source);
      calls += 1;
      const out = await tracked(deps, 'crm_query', req.spec, (get) => runQuery(req, {get, cat: catalog, now: deps.now}), (r) => r.rowsOut);
      if (req.identity) {
        // one line per identity call: who, which columns, how many rows. Never a value.
        const ok = !isMetricError(out);
        logPiiRead({tool: 'crm_query', mode: 'identity', ok, code: ok ? null : 'crm_error', eventId: null, rows: ok ? out.rowsOut : null, columns: ok ? out.result.columns.map((c) => c.key) : [], user: deps.user}, deps.sink);
      }
      if (isMetricError(out)) return out;
      const kept = deps.keep(out.result) as Record<string, unknown>;
      if (out.table && deps.emitBlock) {
        tables += 1;
        deps.emitBlock({kind: 'table', id: `q${tables}`, source: `crm_query:${tables}`, ...out.table});
        return {...kept, shown: true, block: `q${tables}`, delivered_rows: out.rowsOut};
      }
      return out.table ? {...kept, shown: false, note: 'The table could not be drawn here; give the answer from the sample and the facts.'} : kept;
    },
    list_crm_orders: tool('list_crm_orders', readOrdersInput, crmOrdersResult),
    list_crm_customers: tool('list_crm_customers', readCustomersInput, (req, get) => crmCustomersResult(req, get, deps.now)),
    list_crm_checkouts: tool('list_crm_checkouts', readCheckoutsInput, crmCheckoutsResult),
  };
}

/** get_channel_report's Website row (F.6) through the same client and audit line. Throws when the CRM cannot be read, so the report says "could not be read", never "no orders". */
export async function websiteOrdersForReport(deps: CrmDeps): Promise<{orders: RangeOrder[]; asOf: string}> {
  const out = await tracked(deps, 'get_channel_report', {endpoint: 'orders'}, crmRangeOrders, (orders) => orders.length);
  if (isMetricError(out)) throw new CrmError('unreachable');
  return {orders: out, asOf: new Date().toISOString()};
}
