// Parses a Shopee Seller Centre "Sales Overview" export (.xlsx): one sheet holding two tables, a one-row summary for the span
// and then one row per PH day. Values are text with thousands separators and dates are DD/MM/YYYY. Columns are found by header
// name, never by position. Pure apart from reading the workbook bytes.
import ExcelJS from 'exceljs';
import {cellText as cell, headerKey, toIsoDay, toNumber as num} from './cells';
import type {DayFigures, ParsedSalesOverview} from './types';

export {toIsoDay};

// The By Week and By Day files word a few headers a little differently ("(PHP)" suffix, "Order" vs "Orders"), so headers are compared without those.
const key = (h: unknown): string => headerKey(h).replace(/php$/, '').replace(/orders/g, 'order');
const HOURLY = /^\d{1,2}\/\d{1,2}\/\d{4} \d{2}:\d{2}$/;

const COLUMNS = {
  visitors: 'visitorsvisit',
  buyersPlaced: 'buyersplacedorder',
  unitsPlaced: 'unitsplacedorder',
  ordersPlaced: 'orderplacedorder',
  salesPlaced: 'salesplacedorder',
  buyersConfirmed: 'buyersconfirmedorder',
  unitsConfirmed: 'unitsconfirmedorder',
  ordersConfirmed: 'orderconfirmedorder',
  salesConfirmed: 'salesconfirmedorder',
} as const;

export async function parseSalesOverview(bytes: ArrayBuffer | Uint8Array | Buffer): Promise<ParsedSalesOverview> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as ExcelJS.Buffer);
  } catch {
    throw new Error('This is not a Sales Overview workbook (it could not be read as .xlsx).');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('This is not a Sales Overview workbook (no sheet).');
  const rows: string[][] = [];
  ws.eachRow({includeEmpty: true}, (row) => rows.push((row.values as ExcelJS.CellValue[]).slice(1).map(cell)));

  const headers = rows.map((r, i) => ({i, h: r.map(key)})).filter(({h}) => h[0] === 'date');
  if (headers.length < 2) throw new Error('This is not a Sales Overview workbook (expected a summary table and a daily table).');
  const [summaryHead, dailyHead] = headers;

  const colIn = (h: string[], name: string): number => h.indexOf(name);
  const summaryRow = rows.slice(summaryHead.i + 1).find((r) => r.some((c) => c.trim() !== ''));
  const range = /^(\S+?)\s*-\s*(\S+)$/.exec((summaryRow?.[0] ?? '').trim());
  const periodFrom = range ? toIsoDay(range[1]) : null;
  const periodTo = range ? toIsoDay(range[2]) : null;
  if (!summaryRow || !periodFrom || !periodTo) throw new Error('Sales Overview: the summary row has no readable date range.');
  const sp = colIn(summaryHead.h, COLUMNS.salesPlaced);
  const sc = colIn(summaryHead.h, COLUMNS.salesConfirmed);
  if (sp < 0 || sc < 0) throw new Error('Sales Overview: the summary table has no placed or confirmed sales column.');

  const idx = Object.fromEntries(Object.entries(COLUMNS).map(([k, name]) => [k, colIn(dailyHead.h, name)])) as Record<keyof typeof COLUMNS, number>;
  for (const required of ['salesPlaced', 'salesConfirmed', 'ordersConfirmed', 'unitsConfirmed'] as const) {
    if (idx[required] < 0) throw new Error(`Sales Overview: the daily table has no "${required}" column.`);
  }
  const dailyRows = rows.slice(dailyHead.i + 1).filter((r) => !r.every((c) => c.trim() === ''));
  const hourly = dailyRows.length > 0 && dailyRows.every((r) => HOURLY.test((r[0] ?? '').trim()));
  const sum = (k: keyof typeof COLUMNS): number => dailyRows.reduce((t, r) => t + (num(r[idx[k]] ?? '') ?? 0), 0);
  if (hourly) {
    // The By Day export: 24 hourly rows for one day. Visitors and buyers are distinct people, so they are not additive over the hours and come from the summary row;
    // sales, orders and units are, and the sales must reproduce the summary or nothing imports.
    if (periodFrom !== periodTo) throw new Error(`Sales Overview: the daily table is hourly but the summary range is ${periodFrom} to ${periodTo} (a By Day file covers one day).`);
    const other = dailyRows.find((r) => toIsoDay((r[0] ?? '').trim().slice(0, -6)) !== periodFrom);
    if (other) throw new Error(`Sales Overview: hourly row "${other[0]}" is not on the summary day ${periodFrom}.`);
    const salesPlaced = sum('salesPlaced');
    const salesConfirmed = sum('salesConfirmed');
    const sPlaced = num(summaryRow[sp]);
    const sConf = num(summaryRow[sc]);
    if (sPlaced === null || sConf === null || Math.abs(salesPlaced - sPlaced) > 0.01 || Math.abs(salesConfirmed - sConf) > 0.01) {
      throw new Error(`Sales Overview: the hourly rows add up to ${salesPlaced} placed and ${salesConfirmed} confirmed, not the summary's ${sPlaced} and ${sConf}.`);
    }
    const at = (k: keyof typeof COLUMNS): number | null => (summaryHead.h.indexOf(COLUMNS[k]) >= 0 ? num(summaryRow[summaryHead.h.indexOf(COLUMNS[k])] ?? '') : null);
    const day: DayFigures = {
      day: periodFrom, salesPlaced, salesConfirmed, ordersPlaced: sum('ordersPlaced'), ordersConfirmed: sum('ordersConfirmed'), unitsPlaced: sum('unitsPlaced'), unitsConfirmed: sum('unitsConfirmed'),
      buyersPlaced: at('buyersPlaced'), buyersConfirmed: at('buyersConfirmed'), visitors: at('visitors'),
    };
    return {periodFrom, periodTo, summary: {salesPlaced: sPlaced, salesConfirmed: sConf}, days: [day]};
  }
  const days: DayFigures[] = [];
  for (const r of rows.slice(dailyHead.i + 1)) {
    if (r.every((c) => c.trim() === '')) continue;
    const iso = toIsoDay(r[0] ?? '');
    if (!iso) throw new Error(`Sales Overview: "${r[0]}" is not a date in the daily table.`);
    const n = (k: keyof typeof COLUMNS): number | null => (idx[k] >= 0 ? num(r[idx[k]] ?? '') : null);
    const need = (k: keyof typeof COLUMNS): number => {
      const v = n(k);
      if (v === null) throw new Error(`Sales Overview: ${iso} has no number in "${k}".`);
      return v;
    };
    days.push({
      day: iso,
      salesPlaced: need('salesPlaced'),
      salesConfirmed: need('salesConfirmed'),
      ordersPlaced: n('ordersPlaced') ?? 0,
      ordersConfirmed: need('ordersConfirmed'),
      unitsPlaced: n('unitsPlaced') ?? 0,
      unitsConfirmed: need('unitsConfirmed'),
      buyersPlaced: n('buyersPlaced'),
      buyersConfirmed: n('buyersConfirmed'),
      visitors: n('visitors'),
    });
  }
  return {periodFrom, periodTo, summary: {salesPlaced: num(summaryRow[sp]) ?? NaN, salesConfirmed: num(summaryRow[sc]) ?? NaN}, days};
}
