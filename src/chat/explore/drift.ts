// The latest daily drift result (spec 1.6; supabase/coop_chat_explore_direct.sql section 7), for /api/chat/health. Counts only: the
// findings' names stay in the database log. Fixed SQL written by code (not model SQL), run through the same read-only envelope as the
// probe. Never throws.
import type {RunQuery} from './executor';
import {wrapCursor} from './parse';

export const DRIFT_SQL = 'select d.checked_at, d.findings_count from coop_explore_drift_log d order by d.checked_at desc limit 1';
const STALE_MS = 36 * 3600_000; // the job runs daily; 36 h without a row means it stopped

export interface DriftStatus {
  checkedAt: string | null;
  findings: number | null;
  stale: boolean;
}

const UNKNOWN: DriftStatus = {checkedAt: null, findings: null, stale: true};

export async function loadDrift(runQuery: RunQuery, now: Date): Promise<DriftStatus> {
  try {
    const r = await runQuery(wrapCursor(DRIFT_SQL), {timeoutMs: 3000, maxRows: 1});
    const row = r.rows[0];
    if (!row) return UNKNOWN;
    const checkedAt = String(row[0]);
    const n = typeof row[1] === 'number' ? row[1] : Number.NaN;
    const t = Date.parse(checkedAt);
    return {checkedAt, findings: Number.isFinite(n) ? n : null, stale: !Number.isFinite(t) || now.getTime() - t > STALE_MS};
  } catch {
    return UNKNOWN;
  }
}
