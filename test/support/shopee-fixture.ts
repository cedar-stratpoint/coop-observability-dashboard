// FICTIONAL Shopee Sales Overview workbook, shaped like the real export (two tables on one sheet: a week summary, then the daily rows;
// every value text with thousands separators; dates DD/MM/YYYY). Built in the test so no shop figure is committed to this public repo.
import ExcelJS from 'exceljs';

export interface FixtureDay {day: string; visitors?: number; buyersPlaced?: number; unitsPlaced?: number; ordersPlaced?: number; salesPlaced: number; buyersConf?: number; unitsConf?: number; ordersConf?: number; salesConf: number}

const dmy = (iso: string): string => iso.split('-').reverse().join('/');
const fmt = (n: number): string => n.toLocaleString('en-US', {maximumFractionDigits: 2});

const H1 = ['Date', 'Visitors (Visit)', 'Buyers (Placed Orders)', 'Sales (Placed Orders) (PHP)', 'Buyers (Confirmed Orders)', 'Sales(Confirmed Orders) (PHP)', 'Sales per Buyer (Confirmed Orders) (PHP)', 'Conversion Rate (Visit to Placed)', 'Conversion Rate', 'Conversion Rate (Placed to Confirmed)'];
const H2 = ['Date', 'Visitors (Visit)', 'Buyers (Placed Orders)', 'Units (Placed Orders)', 'Orders (Placed Orders)', 'Sales (Placed Orders) (PHP)', 'Conversion Rate (Visit to Placed)', 'Buyers (Confirmed Orders)', 'Units(Confirmed Orders)', 'Orders (Confirmed Orders)', 'Sales(Confirmed Orders) (PHP)', 'Sales per Buyer (Confirmed Orders) (PHP)', 'Conversion Rate', 'Conversion Rate (Placed to Confirmed)'];

export function day(iso: string, salesConf: number, salesPlaced = salesConf): FixtureDay {
  return {day: iso, visitors: 100, buyersPlaced: 3, unitsPlaced: 5, ordersPlaced: 3, salesPlaced, buyersConf: 3, unitsConf: 5, ordersConf: 3, salesConf};
}

/** The summary row can be overridden to make a file whose daily rows do not add up to its own total. */
export async function salesOverviewFile(days: FixtureDay[], opts: {summaryPlaced?: number; summaryConf?: number; range?: string} = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sales Overview');
  const placed = opts.summaryPlaced ?? days.reduce((s, d) => s + d.salesPlaced, 0);
  const conf = opts.summaryConf ?? days.reduce((s, d) => s + d.salesConf, 0);
  const range = opts.range ?? `${dmy(days[0].day)}-${dmy(days[days.length - 1].day)}`;
  ws.addRow(H1);
  ws.addRow([range, '999', '9', fmt(placed), '9', fmt(conf), '1.00', '1.00%', '1.00%', '100.00%']);
  ws.addRow([]);
  ws.addRow(H2);
  for (const d of days) {
    ws.addRow([dmy(d.day), fmt(d.visitors ?? 0), fmt(d.buyersPlaced ?? 0), fmt(d.unitsPlaced ?? 0), fmt(d.ordersPlaced ?? 0), fmt(d.salesPlaced), '1.00%', fmt(d.buyersConf ?? 0), fmt(d.unitsConf ?? 0), fmt(d.ordersConf ?? 0), fmt(d.salesConf), '1.00', '1.00%', '100.00%']);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function week(from: string, salesConf: number[], placedExtra = 0): FixtureDay[] {
  return salesConf.map((s, i) => {
    const d = new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    return day(d, s, s + (i === 0 ? placedExtra : 0));
  });
}
