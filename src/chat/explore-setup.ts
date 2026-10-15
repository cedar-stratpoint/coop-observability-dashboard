// Route glue for Explore (spec 10.5): decide access fail-closed, build the executor, the coverage line and the tool list. The only module
// outside src/chat/explore/ that imports client.ts. Nothing here runs unless resolveExploreAccess says `enabled`.
import 'server-only';
import {logExploreEvent, type AuditSink} from './audit';
import {createRunQuery} from './explore/client';
import {loadDrift, type DriftStatus} from './explore/drift';
import {loadCoverageLine, loadLeadFacts} from './explore/coverage';
import {createExploreExecutor, type ExploreExecutor, type RunQuery} from './explore/executor';
import {resolveExploreAccess} from './explore/config';
import {describeExploreEnv} from './health';
import {probeExplore, type ExploreProbe} from './explore/probe';
import {validateExploreSql} from './explore/parse';
import {createLiveValidator, createSchemaTools, listOpenTables, type SchemaTools} from './explore/schema-tools';
import {catalogTable} from './catalog';
import {exploreDayCounter} from './explore/rate';
import type {ExploreEnv} from './explore/types';
import type {MetricResult} from './result-types';

export interface ExploreSetup {
  executor: ExploreExecutor;
  coverageLine: () => Promise<string | null>;
  schema: SchemaTools;
}

let offLogged = false;

/** null = Explore is off for this request (the tool is not sent, the prompt block is not added). Never throws. */
export function setupExplore(args: {env: ExploreEnv; email: string | null; now: Date; user: string | null; store: {set(id: string, r: MetricResult): void}; sink?: AuditSink; runQuery?: RunQuery}): ExploreSetup | null {
  try {
    const access = resolveExploreAccess(args.env, args.email);
    if (!access.enabled) {
      if (!offLogged) {
        offLogged = true;
        logExploreEvent('chat_explore_off', {reason: access.reason}, args.sink);
      }
      return null;
    }
    const runQuery = args.runQuery ?? createRunQuery(access);
    const {limits} = access;
    const dayGate = () => exploreDayCounter(args.user, limits.maxPerUserDay, args.now); // one allowance for run_query and the schema tools
    const executor = createExploreExecutor({
      runQuery, validate: createLiveValidator(runQuery), limits, now: args.now, user: args.user, store: args.store, sink: args.sink,
      leadFacts: () => loadLeadFacts({runQuery, validate: validateExploreSql, limits, sink: args.sink}),
      dayGate,
    });
    const schema = createSchemaTools(runQuery, {user: args.user, sink: args.sink, dayGate});
    return {executor, coverageLine: () => loadCoverageLine({runQuery, validate: validateExploreSql, limits, sink: args.sink}), schema};
  } catch {
    return null; // fail closed
  }
}

/**
 * The `explore` object of /api/chat/health for the signed-in person: whether Explore is on for THEM (reason code if not), flags without
 * values, and, only when enabled, one fixed probe and the latest drift count through the real read-only envelope. Never throws; never echoes a URL, list or driver text.
 */
export async function exploreHealth(env: ExploreEnv, email: string | null, deps: {runQuery?: RunQuery} = {}): Promise<{enabled: boolean; reason?: string; probe?: ExploreProbe; drift?: DriftStatus; uncatalogued?: number | null} & ReturnType<typeof describeExploreEnv>> {
  const flags = describeExploreEnv(env);
  try {
    const access = resolveExploreAccess(env, email);
    if (!access.enabled) return {enabled: false, reason: access.reason, ...flags};
    let probe: ExploreProbe;
    let drift: DriftStatus;
    let uncatalogued: number | null = null;
    try {
      const runQuery = deps.runQuery ?? createRunQuery(access);
      probe = await probeExplore(runQuery);
      drift = await loadDrift(runQuery, new Date()); // the daily drift job's newest row: time and count only (spec 1.6)
      // open live tables the data catalog does not describe yet (a count, never names)
      uncatalogued = await listOpenTables(runQuery).then((ts) => ts.filter((t) => !catalogTable(t.name)).length).catch(() => null);
    } catch {
      probe = {ok: false, code: 'other'};
      drift = {checkedAt: null, findings: null, stale: true};
    }
    return {enabled: true, ...flags, probe, drift, uncatalogued};
  } catch {
    return {enabled: false, reason: 'url_invalid', ...flags};
  }
}
