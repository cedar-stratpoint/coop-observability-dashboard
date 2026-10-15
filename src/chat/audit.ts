// Layer 9: one JSON line per tool call, one per turn, and one error line per guard trip.
// Never log secrets; keep params small.
export type AuditSink = Pick<Console, 'info' | 'error'> & Partial<Pick<Console, 'warn'>>;

const SECRET_KEY = /key|token|secret|authorization|password/i;
const MAX_STRING = 300;
const MAX_DEPTH = 4;

export function scrubParams(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated ${value.length - MAX_STRING}]` : value;
  }
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' ? String(value) : value;
  }
  if (depth >= MAX_DEPTH) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubParams(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : scrubParams(v, depth + 1);
  }
  return out;
}

export function logToolCall(
  e: {tool: string; params: unknown; rowCount?: number | null; ms: number; user?: string | null},
  sink: AuditSink = console,
): void {
  sink.info(
    JSON.stringify({
      event: 'chat_tool',
      tool: scrubParams(e.tool),
      params: scrubParams(e.params),
      rowCount: e.rowCount ?? null,
      ms: e.ms,
      user: e.user ?? null,
    }),
  );
}

export function logGuardTrip(
  e: {layer: string; detail: unknown; user?: string | null; level?: 'error' | 'warn'},
  sink: AuditSink = console,
): void {
  // Hard trips log at error; a soft trip (spec 3.4 class S) at warn. A sink without warn falls back to info, never to silence.
  const write = e.level === 'warn' ? (sink.warn ?? sink.info).bind(sink) : sink.error.bind(sink);
  write(
    JSON.stringify({
      event: 'chat_guard_trip',
      layer: e.layer,
      detail: scrubParams(e.detail),
      user: e.user ?? null,
    }),
  );
}

const MAX_FIGURES = 10;

/**
 * F11: one line when an answer displayed figures that appear in none of the tool results (log-only, see number-check.ts).
 * Carries the counts and the offending figures ONLY: never the answer text and never the context around a figure.
 */
export function logNumberViolation(
  e: {violations: readonly {value: string}[]; checked: number; user?: string | null},
  sink: AuditSink = console,
): void {
  sink.info(
    JSON.stringify({
      event: 'chat_number_violation',
      count: e.violations.length,
      checked: e.checked,
      figures: e.violations.slice(0, MAX_FIGURES).map((v) => scrubParams(v.value)),
      user: e.user ?? null,
    }),
  );
}

export function logTurn(
  e: {
    steps: number;
    usage: {input: number; output: number; cacheRead: number; cacheWrite: number};
    ms: number;
    stopReason: string | null;
    /** Duration in ms of each model step and of each tool batch, in order. Numbers only. */
    stepMs?: readonly number[];
    toolMs?: readonly number[];
    user?: string | null;
  },
  sink: AuditSink = console,
): void {
  sink.info(
    JSON.stringify({
      event: 'chat_turn',
      steps: e.steps,
      usage: e.usage,
      ms: e.ms,
      stopReason: e.stopReason,
      step_ms: e.stepMs ?? [],
      tool_ms: e.toolMs ?? [],
      user: e.user ?? null,
      ts: new Date().toISOString(), // bursts vs gaps decide whether the 5-minute prompt cache is warm
    }),
  );
}

/** Spec 8: one line per run_query call. Shape and counts only: never the SQL, a literal, a row, a cell or the purpose text. */
export function logExploreQuery(
  e: {step: 'probe' | 'final' | null; ok: boolean; code: string | null; fingerprint: string | null; literalsHash: string | null; literalCount?: number | null; views?: readonly string[]; functions?: readonly string[]; outCols?: number | null; rows?: number | null; truncated?: boolean; bytes?: number | null; ms?: number | null; user?: string | null},
  sink: AuditSink = console,
): void {
  sink.info(
    JSON.stringify({
      event: 'chat_explore_query',
      step: e.step,
      ok: e.ok,
      code: e.code,
      fingerprint: e.fingerprint,
      literals_hash: e.literalsHash,
      literal_count: e.literalCount ?? null,
      views: e.views ?? [],
      functions: e.functions ?? [],
      out_cols: e.outCols ?? null,
      rows: e.rows ?? null,
      truncated: e.truncated ?? false,
      bytes: e.bytes ?? null,
      ms: e.ms ?? null,
      user: e.user ?? null,
    }),
  );
}

/** Train 4: one line per website CRM tool call. Endpoint ids, a params fingerprint and counts only: never a URL, a body, a row, a value or the token. */
export function logCrmCall(
  e: {tool: string; endpoints: readonly string[]; paramsFp: string; ok: boolean; code: string | null; rows: number | null; bytes: number | null; ms: number; user?: string | null},
  sink: AuditSink = console,
): void {
  sink.info(JSON.stringify({event: 'chat_crm_call', tool: e.tool, endpoints: e.endpoints, params_fp: e.paramsFp, ok: e.ok, code: e.code, rows: e.rows, bytes: e.bytes, ms: e.ms, user: e.user ?? null}));
}

/** Spec 8 (Task 7 review finding 8): one line per list_tables / describe_table call. Names only: never a column list or a row. */
export function logExploreSchema(e: {tool: 'list_tables' | 'describe_table'; ok: boolean; code: string | null; table?: string | null; domain?: string | null; user?: string | null}, sink: AuditSink = console): void {
  sink.info(JSON.stringify({event: 'chat_explore_schema', tool: e.tool, ok: e.ok, code: e.code, table: e.table ?? null, domain: e.domain ?? null, user: e.user ?? null}));
}

/** Spec 8: once per question when at least one final succeeded. The log the "promote repeated shapes to metrics" decision reads. */
export function logRegistryGap(e: {fingerprints: readonly string[]; views: readonly string[]; metricsTried: readonly string[]; user?: string | null}, sink: AuditSink = console): void {
  sink.info(JSON.stringify({event: 'chat_registry_gap', fingerprints: e.fingerprints, views: e.views, metrics_tried: e.metricsTried, user: e.user ?? null}));
}

/** Spec 8: the number check itself failed (never a dependency); the held text was shown unchecked. */
export function logNumberCheckFailed(e: {user?: string | null}, sink: AuditSink = console): void {
  sink.info(JSON.stringify({event: 'chat_number_check_failed', user: e.user ?? null}));
}

/** Spec 8: a fixed statement could not run (coverage line); reason code only. */
export function logExploreEvent(event: 'chat_explore_off' | 'chat_explore_coverage_failed', detail: {reason?: string; code?: string}, sink: AuditSink = console): void {
  sink.info(JSON.stringify({event, ...detail}));
}
