// Layer 1b: assert the shape of the Messages API request before it is sent.
// Pure; throws and logs a guard trip on any violation.
import {logGuardTrip, type AuditSink} from './audit';
import {isAllowedTool} from './tools';

const TOP_KEYS = new Set(['model', 'max_tokens', 'thinking', 'system', 'messages', 'tools', 'tool_choice', 'cache_control', 'output_config']);
const EFFORTS = new Set(['low', 'medium', 'high']);
// The only tools sent with strict: false (grammar cap, see tool-defs.ts); their input is validated in crm/tools.ts, clarify.ts askOwner, digest-lookup.ts shapeDigest and lookupProduct, and the contacts tool.
const NON_STRICT_OK = new Set(['list_crm_orders', 'list_crm_customers', 'list_crm_checkouts', 'ask_owner', 'contacts', 'get_digest', 'lookup_product']);
const TOOL_KEYS = new Set(['name', 'description', 'input_schema', 'strict', 'cache_control', 'type']);

function fail(rule: string, detail: unknown, sink?: AuditSink): never {
  logGuardTrip({layer: 'request_shape', detail: {rule, detail}}, sink);
  throw new Error(`Request shape violation: ${rule}`);
}

export function assertRequestShape(params: unknown, sink?: AuditSink): void {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) fail('request must be an object', typeof params, sink);
  const p = params as Record<string, unknown>;
  for (const k of Object.keys(p)) if (!TOP_KEYS.has(k)) fail('unexpected top-level key', k, sink);
  if ('output_config' in p) {
    const oc = p.output_config as Record<string, unknown> | null;
    const keys = oc && typeof oc === 'object' && !Array.isArray(oc) ? Object.keys(oc) : [];
    if (!oc || typeof oc !== 'object' || Array.isArray(oc) || keys.length !== 1 || keys[0] !== 'effort' || !EFFORTS.has(oc.effort as string)) {
      fail('output_config may only be {effort: low|medium|high}', oc, sink);
    }
  }
  if ('cache_control' in p) {
    const cc = p.cache_control as Record<string, unknown> | null;
    if (!cc || typeof cc !== 'object' || Array.isArray(cc) || Object.keys(cc).length !== 1 || cc.type !== 'ephemeral') fail('cache_control must be exactly {type:"ephemeral"}', cc, sink);
  }
  if ('tool_choice' in p) {
    const tc = p.tool_choice as {type?: unknown} | null;
    const keys = tc && typeof tc === 'object' ? Object.keys(tc) : [];
    if (!tc || typeof tc !== 'object' || (tc.type !== 'auto' && tc.type !== 'none') || keys.length !== 1) fail('tool_choice must be exactly {type:"auto"} (or {type:"none"} for the compose-only step)', tc, sink);
  }
  if ('tools' in p) {
    if (!Array.isArray(p.tools)) fail('tools must be an array', typeof p.tools, sink);
    for (const t of p.tools as unknown[]) {
      if (t === null || typeof t !== 'object' || Array.isArray(t)) fail('tool must be an object', typeof t, sink);
      const tool = t as Record<string, unknown>;
      if (!isAllowedTool(tool.name)) fail('tool name not in allowlist', tool.name, sink);
      if (tool.type !== undefined && tool.type !== 'custom') fail('only custom tools are allowed', tool.type, sink);
      if (tool.strict !== true && !(tool.strict === false && NON_STRICT_OK.has(String(tool.name)))) fail('every tool must be strict: true', tool.name, sink);
      for (const k of Object.keys(tool)) if (!TOOL_KEYS.has(k)) fail('unexpected tool key', k, sink);
    }
  }
}
