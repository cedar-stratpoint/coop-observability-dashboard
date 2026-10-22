// Parses a Shopee Traffic Overview export (.xlsx): three sheets (All, PC, APP), each a one-row span summary and then one row per PH day.
// Visitors do not add up across days (they are unique per span), so only page views are checked against the summary. Columns by header name.
import {columnsOf, headerKey, loadWorkbook, sheetRows, toIsoDay, toIsoRange, toNumber, toSeconds} from './cells';
import type {ParsedTraffic, TrafficDay, TrafficPlatform} from './types';

const COLUMNS = {
  date: 'date', pageViews: 'pageviews', avgPageViews: 'avgpageviews', avgTime: 'avgtimespent', bounce: 'bouncerate', visitors: 'visitors',
  newVisitors: 'newvisitors', existingVisitors: 'existingvisitors', newFollowers: 'newfollowers',
} as const;
const SHEETS: Record<string, TrafficPlatform> = {all: 'all', pc: 'pc', app: 'app'};

export async function parseTraffic(bytes: ArrayBuffer | Uint8Array | Buffer): Promise<ParsedTraffic> {
  const wb = await loadWorkbook(bytes, 'Traffic Overview');
  const days: TrafficDay[] = [];
  const summaryPageViews: ParsedTraffic['summaryPageViews'] = {};
  let period: {from: string; to: string} | null = null;
  for (const ws of wb.worksheets) {
    const platform = SHEETS[headerKey(ws.name)];
    if (!platform) continue;
    const rows = sheetRows(ws);
    const heads = rows.map((r, i) => ({i, h: r.map(headerKey)})).filter(({h}) => h[0] === 'date');
    if (heads.length < 2) throw new Error(`Traffic Overview: sheet "${ws.name}" needs a summary table and a daily table.`);
    const [sumHead, dayHead] = heads;
    const sIdx = columnsOf(rows[sumHead.i], COLUMNS);
    const summary = rows.slice(sumHead.i + 1).find((r) => r.some((c) => c.trim() !== ''));
    const range = summary ? toIsoRange(summary[0] ?? '') : null;
    if (!summary || !range) throw new Error(`Traffic Overview: sheet "${ws.name}" has no readable summary date range.`);
    if (platform === 'all') period = range;
    const spv = sIdx.pageViews >= 0 ? toNumber(summary[sIdx.pageViews] ?? '') : null;
    if (spv !== null) summaryPageViews[platform] = spv;
    const idx = columnsOf(rows[dayHead.i], COLUMNS);
    if (idx.pageViews < 0 || idx.visitors < 0) throw new Error(`Traffic Overview: sheet "${ws.name}" has no page views or visitors column.`);
    for (const r of rows.slice(dayHead.i + 1)) {
      if (r.every((c) => c.trim() === '')) continue;
      const day = toIsoDay(r[0] ?? '');
      if (!day) throw new Error(`Traffic Overview: "${(r[0] ?? '').slice(0, 12)}" is not a date in sheet "${ws.name}".`);
      const o = (k: keyof typeof COLUMNS): number | null => (idx[k] >= 0 ? toNumber(r[idx[k]] ?? '') : null);
      days.push({
        day, platform, pageViews: o('pageViews') ?? 0, avgPageViews: o('avgPageViews'), avgTimeSeconds: idx.avgTime >= 0 ? toSeconds(r[idx.avgTime] ?? '') : null, bounceRate: o('bounce'),
        visitors: o('visitors') ?? 0, newVisitors: o('newVisitors'), existingVisitors: o('existingVisitors'), newFollowers: o('newFollowers'),
      });
    }
  }
  if (!period) throw new Error('This is not a Traffic Overview workbook (no "All" sheet).');
  return {periodFrom: period.from, periodTo: period.to, summaryPageViews, days};
}
