// The export windows a sync job covers, DERIVED from job.days (never stored): the worker exports one set of files per window, and the server
// accepts a file only if its filename period equals one of these windows (src/shopee-import/api.ts periodIsWindow).
//  - past7: the last 7 closed days, the 3 daily files only (sales, traffic, product). Ads and SKU are stored per exact window and the Sales page keeps
//    only the newest Ads window, so an Ads/SKU file that overlaps one already loaded would lose data: they never go in a past7 window.
//  - week: one Monday-Sunday week (By Week) for older missing days, all 5 files. Only closed weeks can occur: a day older than Y-6 belongs to a week whose Sunday is <= Y.
import {mondayOf} from '../shopee-import/coverage';
import type {ReportType} from '../shopee-import/types';
import {phDay} from './missing-days';

export interface SyncWindow {
  kind: 'past7' | 'week';
  from: string;
  to: string;
  files: ReportType[];
}
/** About 25 minutes of exporting; more stays for the Monday import. */
export const MAX_WINDOWS = 4;
export const DAILY_FILES: readonly ReportType[] = ['sales_overview', 'traffic', 'product_overview'];
export const WEEK_FILES: readonly ReportType[] = [...DAILY_FILES, 'ads', 'sku_detail'];
/** The most files one window can carry. */
export const MAX_FILES_PER_WINDOW = WEEK_FILES.length;

const DAY = 86_400_000;
const shift = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** The windows for `days`, and the days left out because of MAX_WINDOWS (or because they are after yesterday). Oldest week first, past7 last; the newest windows are the ones dropped. */
export function windowPlan(days: readonly string[], now: Date): {windows: SyncWindow[]; dropped: string[]} {
  const yesterday = shift(phDay(now), -1);
  const lo = shift(yesterday, -6);
  const uniq = [...new Set(days)].sort();
  const recent = uniq.filter((d) => d >= lo && d <= yesterday);
  const weeks = [...new Set(uniq.filter((d) => d < lo).map(mondayOf))].sort();
  const all: SyncWindow[] = [
    ...weeks.map((from): SyncWindow => ({kind: 'week', from, to: shift(from, 6), files: [...WEEK_FILES]})),
    ...(recent.length > 0 ? [{kind: 'past7', from: lo, to: yesterday, files: [...DAILY_FILES]} as SyncWindow] : []),
  ];
  const windows = all.slice(0, MAX_WINDOWS);
  return {windows, dropped: uniq.filter((d) => !windows.some((w) => d >= w.from && d <= w.to))};
}

export const windowsFor = (days: readonly string[], now: Date): SyncWindow[] => windowPlan(days, now).windows;

/** What the server accepts for a job: the windows at the time it was created and at the time of the call, so a sync that crosses midnight keeps working. */
export function issuedWindows(days: readonly string[], createdAt: string, now: Date): SyncWindow[] {
  const out = new Map<string, SyncWindow>();
  for (const w of [...windowsFor(days, new Date(createdAt)), ...windowsFor(days, now)]) out.set(`${w.kind}:${w.from}..${w.to}`, w);
  return [...out.values()];
}
