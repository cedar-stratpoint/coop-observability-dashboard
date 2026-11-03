// Closed weeks whose sales days are all loaded but whose weekly REPORT files (Ads, SKU) never were. Pure: give it the loaded days and the accepted report periods.
// Ads and SKU are stored per EXACT window and the Sales page keeps only the newest Ads window (it drops an older overlapping one whole), so a week is only
// ever requested when NO accepted window of that type touches any of its 7 days. An exact copy is "loaded"; an overlapping non-exact window is "not ours to fix".
import {mondayOf, reportsByWeek, weeksCoverage} from '../shopee-import/coverage';
import type {ReportPeriod} from '../shopee-import/pipeline';
import type {ReportType} from '../shopee-import/types';
import {finalFrom, oldestReachable, yesterdayPh} from './missing-days';
import type {SyncWindow} from './windows';

/** The weekly reports a sync can load for a week whose sales are already in. Traffic and Product Overview stay with the Monday import. */
export const REPORT_FILES = ['ads', 'sku_detail'] as const satisfies readonly ReportType[];
const DAY = 86_400_000;
const shift = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const weekDays = (monday: string): string[] => Array.from({length: 7}, (_, i) => shift(monday, i));

/** The report files of a week that no accepted window touches yet. */
export function missingWeekReports(monday: string, periods: readonly ReportPeriod[]): ReportType[] {
  const r = reportsByWeek(periods, [monday])[monday];
  return REPORT_FILES.filter((t) => r[t] === 'missing');
}

/** Mondays (oldest first) of closed, final, reachable weeks with all 7 sales days loaded and an Ads or SKU file missing. */
export function missingReportWeeks(loadedDays: readonly string[], periods: readonly ReportPeriod[], now: Date): string[] {
  const oldest = oldestReachable(now);
  return weeksCoverage(loadedDays, yesterdayPh(now))
    .filter((w) => w.status === 'complete' && w.weekStart >= mondayOf(oldest) && now.getTime() >= finalFrom(w.weekEnd) && missingWeekReports(w.weekStart, periods).length > 0)
    .map((w) => w.weekStart);
}

/**
 * What the worker is told to export: a week window whose 7 sales days are already loaded keeps only its missing Ads/SKU files, so nothing is paid for twice.
 * A week not fully loaded keeps all its files. If everything turned out to be loaded in the meantime the window keeps sales only (the worker would otherwise
 * fall back to the old by-day flow on an empty list); the import answers unchanged for it.
 */
export function wireWindows(windows: readonly SyncWindow[], loadedDays: readonly string[], periods: readonly ReportPeriod[]): SyncWindow[] {
  const have = new Set(loadedDays);
  return windows.map((w) => {
    if (w.kind !== 'week' || !weekDays(w.from).every((d) => have.has(d))) return w;
    const files = missingWeekReports(w.from, periods);
    return {...w, files: files.length ? files : ['sales_overview']};
  });
}

/** Window keys ("<from>..<to>/<type>") of the job's weeks whose Ads/SKU file is still missing, for the Done check. Only weeks inside the job that are still reachable. */
export function remainingReports(days: readonly string[], loadedDays: readonly string[], periods: readonly ReportPeriod[], now: Date): string[] {
  const inJob = new Set(days);
  const have = new Set(loadedDays);
  const oldest = mondayOf(oldestReachable(now));
  const out: string[] = [];
  for (const monday of [...new Set(days.map(mondayOf))].sort()) {
    const week = weekDays(monday);
    if (monday < oldest || !week.every((d) => inJob.has(d) && have.has(d))) continue;
    for (const t of missingWeekReports(monday, periods)) out.push(`${monday}..${week[6]}/${t}`);
  }
  return out;
}
