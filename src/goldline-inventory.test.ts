import {describe, expect, it} from 'vitest';
import {
  buildInventory,
  LOW_STOCK_AT,
  onHandOf,
  pageCoverage,
  periodParam,
  pickSnapshot,
  stockStatus,
  type CatalogEntry,
  type InventoryRowIn,
  type ManifestEntry,
  type Snapshot,
} from './goldline-inventory';

const r = (item_code: string, c: Partial<InventoryRowIn> = {}): InventoryRowIn => ({
  item_code,
  stockroom: null,
  drawer: null,
  selling_area: null,
  delivery: null,
  ending_on_hand: null,
  ...c,
});

describe('onHandOf', () => {
  it('prefers the written Ending column', () => {
    expect(onHandOf(r('A', {stockroom: 5, ending_on_hand: 12}))).toEqual({onHand: 12, source: 'ending'});
  });
  it('otherwise sums the three physical counts, never adding delivery', () => {
    expect(onHandOf(r('A', {stockroom: 21, drawer: 0, selling_area: 11, delivery: 6}))).toEqual({onHand: 32, source: 'counted'});
    expect(onHandOf(r('A', {selling_area: 4}))).toEqual({onHand: 4, source: 'counted'});
  });
  it('treats a blank row as not counted, not zero', () => {
    expect(onHandOf(r('A'))).toEqual({onHand: null, source: null});
    expect(onHandOf(r('A', {delivery: 3}))).toEqual({onHand: null, source: null});
  });
});

describe('stockStatus', () => {
  it('maps on-hand to a status', () => {
    expect(stockStatus(null)).toBe('uncounted');
    expect(stockStatus(0)).toBe('out');
    expect(stockStatus(LOW_STOCK_AT - 1)).toBe('low');
    expect(stockStatus(LOW_STOCK_AT)).toBe('ok');
  });
});

describe('buildInventory', () => {
  const catalog = new Map<string, CatalogEntry>([
    ['FBPP01', {productLine: 'Flawless Beauty Pressed Powder', variant: 'Salmon', unitPrice: 250, bestseller: true}],
  ]);
  const manifest = new Map<string, ManifestEntry>([
    ['FBPP01', {page: 1, index: 0, shade: 'Salmon'}],
    ['FBPP02', {page: 1, index: 1, shade: 'Golden Tan'}],
    ['LS01', {page: 2, index: 0, shade: 'Ruby'}],
  ]);

  it('orders by form page and position, names from catalog then manifest', () => {
    const s = buildInventory([r('LS01', {stockroom: 1}), r('ZZ9'), r('FBPP02', {selling_area: 0}), r('FBPP01', {stockroom: 20})], catalog, manifest);
    expect(s.items.map((i) => i.item_code)).toEqual(['FBPP01', 'FBPP02', 'LS01', 'ZZ9']);
    expect(s.items[0]).toMatchObject({name: 'Salmon', productLine: 'Flawless Beauty Pressed Powder', bestseller: true, page: 1});
    expect(s.items[1]).toMatchObject({name: 'Golden Tan', productLine: null, page: 1});
    expect(s.items[3]).toMatchObject({name: 'ZZ9', page: null, status: 'uncounted'});
  });

  it('values priced rows only and counts statuses', () => {
    const s = buildInventory([r('FBPP01', {stockroom: 20}), r('FBPP02', {selling_area: 0}), r('LS01', {drawer: 3}), r('ZZ9')], catalog, manifest);
    expect(s.value).toBe(5000);
    expect(s.pricedCounted).toBe(1);
    expect(s.unpricedCounted).toBe(2);
    expect(s).toMatchObject({tracked: 4, counted: 3, low: 1, out: 1, uncounted: 1});
    expect(s.items.find((i) => i.item_code === 'FBPP02')?.value).toBeNull();
  });
});

describe('pickSnapshot', () => {
  const snap = (store_code: string, period_start: string, period_end: string): Snapshot => ({
    store_code,
    period_start,
    period_end,
    items: 10,
    uploads: 1,
    consultant: null,
    last_committed_at: null,
  });
  const all = [snap('2', '2026-10-01', '2026-10-15'), snap('10', '2026-10-01', '2026-10-15'), snap('1', '2026-09-16', '2026-09-30')];

  it('returns the requested snapshot when it exists', () => {
    expect(pickSnapshot(all, '1', '2026-09-16_2026-09-30')?.store_code).toBe('1');
  });
  it('defaults to the latest period, lowest store code (numeric)', () => {
    expect(pickSnapshot(all)).toMatchObject({store_code: '2', period_end: '2026-10-15'});
  });
  it('keeps the requested store when only the period is unknown', () => {
    expect(pickSnapshot(all, '1', 'nope')).toMatchObject({store_code: '1', period_end: '2026-09-30'});
  });
  it('honours a period on its own', () => {
    expect(pickSnapshot(all, null, '2026-09-16_2026-09-30')).toMatchObject({store_code: '1', period_end: '2026-09-30'});
  });
  it('is null with nothing committed', () => {
    expect(pickSnapshot([])).toBeNull();
  });
  it('periodParam round-trips the URL form', () => {
    expect(periodParam(all[0])).toBe('2026-10-01_2026-10-15');
  });
});

describe('pageCoverage', () => {
  it('lists pages in and missing out of 1–5', () => {
    expect(pageCoverage([3, 1, 1, null, 6])).toEqual({have: [1, 3], missing: [2, 4, 5]});
    expect(pageCoverage([])).toEqual({have: [], missing: [1, 2, 3, 4, 5]});
  });
});
