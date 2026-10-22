import {describe, expect, it} from 'vitest';
import {parseAds} from '../src/shopee-import/ads';
import {toSeconds} from '../src/shopee-import/cells';
import {parseProductOverview} from '../src/shopee-import/product-overview';
import {parseSkuDetail} from '../src/shopee-import/sku-detail';
import {readSnapshot} from '../src/shopee-import/snapshot';
import {parseTraffic} from '../src/shopee-import/traffic';
import {salesOverviewFile, week} from './support/shopee-fixture';
import {adsCsv, daysFrom, funnelWeek, productOverviewFile, skuDetailFile, trafficFile} from './support/shopee-reports-fixture';

const TODAY = '2026-10-27'; // every fixture week below is closed by then
const PERIOD = {from: '2026-09-21', to: '2026-09-27'};
const codes = (r: Awaited<ReturnType<typeof readSnapshot>>): string[] => (r.ok ? [] : r.failures.map((f) => f.code));

describe('ads CSV', () => {
  it('reads the period, the creation time and every campaign, behind a BOM', () => {
    const p = parseAds(adsCsv([
      {name: 'Shop GMV Max', adsType: '', impressions: 11171, clicks: 260, conversions: 14, directConversions: 14, itemsSold: 24, gmv: 7386, directGmv: 7000, expense: 3350.68},
      {name: 'Cat treats, 2 pack', status: 'Paused', adsType: 'Product Search', gmv: 500.5, expense: 100},
    ]));
    expect(p).toMatchObject({periodFrom: '2026-09-21', periodTo: '2026-09-27', exportedAt: '2026-09-28T10:25:00+08:00'});
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0]).toMatchObject({adName: 'Shop GMV Max', adsType: null, status: 'Ongoing', impressions: 11171, clicks: 260, conversions: 14, itemsSold: 24, gmv: 7386, directGmv: 7000, expense: 3350.68});
    expect(p.rows[1]).toMatchObject({adName: 'Cat treats, 2 pack', status: 'Paused', adsType: 'Product Search', gmv: 500.5, directGmv: 500.5});
  });

  it('says so when the file is not a CPC ads report or has no readable date period', () => {
    expect(() => parseAds(Buffer.from('a,b\n1,2\n'))).toThrow(/not a Shopee CPC ads report/);
    expect(() => parseAds(adsCsv([{name: 'x', gmv: 1, expense: 1}], {title: false}))).toThrow(/not a Shopee CPC ads report/);
    expect(() => parseAds(adsCsv([{name: 'x', gmv: 1, expense: 1}], {period: 'next week'}))).toThrow(/Date Period/);
  });
});

describe('SKU detail workbook', () => {
  const products = [
    {itemId: '111', title: 'Fictional chicken bites', parentSku: 'FCT-001', salesPlaced: 3642, salesConfirmed: 3143, unitsPlaced: 8, unitsConfirmed: 7, variations: [
      {id: '9001', name: 'Duck strips', sku: 'FCT-DUCK', salesPlaced: 2245, salesConfirmed: 2245, unitsPlaced: 5, unitsConfirmed: 5},
      {id: '9002', name: 'Salmon cubes', salesPlaced: 1397, salesConfirmed: 898},
    ]},
    {itemId: '222', title: 'Fictional cat grass', salesPlaced: 2339, salesConfirmed: 1881},
  ];

  it('reads product rows (variation "-" to null) and the variation rows under them, with thousands separators', async () => {
    const p = await parseSkuDetail(await skuDetailFile(products), PERIOD);
    expect(p).toMatchObject({periodFrom: PERIOD.from, periodTo: PERIOD.to});
    expect(p.rows).toHaveLength(4);
    expect(p.rows[0]).toMatchObject({itemId: '111', product: 'Fictional chicken bites', variationId: null, variationName: null, sku: null, parentSku: 'FCT-001', salesPlaced: 3642, salesConfirmed: 3143, unitsConfirmed: 7, impressions: 4159, clicks: 91, visitors: 60, pageViews: 86});
    expect(p.rows[1]).toMatchObject({variationId: '9001', variationName: 'Duck strips', sku: 'FCT-DUCK', salesConfirmed: 2245, impressions: null, clicks: null, visitors: null});
    expect(p.rows[3]).toMatchObject({itemId: '222', variationId: null, salesConfirmed: 1881, parentSku: null});
  });

  it('says so when the workbook has no Top Performing Products sheet or is not a workbook', async () => {
    await expect(parseSkuDetail(await salesOverviewFile(week('2026-09-21', [1, 2, 3, 4, 5, 6, 7])), PERIOD)).rejects.toThrow(/Top Performing Products/);
    await expect(parseSkuDetail(Buffer.from('garbage'), PERIOD)).rejects.toThrow(/not a parent SKU detail workbook/);
  });
});

describe('Traffic workbook', () => {
  it('reads all three platforms, the period from the All sheet and the file\'s own page-view totals', async () => {
    const p = await parseTraffic(await trafficFile('2026-09-21', {pageViews: [52, 55, 108, 40, 30, 20, 10]}));
    expect(p).toMatchObject({periodFrom: '2026-09-21', periodTo: '2026-09-27', summaryPageViews: {all: 315, pc: 7, app: 308}});
    expect(p.days).toHaveLength(21);
    expect(p.days.filter((d) => d.platform === 'all').map((d) => d.pageViews)).toEqual([52, 55, 108, 40, 30, 20, 10]);
    expect(p.days.find((d) => d.platform === 'all' && d.day === '2026-09-21')).toMatchObject({avgPageViews: 2.62, avgTimeSeconds: 81, bounceRate: 15.38, visitors: 13, newVisitors: 9, existingVisitors: 4, newFollowers: 0});
    expect(p.days.find((d) => d.platform === 'pc')).toMatchObject({newFollowers: null}); // "-" is no value, not zero
  });

  it('says so when it is not a Traffic Overview workbook', async () => {
    await expect(parseTraffic(await salesOverviewFile(week('2026-09-21', [1, 2, 3, 4, 5, 6, 7])))).rejects.toThrow(/not a Traffic Overview workbook/);
    await expect(parseTraffic(Buffer.from('garbage'))).rejects.toThrow(/could not be read as .xlsx/);
  });

  it('converts hh:mm:ss to seconds', () => {
    expect(toSeconds('00:01:21')).toBe(81);
    expect(toSeconds('01:00:00')).toBe(3600);
    expect(toSeconds('soon')).toBeNull();
  });
});

describe('Product Overview workbook', () => {
  it('reads one row per day, sorted, with the period from the first and last day', async () => {
    const p = await parseProductOverview(await productOverviewFile(funnelWeek('2026-09-21', [100, 200, 300, 400, 500, 600, 700])));
    expect(p).toMatchObject({periodFrom: '2026-09-21', periodTo: '2026-09-27'});
    expect(p.days).toHaveLength(7);
    expect(p.days[1]).toMatchObject({day: '2026-09-22', visitors: 12, pageViews: 33, salesPlaced: 210, salesConfirmed: 200, buyersPlaced: 2, unitsConfirmed: 3, addToCartVisitors: 3, bounceRate: 8.33});
  });

  it('says so when it is not a Product Overview workbook', async () => {
    await expect(parseProductOverview(await salesOverviewFile(week('2026-09-21', [1, 2, 3, 4, 5, 6, 7])))).rejects.toThrow(/not a Product Overview workbook/);
    await expect(parseProductOverview(Buffer.from('garbage'))).rejects.toThrow(/could not be read as .xlsx/);
  });
});

describe('snapshot gates (readSnapshot)', () => {
  it('ads: reads a good file, and rejects an empty one and one whose name disagrees with its dates', async () => {
    const ok = await readSnapshot('ads', adsCsv([{name: 'a', gmv: 100, expense: 40}, {name: 'b', gmv: 50, expense: 10}]), PERIOD, TODAY);
    expect(ok.ok && ok.snapshot).toMatchObject({periodFrom: PERIOD.from, periodTo: PERIOD.to, exportedAt: '2026-09-28T10:25:00+08:00', summary: {campaigns: 2, spend: 50, adRevenue: 150, roas: 3}});
    expect(ok.ok && ok.snapshot.records).toHaveLength(2);
    expect(codes(await readSnapshot('ads', adsCsv([]), PERIOD, TODAY))).toContain('EMPTY');
    expect(codes(await readSnapshot('ads', adsCsv([{name: 'a', gmv: 1, expense: 1}]), {from: '2026-09-14', to: '2026-09-20'}, TODAY))).toContain('FILENAME_MISMATCH');
    expect(codes(await readSnapshot('ads', adsCsv([{name: 'a', gmv: 1, expense: -5}]), PERIOD, TODAY))).toContain('BAD_NUMBER');
    expect(codes(await readSnapshot('ads', Buffer.from('nope'), PERIOD, TODAY))).toEqual(['PARSE']);
  });

  it('sku_detail: needs dates from the file name, and sums the product rows only', async () => {
    const bytes = await skuDetailFile([
      {itemId: '1', title: 'A', salesPlaced: 700, salesConfirmed: 600, variations: [{id: 'v1', name: 'x', salesPlaced: 700, salesConfirmed: 600}]},
      {itemId: '2', title: 'B', salesPlaced: 300, salesConfirmed: 300},
    ]);
    expect(codes(await readSnapshot('sku_detail', bytes, null, TODAY))).toEqual(['NO_PERIOD']);
    const ok = await readSnapshot('sku_detail', bytes, PERIOD, TODAY);
    expect(ok.ok && ok.snapshot).toMatchObject({skuConfirmed: 900, summary: {products: 2, variations: 1, confirmedSales: 900}});
    expect(ok.ok && ok.snapshot.records).toHaveLength(3); // the variation row is stored too
  });

  it('traffic: a good file keeps every platform; page views that do not add up to the file total are rejected', async () => {
    const ok = await readSnapshot('traffic', await trafficFile('2026-09-21'), PERIOD, TODAY);
    expect(ok.ok && ok.snapshot).toMatchObject({periodFrom: PERIOD.from, periodTo: PERIOD.to, summary: {days: 7, pageViews: 560}, openSkipped: []});
    expect(ok.ok && ok.snapshot.records).toHaveLength(21);
    expect(codes(await readSnapshot('traffic', await trafficFile('2026-09-21', {summaryPageViews: 999}), PERIOD, TODAY))).toEqual(['SUM_PAGE_VIEWS']);
    expect(codes(await readSnapshot('traffic', await trafficFile('2026-09-21'), {from: '2026-09-14', to: '2026-09-20'}, TODAY))).toEqual(['FILENAME_MISMATCH']);
  });

  it('traffic: a missing day and a repeated day are caught on every sheet', async () => {
    const gap = await readSnapshot('traffic', await trafficFile('2026-09-21', {dropDay: '2026-09-24'}), PERIOD, TODAY);
    expect(codes(gap)).toContain('GAP');
    expect(!gap.ok && gap.failures.find((f) => f.code === 'GAP')?.message).toContain('2026-09-24');
    expect(codes(await readSnapshot('traffic', await trafficFile('2026-09-21', {dupDay: '2026-09-23'}), PERIOD, TODAY))).toContain('DUPLICATE_DAY');
  });

  it('product_overview: a missing day is a gap; a clean week keeps its sums', async () => {
    const days = funnelWeek('2026-09-21', [100, 200, 300, 400, 500, 600, 700]);
    const ok = await readSnapshot('product_overview', await productOverviewFile(days), PERIOD, TODAY);
    expect(ok.ok && ok.snapshot).toMatchObject({summary: {days: 7, salesConfirmed: 2800, salesPlaced: 2870}});
    expect(ok.ok && ok.snapshot.records).toHaveLength(7);
    expect(codes(await readSnapshot('product_overview', await productOverviewFile(days.filter((d) => d.day !== '2026-09-24')), PERIOD, TODAY))).toContain('GAP');
    expect(codes(await readSnapshot('product_overview', await productOverviewFile(days), {from: '2026-09-21', to: '2026-09-28'}, TODAY))).toContain('FILENAME_MISMATCH');
  });

  it('daily reports drop open days (today or later) and refuse a file where every day is open', async () => {
    const from = '2026-09-21';
    const [d1, d2, d3, d4] = daysFrom(from, 7).slice(0, 4);
    const traffic = await readSnapshot('traffic', await trafficFile(from), PERIOD, d4); // today = 24 Sep: 21, 22, 23 are closed
    expect(traffic.ok && traffic.snapshot).toMatchObject({openSkipped: daysFrom(from, 7).slice(3), summary: {days: 3, pageViews: 50 + 60 + 70}});
    expect(traffic.ok && traffic.snapshot.records).toHaveLength(9);
    const funnel = await readSnapshot('product_overview', await productOverviewFile(funnelWeek(from, [1, 2, 3, 4, 5, 6, 7])), PERIOD, d3);
    expect(funnel.ok && funnel.snapshot).toMatchObject({summary: {days: 2}, openSkipped: daysFrom(from, 7).slice(2)});
    expect(codes(await readSnapshot('traffic', await trafficFile(from), PERIOD, d1))).toEqual(['ALL_DAYS_OPEN']);
    expect(codes(await readSnapshot('product_overview', await productOverviewFile(funnelWeek(from, [1, 2, 3, 4, 5, 6, 7])), PERIOD, d1))).toEqual(['ALL_DAYS_OPEN']);
    expect(d2).toBe('2026-09-22');
  });
});
