// The export windows a sync job covers, DERIVED from job.days (never stored): the worker exports one set of files per window, and the server
// accepts a file only if its filename period equals one of these windows (src/shopee-import/api.ts periodIsWindow). Same as Vince's weekly export:
//  - week: a closed Monday-Sunday week whose 7 days are ALL missing (By Week), all 5 files. Ads and SKU are stored per exact window and the Sales page
//    keeps only the newest Ads window, so they are only ever exported for a week that has nothing loaded yet.
//  - day: every other missing day (the open current week, or a week with some days already loaded), one By Day window each, sales_overview only.
import {mondayOf} from '../shopee-import/coverage';
import type {ReportType} from '../shopee-import/types';
import {phDay} from './missing-days';

export interface SyncWindow {
  kind: 'week' | 'day';
  from: string;
  to: string;
  files: ReportType[];
}
/** About 25 minutes of exporting; more stays for the next press or the Monday import. */
export const MAX_WEEK_WINDOWS = 4;
export const MAX_DAY_WINDOWS = 7;
export const WEEK_FILES: readonly ReportType[] = ['sales_overview', 'traffic', 'product_overview', 'ads', 'sku_detail'];
export const DAY_FILES: readonly ReportType[] = ['sales_overview'];
/** The most files one window can carry. */
export const MAX_FILES_PER_WINDOW = WEEK_FILES.length;

const DAY = 86_400_000;
const shift = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** The windows for `days`, and the days left out because of the caps (or because they are after yesterday). Nearest-to-today windows are kept; the output is oldest first, weeks then days. */
export function windowPlan(days: readonly string[], now: Date): {windows: SyncWindow[]; dropped: string[]} {
  const yesterday = shift(phDay(now), -1);
  const uniq = [...new Set(days)].sort();
  const have = new Set(uniq);
  const closed = uniq.filter((d) => d <= yesterday);
  const weekFrom = [...new Set(closed.map(mondayOf))].filter((m) => Array.from({length: 7}, (_, i) => shift(m, i)).every((d) => have.has(d) && d <= yesterday));
  const inWeek = (d: string): boolean => weekFrom.includes(mondayOf(d));
  const weeks = weekFrom.slice(-MAX_WEEK_WINDOWS);
  const single = closed.filter((d) => !inWeek(d)).slice(-MAX_DAY_WINDOWS);
  const windows: SyncWindow[] = [
    ...weeks.map((from): SyncWindow => ({kind: 'week', from, to: shift(from, 6), files: [...WEEK_FILES]})),
    ...single.map((d): SyncWindow => ({kind: 'day', from: d, to: d, files: [...DAY_FILES]})),
  ];
  return {windows, dropped: uniq.filter((d) => !windows.some((w) => d >= w.from && d <= w.to))};
}

export const windowsFor = (days: readonly string[], now: Date): SyncWindow[] => windowPlan(days, now).windows;

/** What the server accepts for a job: the windows at the time it was created and at the time of the call, so a sync that crosses midnight keeps working. */
export function issuedWindows(days: readonly string[], createdAt: string, now: Date): SyncWindow[] {
  const out = new Map<string, SyncWindow>();
  for (const w of [...windowsFor(days, new Date(createdAt)), ...windowsFor(days, now)]) out.set(`${w.kind}:${w.from}..${w.to}`, w);
  return [...out.values()];
}
