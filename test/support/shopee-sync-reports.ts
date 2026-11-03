// Report periods for sync tests: an exact Mon-Sun Ads and SKU window for every week whose 7 days are all in `days` (the "nothing is missing" archive).
import {mondayOf} from '../../src/shopee-import/coverage';
import type {ReportPeriod} from '../../src/shopee-import/pipeline';

const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function exactReports(days: readonly string[], types: readonly ReportPeriod['reportType'][] = ['ads', 'sku_detail']): ReportPeriod[] {
  const have = new Set(days);
  return [...new Set(days.map(mondayOf))]
    .filter((m) => Array.from({length: 7}, (_, i) => iso(Date.parse(`${m}T00:00:00Z`) + i * DAY)).every((d) => have.has(d)))
    .flatMap((m) => types.map((reportType): ReportPeriod => ({reportType, periodFrom: m, periodTo: iso(Date.parse(`${m}T00:00:00Z`) + 6 * DAY)})));
}
