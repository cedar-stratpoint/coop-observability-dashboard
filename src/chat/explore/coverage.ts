// The per-turn Explore coverage line (spec 6.7). One FIXED statement, validated like any other, run once a minute per instance. Real figures live
// in the per-turn preamble (never the cached prefix), so they cannot go stale. If it fails the line is omitted and one log line is written.
import {logExploreEvent, type AuditSink} from '../audit';
import {dayLabel, type LeadFacts} from './basis';
import type {RunQuery} from './executor';
import type {ExploreLimits, ValidateErr, ValidateOk} from './types';

export const EXPLORE_COVERAGE_SQL = `with oc as (
  select min((o.created_at at time zone 'Asia/Manila')::date) filter (where o.status is distinct from 'voided') as orders_from,
         max((o.created_at at time zone 'Asia/Manila')::date) filter (where o.status is distinct from 'voided') as orders_to,
         count(*) filter (where o.status is distinct from 'voided') as completed_count,
         count(*) filter (where o.status = 'voided') as voided_count
  from coop_explore_orders o
), pf as (
  select min(o.created_at) as first_tagged,
         min((o.created_at at time zone 'Asia/Manila')::date) as first_tagged_day
  from coop_explore_orders o
  where o.status is distinct from 'voided' and o.pet_type is not null
), pt as (
  select count(*) as since_count, count(o.pet_type) as since_tagged
  from coop_explore_orders o
  join pf on o.created_at >= pf.first_tagged
  where o.status is distinct from 'voided'
), lc as (
  select min((l.collected_at at time zone 'Asia/Manila')::date) as leads_from,
         max((l.collected_at at time zone 'Asia/Manila')::date) as leads_to,
         count(*) as leads_count,
         count(*) filter (where l.pet is not null and l.pet <> '') as leads_with_pet,
         min((l.collected_at at time zone 'Asia/Manila')::date) filter (where l.pet is not null and l.pet <> '') as pet_from
  from coop_explore_event_leads l
)
select oc.orders_from, oc.orders_to, oc.completed_count, oc.voided_count, pf.first_tagged_day, pt.since_count, pt.since_tagged, lc.leads_from, lc.leads_to, lc.leads_count, lc.leads_with_pet, lc.pet_from
from oc join pf on oc.completed_count >= 0 join pt on oc.completed_count >= 0 join lc on oc.completed_count >= 0`;

const day = dayLabel;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Pure: the one-row result of EXPLORE_COVERAGE_SQL (in column order) -> the preamble line, or null when there is nothing to say. */
export function coverageLine(row: unknown[]): string | null {
  const [from, to, completed, voided, taggedDay, sinceCount, sinceTagged, lFrom, lTo, leads] = row;
  const parts: string[] = [];
  const d1 = day(from);
  const d2 = day(to);
  if (d1 && d2) parts.push(`Orders from ${d1} to ${d2} (${num(completed) ?? 0} completed, ${num(voided) ?? 0} voided)`);
  const d3 = day(taggedDay);
  const sc = num(sinceCount);
  const st = num(sinceTagged);
  if (d3 && sc && st !== null) parts.push(`pet tagged on ${Math.round((st / sc) * 100)}% of completed orders since ${d3}`);
  const d4 = day(lFrom);
  const d5 = day(lTo);
  if (d4 && d5) parts.push(`event leads from ${d4} to ${d5} (${num(leads) ?? 0} sign-ups, booth leads, not buyers)`);
  return parts.length ? `[explore coverage] ${parts.join('; ')}.` : null;
}

/** Pure: the same row -> the lead facts (all leads in the view), or null when there are no leads or the columns are missing. */
export function leadFactsOf(row: unknown[]): LeadFacts | null {
  const count = num(row[9]);
  const withPet = num(row[10]);
  if (!count || withPet === null) return null;
  return {count, withPet, petFrom: typeof row[11] === 'string' && day(row[11]) ? row[11].slice(0, 10) : null};
}

export interface CoverageDeps {
  runQuery: RunQuery;
  validate: (sql: unknown, limits?: Partial<ExploreLimits>) => Promise<ValidateOk | ValidateErr>;
  limits: ExploreLimits;
  sink?: AuditSink;
  clock?: () => number;
}

const TTL_MS = 60_000;
let memo: {at: number; line: string | null; leads: LeadFacts | null} | null = null;
export const resetCoverageCache = (): void => {
  memo = null;
};

/** One fixed coverage statement per minute per instance feeds both the preamble line and the lead facts. Never throws; a failure logs chat_explore_coverage_failed. */
async function loadCoverage(deps: CoverageDeps): Promise<{line: string | null; leads: LeadFacts | null}> {
  const now = (deps.clock ?? Date.now)();
  if (memo && now - memo.at < TTL_MS) return memo;
  try {
    const v = await deps.validate(EXPLORE_COVERAGE_SQL, deps.limits);
    if (!v.ok) throw new Error(v.code);
    const raw = await deps.runQuery(v.sent, {timeoutMs: deps.limits.timeoutMs, maxRows: 1});
    const row = raw.rows[0];
    memo = {at: now, line: row ? coverageLine(row) : null, leads: row ? leadFactsOf(row) : null};
    return memo;
  } catch (e) {
    logExploreEvent('chat_explore_coverage_failed', {code: e instanceof Error && /^E_[A-Z_]+$/.test(e.message) ? e.message : 'failed'}, deps.sink);
    return {line: null, leads: null};
  }
}

/** The line for the preamble, cached for one minute per instance. */
export const loadCoverageLine = async (deps: CoverageDeps): Promise<string | null> => (await loadCoverage(deps)).line;
/** The lead counts and the date pet was first collected, for the leads caveat (same cache). */
export const loadLeadFacts = async (deps: CoverageDeps): Promise<LeadFacts | null> => (await loadCoverage(deps)).leads;
