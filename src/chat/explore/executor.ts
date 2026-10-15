// The run_query executor (spec 3.2). No `server-only` and no driver import: the driver (`runQuery`) and the validator are injected, so
// vitest drives it with a fake. Order per call: count -> input -> validate (exact string that will be sent) -> run -> shape -> store.
import {logExploreQuery, logGuardTrip, type AuditSink} from '../audit';
import type {MetricResult} from '../result-types';
import {GuardTripError} from '../tools';
import {ExploreDbError, mapDbError} from './errors';
import type {LeadFacts} from './basis';
import {shapeResult, type RawQueryResult} from './result';
import {baseRelation} from './views';
import {EXPLORE_ERROR_CLASS, EXPLORE_ERROR_MESSAGES, type ExploreErrorCode, type ExploreLimits, type ValidateErr, type ValidateOk} from './types';

export type {RawQueryResult} from './result';
export type RunQuery = (sentSql: string, opts: {timeoutMs: number; maxRows: number}) => Promise<RawQueryResult>;

export interface ExploreDeps {
  runQuery: RunQuery;
  validate: (sql: unknown, limits?: Partial<ExploreLimits>) => Promise<ValidateOk | ValidateErr>;
  limits: ExploreLimits;
  now: Date;
  user: string | null;
  store: {set(id: string, r: MetricResult): void};
  sink?: AuditSink;
  /** Fixed lead coverage figures (cached by the Integrator); only awaited when a result reads the leads view. Must not throw. */
  leadFacts?: () => Promise<LeadFacts | null>;
  /** The per-user daily gate (route level). Returns false when today's allowance is used up; called once per call that reaches the database. */
  dayGate?: () => boolean;
}

export interface ExploreExecutor {
  (input: unknown): Promise<unknown>;
  /** Fingerprints and views of the finals that succeeded, for chat_registry_gap. */
  gap(): {fingerprints: string[]; views: string[]};
}

const refuse = (code: ExploreErrorCode, at?: number): {error: string} => ({
  error: `${code}: ${code === 'E_SYNTAX' && at !== undefined ? EXPLORE_ERROR_MESSAGES.E_SYNTAX.replace('<n>', String(at)) : EXPLORE_ERROR_MESSAGES[code]}`,
});

export function createExploreExecutor(deps: ExploreDeps): ExploreExecutor {
  const {limits, sink} = deps;
  let calls = 0;
  let finals = 0;
  let softTrips = 0;
  const fingerprints: string[] = [];
  const views = new Set<string>();

  const exec = async (input: unknown): Promise<unknown> => {
    calls += 1;
    if (calls > limits.maxCallsPerQuestion) return refuse('E_CALLS');
    const i = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
    if (!i || typeof i.purpose !== 'string' || typeof i.sql !== 'string' || (i.step !== 'probe' && i.step !== 'final')) {
      logExploreQuery({step: null, ok: false, code: 'E_INPUT', fingerprint: null, literalsHash: null, user: deps.user}, sink);
      return refuse('E_INPUT');
    }
    const step = i.step;

    const v = await deps.validate(i.sql, limits);
    if (!v.ok) {
      logExploreQuery({step, ok: false, code: v.code, fingerprint: null, literalsHash: null, user: deps.user}, sink);
      if (v.trip === 'hard' || EXPLORE_ERROR_CLASS[v.code] === 'H') throw new GuardTripError('explore_parser', v.code);
      if (v.trip === 'soft' || EXPLORE_ERROR_CLASS[v.code] === 'S') {
        softTrips += 1;
        logGuardTrip({layer: 'explore_parser', detail: {code: v.code, class: 'soft'}, user: deps.user, level: 'warn'}, sink);
        if (softTrips >= 2) throw new GuardTripError('explore_parser', v.code); // a second soft trip ends the turn
      }
      return refuse(v.code, v.at);
    }

    if (deps.dayGate && !deps.dayGate()) return refuse('E_RATE_DAY');

    let raw: RawQueryResult;
    try {
      raw = await deps.runQuery(v.sent, {timeoutMs: limits.timeoutMs, maxRows: limits.maxRows});
    } catch (e) {
      const code = e instanceof ExploreDbError ? e.code : mapDbError((e as {code?: unknown})?.code);
      logExploreQuery({step, ok: false, code, fingerprint: v.fingerprint, literalsHash: v.literalsHash, views: v.relations, functions: v.functions, user: deps.user}, sink);
      if (code === 'E_DB_DENIED') throw new GuardTripError('explore_db', code);
      return refuse(code);
    }

    const id = step === 'final' ? `x${finals + 1}` : null;
    const leadFacts = id && v.relations.some((r) => baseRelation(r) === 'spin_wheel_leads') && deps.leadFacts ? await deps.leadFacts().catch(() => null) : null;
    const shaped = shapeResult({raw, validated: v, limits, id, leadFacts});
    if (!shaped.ok) {
      logExploreQuery({step, ok: false, code: shaped.code, fingerprint: v.fingerprint, literalsHash: v.literalsHash, views: v.relations, user: deps.user}, sink);
      return refuse(shaped.code);
    }
    logExploreQuery(
      {
        step, ok: true, code: null, fingerprint: v.fingerprint, literalsHash: v.literalsHash, views: v.relations, functions: v.functions,
        outCols: shaped.result.columns.length, rows: shaped.result.rows.length, truncated: raw.fetched > shaped.result.rows.length,
        bytes: JSON.stringify(shaped.result.rows).length, ms: raw.ms, user: deps.user,
      },
      sink,
    );
    if (id) {
      finals += 1;
      deps.store.set(id, shaped.result);
      fingerprints.push(v.fingerprint);
      for (const r of v.relations) views.add(r);
    }
    return shaped.payload;
  };
  return Object.assign(exec, {gap: () => ({fingerprints: [...fingerprints], views: [...views]})});
}
