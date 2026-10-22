import {describe, expect, it} from 'vitest';
import {weeksCoverage} from '../src/shopee-import/coverage';
import {classifyFile, isIgnored} from '../src/shopee-import/files';

describe('classifyFile (the real name variants)', () => {
  it.each([
    ['sales_overview_20261012-20261018.xlsx', 'sales_overview', '2026-10-12', '2026-10-18'],
    ['productoverview20261012-20261018.xlsx', 'product_overview', '2026-10-12', '2026-10-18'],
    ['traffic_overview_20261012_20261018.xlsx', 'traffic', '2026-10-12', '2026-10-18'],
    ['parentskudetail.20261012_20261018.xlsx', 'sku_detail', '2026-10-12', '2026-10-18'],
    ['Shopee-Ads-Overall-Data-12_10_2026-18_10_2026.csv', 'ads', '2026-10-12', '2026-10-18'],
  ])('%s', (name, type, from, to) => {
    expect(classifyFile(name)).toEqual({type, period: {from, to}});
  });
  it('knows a file it cannot place', () => {
    expect(classifyFile('Order.all.20260901_20260930.xlsx')).toMatchObject({type: null});
    expect(classifyFile('notes.txt').period).toBeNull();
  });
  it('ignores macOS litter, Excel locks and the weekly run\'s _superseded folder unless asked', () => {
    expect(isIgnored('.DS_Store', false)).toBe(true);
    expect(isIgnored('2026-10-12_to_10-18/~$sales.xlsx', false)).toBe(true);
    expect(isIgnored('_superseded/sales_overview_20260706-20260712.xlsx', false)).toBe(true);
    expect(isIgnored('_superseded/sales_overview_20260706-20260712.xlsx', true)).toBe(false);
    expect(isIgnored('2026-10-12_to_10-18/sales_overview_20261012-20261018.xlsx', false)).toBe(false);
  });
});

describe('weeksCoverage', () => {
  it('lists complete, partial and missing Monday to Sunday weeks', () => {
    const days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-19', '2026-10-20'];
    const w = weeksCoverage(days, '2026-10-22');
    expect(w.map((x) => [x.weekStart, x.status])).toEqual([['2026-10-05', 'complete'], ['2026-10-12', 'missing'], ['2026-10-19', 'partial']]);
    expect(w[2].missing).toEqual(['2026-10-21', '2026-10-22']);
  });
  it('is empty with nothing loaded', () => {
    expect(weeksCoverage([])).toEqual([]);
  });
});
