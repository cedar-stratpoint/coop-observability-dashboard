// Which weeks (Monday to Sunday, PH) have figures and which days of them are missing. Pure: give it the loaded days.
export interface WeekCoverage {
  weekStart: string; // Monday
  weekEnd: string; // Sunday
  daysLoaded: number;
  missing: string[];
  status: 'complete' | 'partial' | 'missing';
}

const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const ms = (d: string): number => Date.parse(`${d}T00:00:00Z`);
const mondayOf = (d: string): string => iso(ms(d) - ((new Date(ms(d)).getUTCDay() + 6) % 7) * DAY);

/** From the first loaded week to the week of `through` (default: the last loaded day). */
export function weeksCoverage(loadedDays: readonly string[], through?: string): WeekCoverage[] {
  if (loadedDays.length === 0) return [];
  const have = new Set(loadedDays);
  const sorted = [...have].sort();
  const start = ms(mondayOf(sorted[0]));
  const end = ms(mondayOf(through ?? sorted[sorted.length - 1]));
  const out: WeekCoverage[] = [];
  for (let w = start; w <= end; w += 7 * DAY) {
    const days = Array.from({length: 7}, (_, i) => iso(w + i * DAY));
    const missing = days.filter((d) => !have.has(d) && (!through || d <= through));
    const loaded = days.filter((d) => have.has(d)).length;
    out.push({weekStart: days[0], weekEnd: days[6], daysLoaded: loaded, missing, status: loaded === 0 ? 'missing' : missing.length === 0 ? 'complete' : 'partial'});
  }
  return out;
}

// ── the four snapshot reports, per week ───────────────────────────────────────────────────────────────────────────────────────
export type ReportWeekStatus = 'full' | 'partial' | 'missing';
const REPORTS = ['ads', 'sku_detail', 'traffic', 'product_overview'] as const;
export type ReportKind = (typeof REPORTS)[number];

/**
 * For each week, whether an accepted import of each snapshot report covers it: `full` when the imports' periods together cover all 7 days,
 * `partial` when some days, `missing` when none. Pure: give it the accepted periods.
 */
export function reportsByWeek(periods: readonly {reportType: ReportKind; periodFrom: string; periodTo: string}[], weekStarts: readonly string[]): Record<string, Record<ReportKind, ReportWeekStatus>> {
  const out: Record<string, Record<ReportKind, ReportWeekStatus>> = {};
  for (const weekStart of weekStarts) {
    const days = Array.from({length: 7}, (_, i) => iso(ms(weekStart) + i * DAY));
    out[weekStart] = Object.fromEntries(
      REPORTS.map((type) => {
        const covered = days.filter((d) => periods.some((p) => p.reportType === type && p.periodFrom <= d && p.periodTo >= d)).length;
        return [type, covered === 7 ? 'full' : covered === 0 ? 'missing' : 'partial'];
      }),
    ) as Record<ReportKind, ReportWeekStatus>;
  }
  return out;
}
