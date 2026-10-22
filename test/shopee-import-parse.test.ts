import {describe, expect, it} from 'vitest';
import {parseSalesOverview} from '../src/shopee-import/sales-overview';
import {salesOverviewFile, week} from './support/shopee-fixture';

describe('parseSalesOverview', () => {
  it('reads the summary and every daily row of the two-table sheet, numbers with thousands separators included', async () => {
    const days = week('2026-10-12', [1043, 3031, 3070, 2552, 1007, 4085, 2978], 100);
    const out = await parseSalesOverview(await salesOverviewFile(days));
    expect(out.periodFrom).toBe('2026-10-12');
    expect(out.periodTo).toBe('2026-10-18');
    expect(out.days).toHaveLength(7);
    expect(out.days[1]).toMatchObject({day: '2026-10-13', salesConfirmed: 3031, salesPlaced: 3031, ordersConfirmed: 3, unitsConfirmed: 5, visitors: 100});
    expect(out.days[0].salesPlaced).toBe(1143); // placed can be above confirmed
    expect(out.summary).toEqual({salesPlaced: 17866, salesConfirmed: 17766});
  });

  it('matches headers by name, so a reordered or spaced header still parses', async () => {
    const out = await parseSalesOverview(await salesOverviewFile(week('2026-10-12', [100, 200])));
    expect(out.days.map((d) => d.salesConfirmed)).toEqual([100, 200]);
  });

  it('throws a plain error for a file that is not a Sales Overview', async () => {
    await expect(parseSalesOverview(Buffer.from('not a workbook'))).rejects.toThrow(/Sales Overview/);
  });
});
