// Layer 1: the tool allowlist. Names only for now; schemas arrive with the features that add them.
// There is no write tool, and an unknown name is refused before anything runs.
import {logGuardTrip, logToolCall, type AuditSink} from './audit';

export const RUN_QUERY_TOOL = 'run_query';

export const TOOL_ALLOWLIST = Object.freeze([
  'describe_data',
  'query_metric',
  'render_chart',
  'render_table',
  'render_kpi',
  'set_report_filters',
  'remove_block',
  'set_report_title',
  'get_digest',
  'get_channel_report',
  'get_crm_metrics',
  'list_crm_orders',
  'list_crm_customers',
  'list_crm_checkouts',
  'lookup_product',
  'run_query',
  'list_tables',
  'describe_table',
] as const);

export type AllowedTool = (typeof TOOL_ALLOWLIST)[number];

export function isAllowedTool(name: unknown): name is AllowedTool {
  return typeof name === 'string' && (TOOL_ALLOWLIST as readonly string[]).includes(name);
}

export type ToolExecutors = Partial<Record<AllowedTool, (input: unknown) => Promise<unknown>>>;
export type ToolResult = {is_error: boolean; content: unknown; /** A guard tripped hard: the loop ends the turn. */ trip?: boolean};

/**
 * A guard that must FAIL THE REQUEST (spec 3.5), not just be reported to the model as a repairable tool error.
 * `dispatchToolCall` turns it into {trip: true}; the loop then ends the turn with the refusal text. Carries codes only: no SQL, no message text.
 */
export class GuardTripError extends Error {
  readonly layer: string;
  readonly code: string;
  constructor(layer: string, code: string) {
    super(`guard trip: ${layer} ${code}`);
    this.name = 'GuardTripError';
    this.layer = layer;
    this.code = code;
  }
}

/**
 * What a tool call writes to the log as its params. Most tools log their (small, enum-like) input. run_query's input is SQL that can
 * hold customer literals, so it logs only the step and the lengths (spec 8): never the SQL text, never the purpose text.
 */
export function paramsForLog(name: string, input: unknown): unknown {
  if (name !== RUN_QUERY_TOOL) return input;
  const i = input !== null && typeof input === 'object' ? (input as {step?: unknown; sql?: unknown; purpose?: unknown}) : {};
  return {step: i.step === 'probe' || i.step === 'final' ? i.step : null, sql_chars: typeof i.sql === 'string' ? i.sql.length : null, purpose_chars: typeof i.purpose === 'string' ? i.purpose.length : null};
}

// An executor that refuses a request returns exactly {error: '<message with the allowed values>'}. Flag it so the model
// corrects itself. A result that merely contains an "error" field alongside other keys is data, not a refusal.
function isRefusal(result: unknown): boolean {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return false;
  const keys = Object.keys(result);
  return keys.length === 1 && keys[0] === 'error' && typeof (result as {error: unknown}).error === 'string';
}

export async function dispatchToolCall(
  call: {name: unknown; input: unknown; user?: string | null},
  executors: ToolExecutors,
  sink?: AuditSink,
): Promise<ToolResult> {
  const {name, input, user} = call;
  if (!isAllowedTool(name)) {
    logGuardTrip({layer: 'tool_allowlist', detail: {name: typeof name === 'string' ? name : `[${typeof name}]`}, user}, sink);
    return {is_error: true, content: 'Unknown tool. Ask Coop can only use its read-only tools.'};
  }
  const exec = Object.prototype.hasOwnProperty.call(executors, name) ? executors[name] : undefined;
  if (!exec) return {is_error: true, content: 'not implemented'};
  const t0 = Date.now();
  try {
    const result = await exec(input);
    const rows = (result as {rows?: unknown} | null)?.rows;
    logToolCall({tool: name, params: paramsForLog(name, input), rowCount: Array.isArray(rows) ? rows.length : null, ms: Date.now() - t0, user}, sink);
    return {is_error: isRefusal(result), content: result};
  } catch (e) {
    if (e instanceof GuardTripError) {
      logGuardTrip({layer: e.layer, detail: {code: e.code, class: 'hard'}, user}, sink);
      return {is_error: true, content: "I can't run that.", trip: true};
    }
    logToolCall({tool: name, params: {error: e instanceof Error ? e.name : 'error'}, ms: Date.now() - t0, user}, sink);
    return {is_error: true, content: 'The tool failed. Try again or ask differently.'};
  }
}
