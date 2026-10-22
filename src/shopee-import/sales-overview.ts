// Parses a Shopee Seller Centre "Sales Overview" export (.xlsx): one sheet holding two tables, a one-row summary for the span
// and then one row per PH day. Values are text with thousands separators and dates are DD/MM/YYYY. Columns are found by header
// name, never by position. Pure apart from reading the workbook bytes.
import ExcelJS from 'exceljs';
import {cellText as cell, headerKey as key, toIsoDay, toNumber as num} from './cells';
import type {DayFigures, ParsedSalesOverview} from './types';

export {toIsoDay};

const COLUMNS = {
  visitors: 'visitorsvisit',
  buyersPlaced: 'buyersplacedorders',
  unitsPlaced: 'unitsplacedorders',
  ordersPlaced: 'ordersplacedorders',
  salesPlaced: 'salesplacedordersphp',
  buyersConfirmed: 'buyersconfirmedorders',
  unitsConfirmed: 'unitsconfirmedorders',
  ordersConfirmed: 'ordersconfirmedorders',
  salesConfirmed: 'salesconfirmedordersphp',
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
