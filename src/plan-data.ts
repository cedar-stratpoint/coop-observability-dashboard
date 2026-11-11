import 'server-only';
import {cache} from 'react';
import {unstable_cache} from 'next/cache';
import {createClient} from '@supabase/supabase-js';
import {assemblePlan, PLAN_MONTHS, GAP, ALL_LINE_IDS, type ActualCell, type ClosedMonth, type ClosedTargetRow, type LineSeries, type PlanData, type PlanTargetRow} from './plan-compute';
import {eventsCells, marketplaceCells, totalCells, websiteCells} from './plan-gmv';
import {getDigests} from './data';
import {getPosEvents, getPosOrders} from './pos-sales';
import {getCrmOrdersForPlan} from './crm-data';
import {getMarketplaceDaily} from './marketplace-daily-data';
import {dailyRowsToDigests} from './daily-sales-digests';
import {rollupChannels} from './period-rollup';
import {phDay} from './custom-range';
import {fetchAllRows} from './pos-fetch-paginate';

// SERVER-ONLY read seam for the Business Health Report's PLAN (targets only; actuals arrive in BHR-02/03). Service-role, archive project,
// no dependence on the caller's company context: the page guard (requireHealthReportAccess) decides who may see it, so a Coop Admin works.
// Mock mode (env unset) and a not-yet-applied or empty database render the page with EMPTY targets and a banner. The repo holds no plan figure:
// the targets are loaded privately from the workbook by scripts/seed-plan-from-workbook.mjs.
const url = process.env.SUPABASE_URL_ARCHIVE;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY_ARCHIVE;

export const PLAN_TAG = 'plan-report';

export const usingPlanMock = (): boolean => !url || !serviceKey;

/** The page with no targets (every target a gap): the plan months only. */
export function emptyPlan(notice: string): PlanData {
  return {...assemblePlan('No targets loaded', [], null, PLAN_MONTHS), source: 'seed', notice};
}

const readPlan = unstable_cache(
  async (): Promise<PlanData> => {
    const sb = createClient(url as string, serviceKey as string, {auth: {persistSession: false}});
    const v = await sb.from('plan_versions').select('id,label').order('id', {ascending: false}).limit(1);
    if (v.error) {
      // 42P01 / PGRST205: the SQL was never applied here. Say so instead of crashing the page.
      if (v.error.code === '42P01' || v.error.code === 'PGRST205') return emptyPlan('The plan tables are not applied on this database yet (supabase/plan_report.sql). No targets are shown.');
      throw new Error(`plan_versions read failed: ${v.error.message}`);
    }
    const version = v.data?.[0];
    if (!version) return emptyPlan('No plan targets are loaded on this database yet (run scripts/seed-plan-from-workbook.mjs). No targets are shown.');
    const rows = await fetchAllRows('plan_targets', (from, to) =>
      sb.from('plan_targets').select('month,metric,value').eq('plan_version', version.id).order('month', {ascending: true}).order('metric', {ascending: true}).range(from, to));
    const plan = assemblePlan(version.label as string, rows as unknown as PlanTargetRow[], Number(version.id));
    return plan;
  },
  ['plan-report'],
  {revalidate: 60, tags: [PLAN_TAG]},
);

export const getPlan = cache(async (): Promise<PlanData> => {
  if (usingPlanMock()) return emptyPlan('Demo mode: no database is connected, so there are no targets or results to show.');
  return readPlan();
});

// ---- BHR-02: real GMV actuals --------------------------------------------------------------------------------------------------
// Computed at read time from Coop's own readers, one soft read per source: a source that fails, is not configured, or is truncated
// is a GAP for its channel (empty cell, "waiting"), never PHP 0 and never an understated number. Mock mode has no real data, so every
// actual is a gap there: the page never shows demo money as a result.
async function soft<T>(read: () => Promise<T>, what: string): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    console.warn(`plan actuals: ${what} read failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export type GmvActuals = Record<'gmv_events' | 'gmv_website' | 'gmv_marketplace' | 'gmv_total', ActualCell[]>;

export const noGmvActuals = (months: readonly string[]): GmvActuals => {
  const gaps = months.map(() => GAP);
  return {gmv_events: gaps, gmv_website: gaps, gmv_marketplace: gaps, gmv_total: gaps};
};

export async function getGmvActuals(months: readonly string[], nowKey: string): Promise<GmvActuals> {
  return (await getGmvActualsSynced(months, nowKey)).gmv;
}

/** getGmvActuals plus when the Website orders were last read from the CRM Worker (BHR-09: they sync on Refresh). Null = not read. */
export async function getGmvActualsSynced(months: readonly string[], nowKey: string): Promise<{gmv: GmvActuals; webSyncedAt: string | null}> {
  if (usingPlanMock() || months.length === 0) return {gmv: noGmvActuals(months), webSyncedAt: null};
  const today = phDay(Date.now());
  const fromDay = `${months[0].slice(0, 7)}-01`;
  const [orders, events, digests, daily, crm] = await Promise.all([
    soft(getPosOrders, 'pos_orders'), soft(getPosEvents, 'pos_events'), soft(getDigests, 'digest_archive'), soft(getMarketplaceDaily, 'marketplace_daily_sales'),
    soft(() => getCrmOrdersForPlan(fromDay), 'crm orders'),
  ]);
  const pos = orders && events ? {orders, events} : null;
  // Same definition as the Sales page: stored digests' per-day figures plus the backend's per-day rows, merged by rollupChannels.
  let buckets = null;
  if (digests && fromDay <= today) {
    try {
      buckets = rollupChannels({fromDay, toDay: today, channels: ['shopee', 'lazada'], granularity: 'month', digests: [...digests, ...dailyRowsToDigests(daily ?? [])], website: null, offline: null});
    } catch (error) {
      console.warn(`plan actuals: marketplace rollup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const gmv_events = eventsCells(months, nowKey, pos);
  const gmv_website = websiteCells(months, nowKey, crm);
  const gmv_marketplace = marketplaceCells(months, nowKey, buckets);
  return {gmv: {gmv_events, gmv_website, gmv_marketplace, gmv_total: totalCells([gmv_events, gmv_website, gmv_marketplace])}, webSyncedAt: crm?.syncedAt ?? null};
}

// ---- BHR-03: typed monthly lines ------------------------------------------------------------------------------------------------
/** The service-role client for plan writes (the RPCs). Null in mock mode: nothing is saved there. */
export function planClient() {
  return usingPlanMock() ? null : createClient(url as string, serviceKey as string, {auth: {persistSession: false}});
}

/**
 * The typed lines (the workbook's input rows: costs, stock bought, funding, one-time payments, and ROAS) by plan month (pesos, null = empty). Never cached: a person just typed it. Null when the read failed or the table is
 * not applied: the page then shows no typed numbers and no inputs (it never lets someone type blind over values it could not read).
 */
export async function getTypedLines(months: readonly string[]): Promise<{lines: LineSeries} | null> {
  const lines: Record<string, (number | null)[]> = Object.fromEntries(ALL_LINE_IDS.map((id) => [id, months.map(() => null)]));
  const sb = planClient();
  if (!sb) return {lines}; // mock mode: nothing typed, nothing saved
  try {
    const rows = await fetchAllRows('plan_actuals', (from, to) => sb.from('plan_actuals').select('month,metric,amount_php').order('month', {ascending: true}).order('metric', {ascending: true}).range(from, to));
    for (const r of rows as unknown as Array<{month: string; metric: string; amount_php: number | string}>) {
      const i = months.indexOf(r.month);
      if (i >= 0 && lines[r.metric]) lines[r.metric][i] = Number(r.amount_php);
    }
    return {lines};
  } catch (error) {
    console.warn(`plan actuals: typed lines read failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}


// ---- BHR-04: closed months --------------------------------------------------------------------------------------------------------
/** Closed months by 'YYYY-MM-01', never cached. Null when the read failed: the page then shows no close controls (and no inputs). */
export async function getMonthCloses(): Promise<Record<string, ClosedMonth> | null> {
  const sb = planClient();
  if (!sb) return {};
  try {
    const rows = await fetchAllRows('plan_month_closes', (from, to) => sb.from('plan_month_closes').select('month,plan_version,closed_by,closed_at,gmv_snapshot').order('month', {ascending: true}).range(from, to));
    return Object.fromEntries((rows as unknown as Array<{month: string; plan_version: number; closed_by: string; closed_at: string; gmv_snapshot: Record<string, ActualCell>}>)
      .map((r) => [r.month, {by: r.closed_by, at: r.closed_at, planVersion: Number(r.plan_version), gmv: r.gmv_snapshot ?? {}} satisfies ClosedMonth]));
  } catch (error) {
    console.warn(`plan actuals: month closes read failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ---- BHR-05: plan versions ---------------------------------------------------------------------------------------
/** Targets of the versions the closed months closed under, for those months only (a closed month is judged against its own version). Never cached. */
export async function getClosedTargets(closes: Readonly<Record<string, ClosedMonth>>): Promise<ClosedTargetRow[]> {
  const sb = planClient();
  const months = Object.keys(closes);
  if (!sb || months.length === 0) return [];
  try {
    const versions = [...new Set(Object.values(closes).map((c) => c.planVersion))];
    const rows = await fetchAllRows('plan_targets', (from, to) => sb.from('plan_targets').select('plan_version,month,metric,value').in('plan_version', versions).in('month', months).order('plan_version').order('month').order('metric').range(from, to));
    return rows as unknown as ClosedTargetRow[];
  } catch (error) {
    console.warn(`plan targets: closed-month versions read failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

export interface PlanVersionInfo {id: number; label: string; reason: string | null; by: string | null; at: string}
/** The newest plan versions (who, when, why), newest first. Empty when unreadable. */
export async function getPlanVersions(limit = 8): Promise<PlanVersionInfo[]> {
  const sb = planClient();
  if (!sb) return [];
  const {data, error} = await sb.from('plan_versions').select('id,label,reason,created_by,created_at').order('id', {ascending: false}).limit(limit);
  if (error) { console.warn(`plan versions read failed: ${error.message}`); return []; }
  return (data ?? []).map((r) => ({id: Number(r.id), label: r.label as string, reason: (r.reason as string | null) ?? null, by: (r.created_by as string | null) ?? null, at: r.created_at as string}));
}
