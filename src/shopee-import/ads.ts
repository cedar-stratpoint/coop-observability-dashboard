// Parses a Shopee "All CPC Ads Report" export (.csv): a few header lines (user, shop, report time, date period), a blank line, then one row per
// campaign for the whole period. Columns are found by header name. Pure.
import {parseCsv} from '../goldline-csv';
import {headerKey, toIsoRange, toNumber} from './cells';
import type {AdsRow, ParsedAds} from './types';

const COLUMNS = {
  adName: 'adname', status: 'status', adsType: 'adstype', impressions: 'impression', clicks: 'clicks', conversions: 'conversions', directConversions: 'directconversions',
  itemsSold: 'itemssold', gmv: 'gmv', directGmv: 'directgmv', expense: 'expense',
} as const;

/** "28/09/2026 10:25" (PH time) to an ISO instant. */
function creationTime(raw: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/.exec(raw.trim());
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${m[4].padStart(2, '0')}:${m[5]}:00+08:00` : null;
}

export function parseAds(bytes: Uint8Array | Buffer): ParsedAds {
  const text = Buffer.from(bytes).toString('utf8').replace(/^﻿/, '');
  const rows = parseCsv(text);
  const head = rows.findIndex((r) => headerKey(r[0]) === 'sequence');
  if (head < 0 || !rows.some((r) => headerKey(r[0]).includes('cpcadsreport') || headerKey(r[0]).includes('adsreport'))) throw new Error('This is not a Shopee CPC ads report (no report title or column header found).');
  const meta = new Map(rows.slice(0, head).map((r) => [headerKey(r[0]), r[1] ?? '']));
  const period = toIsoRange(meta.get('dateperiod') ?? '');
  if (!period) throw new Error('Ads report: the "Date Period" line has no readable dates.');
  const h = rows[head].map(headerKey);
  const idx = Object.fromEntries(Object.entries(COLUMNS).map(([k, name]) => [k, h.indexOf(name)])) as Record<keyof typeof COLUMNS, number>;
  for (const required of ['adName', 'expense', 'gmv'] as const) if (idx[required] < 0) throw new Error(`Ads report: no "${required}" column.`);
  const out: AdsRow[] = [];
  for (const r of rows.slice(head + 1)) {
    const n = (k: keyof typeof COLUMNS): number => (idx[k] >= 0 ? toNumber(r[idx[k]] ?? '') ?? 0 : 0);
    const s = (k: keyof typeof COLUMNS): string | null => (idx[k] >= 0 && (r[idx[k]] ?? '').trim() !== '' ? r[idx[k]].trim() : null);
    const name = s('adName');
    if (!name) continue;
    out.push({adName: name, adsType: s('adsType'), status: s('status'), impressions: n('impressions'), clicks: n('clicks'), conversions: n('conversions'), directConversions: n('directConversions'), itemsSold: n('itemsSold'), gmv: n('gmv'), directGmv: n('directGmv'), expense: n('expense')});
  }
  return {periodFrom: period.from, periodTo: period.to, exportedAt: creationTime(meta.get('reportcreationtime') ?? ''), rows: out};
}
