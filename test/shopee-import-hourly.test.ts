import ExcelJS from 'exceljs';
import {describe, expect, it} from 'vitest';
import {planFile} from '../src/shopee-import/pipeline';
import {parseSalesOverview} from '../src/shopee-import/sales-overview';
import {FakeStore} from './support/shopee-fake-store';

// FICTIONAL figures. Shopee's By Day export of Sales Overview: the summary table has no Orders/Units columns and its Date is "D/M/YYYY-D/M/YYYY";
// the daily table has the usual 14 columns but 24 HOURLY rows ("28/10/2026 00:00" ...), so visitors and buyers are not additive across the hours.
const SUMMARY_HEAD = ['Date', 'Visitors (Visit)', 'Buyers (Placed Order)', 'Sales (Placed Orders)', 'Buyers (Confirmed Orders)', 'Sales(Confirmed Orders)', 'Sales per Buyer', 'Conversion rates'];
const DAILY_HEAD = ['Date', 'Visitors (Visit)', 'Buyers (Placed Orders)', 'Units (Placed Orders)', 'Orders (Placed Orders)', 'Sales (Placed Orders)', 'Conversion Rate (Visit to Placed)', 'Buyers (Confirmed Orders)', 'Units(Confirmed Orders)', 'Orders (Confirmed Orders)', 'Sales(Confirmed Orders)', 'Sales per Buyer', 'Conversion Rate', 'Conversion Rate (Placed to Confirmed)'];
const f = (n: number) => n.toLocaleString('en-US', {maximumFractionDigits: 2});

interface Opts {range?: string; summaryPlaced?: number; summaryConf?: number; dates?: string[]}
/** 24 hourly rows: hour h sells 100 + h placed (confirmed 50 + h), 1 order and 2 units each, 5 visitors and 1 buyer each. */
async function hourlyFile(o: Opts = {}): Promise<Buffer> {
  const hours = Array.from({length: 24}, (_, h) => h);
  const placed = hours.reduce((s, h) => s + 100 + h, 0);
  const conf = hours.reduce((s, h) => s + 50 + h, 0);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sales Overview');
  ws.addRow(SUMMARY_HEAD);
  ws.addRow([o.range ?? '28/10/2026-28/10/2026', '40', '9', f(o.summaryPlaced ?? placed), '7', f(o.summaryConf ?? conf), '10.00', '1.00%']);
  ws.addRow([]);
  ws.addRow(DAILY_HEAD);
  for (const h of hours) {
    const date = o.dates?.[h] ?? `28/10/2026 ${String(h).padStart(2, '0')}:00`;
    ws.addRow([date, '5', '1', '2', '1', f(100 + h), '1.00%', '1', '2', '1', f(50 + h), '1.00', '1.00%', '100.00%']);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('Sales Overview By Day export (hourly rows)', () => {
  it('returns one DayFigures: visitors and buyers from the summary row, the rest summed over the 24 hours', async () => {
    const r = await parseSalesOverview(await hourlyFile());
    expect(r.periodFrom).toBe('2026-10-28');
    expect(r.periodTo).toBe('2026-10-28');
    expect(r.days).toEqual([{day: '2026-10-28', visitors: 40, buyersPlaced: 9, buyersConfirmed: 7, salesPlaced: 2676, salesConfirmed: 1476, ordersPlaced: 24, ordersConfirmed: 24, unitsPlaced: 48, unitsConfirmed: 48}]);
    expect(r.summary).toEqual({salesPlaced: 2676, salesConfirmed: 1476});
  });
  it('throws when the hours do not add up to the summary sales (placed or confirmed)', async () => {
    await expect(parseSalesOverview(await hourlyFile({summaryPlaced: 2000}))).rejects.toThrow(/hourly/i);
    await expect(parseSalesOverview(await hourlyFile({summaryConf: 1000}))).rejects.toThrow(/hourly/i);
  });
  it('throws for hourly rows under a multi-day range', async () => {
    await expect(parseSalesOverview(await hourlyFile({range: '28/10/2026-29/10/2026'}))).rejects.toThrow(/hourly/i);
  });
  it('throws when an hour belongs to another day than the summary', async () => {
    const dates = Array.from({length: 24}, (_, h) => `${h === 23 ? '29' : '28'}/10/2026 ${String(h).padStart(2, '0')}:00`);
    await expect(parseSalesOverview(await hourlyFile({dates}))).rejects.toThrow(/hourly/i);
  });
  it('plans through the real path: not PARSE, and the day lands as new', async () => {
    const store = new FakeStore();
    const o = await planFile({store, bytes: new Uint8Array(await hourlyFile()), filename: 'sales_overview_20261028-20261028.xlsx', today: '2026-10-30', importedBy: 'api'});
    if (o.status !== 'staged') throw new Error(`expected staged, got ${JSON.stringify(o)}`);
    expect(o.plan.newDays).toEqual(['2026-10-28']);
    expect(o.plan.changed).toEqual([]);
  });
});
