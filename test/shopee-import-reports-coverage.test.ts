import {describe, expect, it} from 'vitest';
import {reportsByWeek} from '../src/shopee-import/coverage';
import {applyRun, planFile} from '../src/shopee-import/pipeline';
import {handleCoverage} from '../src/shopee-import/api';
import {FakeStore} from './support/shopee-fake-store';
import {salesOverviewFile, week} from './support/shopee-fixture';
import {adsCsv, productOverviewFile, funnelWeek, trafficFile} from './support/shopee-reports-fixture';

const WEEKS = ['2026-09-14', '2026-09-21', '2026-09-28'];

describe('reportsByWeek', () => {
  it('is full when imports cover all 7 days, partial when some, missing when none', () => {
    const r = reportsByWeek([
      {reportType: 'ads', periodFrom: '2026-09-21', periodTo: '2026-09-27'},
      {reportType: 'traffic', periodFrom: '2026-09-14', periodTo: '2026-10-04'}, // a long span covers three whole weeks
      {reportType: 'product_overview', periodFrom: '2026-09-21', periodTo: '2026-09-25'},
    ], WEEKS);
    expect(r['2026-09-14']).toEqual({ads: 'missing', sku_detail: 'missing', traffic: 'full', product_overview: 'missing'});
    expect(r['2026-09-21']).toEqual({ads: 'full', sku_detail: 'missing', traffic: 'full', product_overview: 'partial'});
    expect(r['2026-09-28']).toEqual({ads: 'missing', sku_detail: 'missing', traffic: 'full', product_overview: 'missing'});
  });

  it('a Monday to Saturday file is partial; a Sunday file next to it makes the week full', () => {
    const mondayToSaturday = {reportType: 'ads' as const, periodFrom: '2026-09-28', periodTo: '2026-10-03'};
    expect(reportsByWeek([mondayToSaturday], ['2026-09-28'])['2026-09-28'].ads).toBe('partial');
    expect(reportsByWeek([mondayToSaturday, {reportType: 'ads', periodFrom: '2026-10-04', periodTo: '2026-10-04'}], ['2026-09-28'])['2026-09-28'].ads).toBe('full');
  });

  it('a report type does not count toward another', () => {
    const r = reportsByWeek([{reportType: 'sku_detail', periodFrom: '2026-09-21', periodTo: '2026-09-27'}], ['2026-09-21']);
    expect(r['2026-09-21']).toMatchObject({sku_detail: 'full', ads: 'missing', traffic: 'missing', product_overview: 'missing'});
  });

  it('knows nothing about weeks it is not asked about', () => {
    expect(Object.keys(reportsByWeek([], ['2026-09-21']))).toEqual(['2026-09-21']);
    expect(reportsByWeek([], [])).toEqual({});
  });
});

describe('a partial weekly file through the pipeline and the coverage API', () => {
  it('an ads file for Monday to Saturday is accepted but the week reads "partial"', async () => {
    const store = new FakeStore();
    const today = '2026-10-27';
    // sales for the whole week, so the coverage API has a week to report on
    const sales = await planFile({store, bytes: await salesOverviewFile(week('2026-09-28', [10, 10, 10, 10, 10, 10, 10])), filename: 'sales_overview_20260928-20261004.xlsx', today});
    if (sales.status !== 'staged') throw new Error(`expected staged, got ${sales.status}`);
    await applyRun(store, sales.importId);
    const partialAds = await planFile({store, bytes: adsCsv([{name: 'a', gmv: 10, expense: 5}], {period: '28/09/2026 - 03/10/2026'}), filename: 'Shopee-Ads-Overall-Data-28_09_2026-03_10_2026.csv', today});
    if (partialAds.status !== 'staged_report') throw new Error(`expected staged_report, got ${partialAds.status}`);
    await applyRun(store, partialAds.importId);
    for (const [name, bytes] of [['traffic_overview_20260928_20261004.xlsx', await trafficFile('2026-09-28')], ['productoverview20260928-20261004.xlsx', await productOverviewFile(funnelWeek('2026-09-28', [1, 2, 3, 4, 5, 6, 7]))]] as const) {
      const o = await planFile({store, bytes, filename: name, today});
      if (o.status !== 'staged_report') throw new Error(`expected staged_report, got ${o.status}`);
      await applyRun(store, o.importId);
    }

    const res = await handleCoverage(new Request('http://x/api/shopee/import/coverage', {headers: {authorization: 'Bearer t'}}), {store, token: 't', now: () => new Date('2026-10-05T04:00:00Z')});
    const body = (await res.json()) as {weeks: {weekStart: string; status: string; reports: Record<string, string>}[]};
    expect(body.weeks.find((w) => w.weekStart === '2026-09-28')).toMatchObject({status: 'complete', reports: {ads: 'partial', sku_detail: 'missing', traffic: 'full', product_overview: 'full'}});
  });
});
