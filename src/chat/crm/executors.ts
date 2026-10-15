// The website CRM tool executors (spec 4.2, 4.3): a per-turn call cap, one chat_crm_call audit line per call, honest failure. Pure:
// the GET-only client is injected (src/chat/crm/client.ts), so vitest drives it with a fake.
import type {RangeOrder} from '../../custom-range';
import {logCrmCall, type AuditSink} from '../audit';
import {paramsFingerprint} from '../explore/fingerprint';
import type {MetricError, MetricResult} from '../result-types';
import {CRM_LIMITS, CrmError, type CrmClient, type CrmEndpointId, type CrmErrorCode, type CrmRead} from './client';
import {crmCheckoutsResult, crmCustomersResult, crmMetricsResult, crmOrdersResult, crmRangeOrders, isMetricError, readCheckoutsInput, readCustomersInput, readMetricsInput, readOrdersInput, type CrmGet} from './tools';

export const CRM_TOOL_NAMES = ['get_crm_metrics', 'list_crm_orders', 'list_crm_customers', 'list_crm_checkouts'] as const;
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
  const get: CrmGet = async (endpoint) => {
    endpoints.add(endpoint);
    const r = await deps.client.get(endpoint);
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
}

export function createCrmExecutors(deps: CrmExecutorDeps): Record<CrmToolName, (input: unknown) => Promise<unknown>> {
  let calls = 0;
  let refused = 0;
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
