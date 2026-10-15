import {describe, expect, it} from 'vitest';
import {addMonths, buildProductPage, buildStoreProduct, countLabel, productTotals, productView, registerMatches, type ItemCount, type ProductInfo, type StoreInput} from './goldline-product';

const ITEM = 'TWC01152';
const c = (start: string, end: string, onHand: number | null, delivery = 0, parts?: [number, number, number]): ItemCount => ({
  item_code: ITEM,
  period_start: start,
  period_end: end,
  stockroom: parts?.[0] ?? null,
  drawer: parts?.[1] ?? null,
  selling_area: parts?.[2] ?? null,
  delivery,
  ending_on_hand: parts ? null : onHand,
});

// The plan mockup's CUBAO history: Aug 38, Sep 44 (60 delivered), Oct 19 so far.
const CUBAO: ItemCount[] = [
  c('2026-07-16', '2026-07-31', 50),
  c('2026-08-01', '2026-08-15', 30),
  c('2026-08-16', '2026-08-31', 12),
  c('2026-09-01', '2026-09-15', 50, 60),
  c('2026-09-16', '2026-09-30', 28),
  c('2026-10-01', '2026-10-15', null, 0, [3, 0, 6]),
];
const store = (counts: ItemCount[], extra: Partial<StoreInput> = {}) =>
  buildStoreProduct({storeCode: '1', storeName: 'CUBAO', counts, sales: null, ...extra}, ITEM);
const NOW = new Date('2026-10-20T00:00:00Z');

describe('buildStoreProduct', () => {
  it('estimates sold per month from consecutive counts, attributed to the later count', () => {
    const s = store(CUBAO);
    expect(s.source).toBe('counts');
    expect(Object.fromEntries(s.soldByMonth)).toEqual({'2026-08': 38, '2026-09': 44, '2026-10': 19});
    expect(s.stockByMonth.get('2026-09')).toBe(28);
    expect(s.deliveryByMonth.get('2026-09')).toEqual({qty: 60, latest: '2026-09-15'});
    expect(s.movement?.onHand).toBe(9);
    expect(s.movement?.status).toBe('reorder');
    expect(s.movement?.suggestedOrder).toBeGreaterThan(0);
  });

  it('lists counts newest first with A/B labels and the on-hand rule', () => {
    const s = store(CUBAO);
    expect(s.countLines[0]).toMatchObject({label: 'Oct A', stockroom: 3, drawer: 0, sellingArea: 6, onHand: 9});
    expect(s.countLines.map((l) => l.label)).toEqual(['Oct A', 'Sep B', 'Sep A', 'Aug B', 'Aug A', 'Jul B']);
  });

  it('skips a cycle where the count rose with no delivery (not zero sales)', () => {
    const s = store([c('2026-09-01', '2026-09-15', 10), c('2026-09-16', '2026-09-30', 25), c('2026-10-01', '2026-10-15', 20)]);
    expect(s.soldByMonth.get('2026-09')).toBeUndefined();
    expect(s.soldByMonth.get('2026-10')).toBe(5);
  });

  it('uses the sales report once linked, and checks counts against the register', () => {
    const sales = [
      {period_start: '2026-08-01', period_end: '2026-08-31', units: 37},
      {period_start: '2026-09-01', period_end: '2026-09-30', units: 45},
      {period_start: '2026-10-01', period_end: '2026-10-15', units: 20},
    ];
    const s = store(CUBAO, {sales});
    expect(s.source).toBe('sales');
    expect(Object.fromEntries(s.soldByMonth)).toEqual({'2026-08': 37, '2026-09': 45, '2026-10': 20});
    expect(s.registerCheck).toBe(true);
    const off = store(CUBAO, {sales: [{period_start: '2026-09-01', period_end: '2026-09-30', units: 80}]});
    expect(off.registerCheck).toBe(false);
  });

  it('linked but no sales rows for this store → still counts', () => {
    expect(store(CUBAO, {sales: []}).source).toBe('counts');
  });
});

describe('buildProductPage', () => {
  it('builds 3 real + 3 forecast months for one store', () => {
    const p = buildProductPage([store(CUBAO)], NOW);
    expect(p.currentMonth).toBe('2026-10');
    expect(p.chart.map((m) => m.label)).toEqual(['AUG', 'SEP', 'OCT', 'NOV', 'DEC', 'JAN']);
    expect(p.chart.slice(0, 3).map((m) => m.sold)).toEqual([38, 44, 19]);
    expect(p.chart.slice(0, 3).map((m) => m.stockEnd)).toEqual([12, 28, 9]);
    expect(p.chart[1].delivery).toEqual({qty: 60, dateLabel: 'Sep 15'});
    expect(p.chart[2].isCurrent).toBe(true);
    expect(p.chart[2].stockForecast).toBe(9);
    const fc = p.chart.slice(3);
    expect(fc.every((m) => m.isForecast && (m.soldForecast ?? 0) > 0)).toBe(true);
    // 9 on hand on Oct 15 at ~1.4/day: gone before October ends (the rest of the
    // month is projected, not skipped), so the marker sits on OCT, once.
    expect(fc[0].stockForecast).toBe(0);
    expect(p.chart[2].runsOut).toBe(true);
    expect(p.chart.filter((m) => m.runsOut)).toHaveLength(1);
    expect(p.runsOutMonthLabel).toBe('Oct');
    expect(p.lastCountedWeeksAgo).toBe(0);
    expect(p.soldTable[0]).toMatchObject({month: '2026-10', sold: 19, partial: true});
    expect(p.soldTable[1].partial).toBe(false);
  });

  it('shapes the forecast by last year once there is a year of history', () => {
    const lastYear = [
      c('2025-10-16', '2025-10-31', 100),
      c('2025-11-01', '2025-11-15', 90),
      c('2025-11-16', '2025-11-30', 80), // Nov 2025: 20
      c('2025-12-01', '2025-12-15', 60),
      c('2025-12-16', '2025-12-31', 40), // Dec 2025: 40
      c('2026-01-01', '2026-01-15', 35),
      c('2026-01-16', '2026-01-31', 30), // Jan 2026: 10
    ];
    const p = buildProductPage([store([...lastYear, ...CUBAO.map((x) => ({...x, ending_on_hand: x.ending_on_hand == null ? 9 : x.ending_on_hand + 100}))])], NOW);
    const [nov, dec, jan] = p.chart.slice(3).map((m) => m.soldForecast as number);
    expect(dec).toBeGreaterThan(nov);
    expect(nov).toBeGreaterThan(jan);
    expect(p.hasLastYear).toBe(true);
    expect(p.chart[3].soldLastYear).toBe(20);
  });

  it('adds stores up, carrying a store forward through a month it did not count', () => {
    const makati = buildStoreProduct(
      {storeCode: '2', storeName: 'MAKATI', counts: [c('2026-08-16', '2026-08-31', 10), c('2026-10-01', '2026-10-15', 8)], sales: null},
      ITEM,
    );
    const p = buildProductPage([store(CUBAO), makati], NOW);
    expect(p.chart.slice(0, 3).map((m) => m.stockEnd)).toEqual([22, 38, 17]); // Sep: CUBAO 28 + MAKATI 10 (carried)
    // MAKATI's 2 units between Aug 31 and Oct 15 are spread over Sep and Oct (a missed
    // count doesn't pile two cycles into one month).
    expect(p.chart[1].sold).toBe(45); // Sep: 44 + 1
    expect(p.chart[2].sold).toBe(20); // Oct: 19 + 1
    expect(p.chart[0].sold).toBe(38); // Aug: only CUBAO had a cycle
    const t = productTotals([store(CUBAO), makati]);
    expect(t.onHand).toBe(17);
    expect(t.storesCounted).toBe(2);
    expect(t.suggestedOrder).toBe((store(CUBAO).movement?.suggestedOrder ?? 0) + (makati.movement?.suggestedOrder ?? 0));
    expect(t.sources).toEqual({sales: 0, counts: 2});
  });

  it('one count: no sold months and no forecast — just on hand', () => {
    const s = store([c('2026-10-01', '2026-10-15', 20)]);
    expect(s.movement?.status).toBe('no_history');
    const p = buildProductPage([s], NOW);
    expect(p.chart.slice(0, 3).map((m) => m.sold)).toEqual([null, null, null]);
    expect(p.chart.slice(3).every((m) => m.soldForecast == null && m.stockForecast == null)).toBe(true);
    expect(p.chart[2].stockEnd).toBe(20);
    expect(p.runsOutMonthLabel).toBeNull();
  });

  it('no counts at all → empty page', () => {
    const p = buildProductPage([store([])], NOW);
    expect(p.chart).toEqual([]);
    expect(p.currentMonth).toBeNull();
  });

  it('already out: no "runs out" marker', () => {
    const s = store([c('2026-09-16', '2026-09-30', 10), c('2026-10-01', '2026-10-15', 0)]);
    const p = buildProductPage([s], NOW);
    expect(p.chart.some((m) => m.runsOut)).toBe(false);
    expect(s.movement?.status).toBe('out');
  });
});

describe('helpers', () => {
  it('labels counts by half-month', () => {
    expect(countLabel('2026-10-15')).toBe('Oct A');
    expect(countLabel('2026-10-16')).toBe('Oct A');
    expect(countLabel('2026-10-31')).toBe('Oct B');
  });
  it('register tolerance is ±2 units or 10%', () => {
    expect(registerMatches(44, 45)).toBe(true);
    expect(registerMatches(90, 100)).toBe(true);
    expect(registerMatches(85, 100)).toBe(false);
    expect(registerMatches(3, 0)).toBe(false);
  });
  it('adds months across years', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(addMonths('2026-01', -12)).toBe('2025-01');
  });
});

describe('productView (store selection)', () => {
  const info: ProductInfo = {itemCode: ITEM, name: 'Natural', productLine: 'Two Way Cake', price: 185, bestseller: true, skuLinked: false};
  const inputs: StoreInput[] = [
    {storeCode: '1', storeName: 'CUBAO', counts: CUBAO, sales: null},
    {storeCode: '2', storeName: 'MAKATI', counts: [c('2026-09-16', '2026-09-30', 12), c('2026-10-01', '2026-10-15', 10)], sales: null},
  ];
  it('opens the requested store', () => {
    const v = productView(info, inputs, '2', NOW);
    expect(v.store).toBe('2');
    expect(v.single?.onHand).toBe(10);
    expect(v.storeRows).toEqual([]);
  });
  it('an unknown or out-of-scope store falls back to all stores', () => {
    const v = productView(info, inputs, '99', NOW);
    expect(v.store).toBeNull();
    expect(v.single).toBeNull();
    expect(v.storeRows.map((r) => r.code)).toEqual(['1', '2']);
    expect(v.totals.onHand).toBe(19);
    expect(v.storeRows.find((r) => r.code === '1')?.soldLastMonth).toBe(44);
  });
  it('a single visible store opens directly', () => {
    expect(productView(info, inputs.slice(0, 1), null, NOW).store).toBe('1');
  });
  it('no stores → empty view', () => {
    const v = productView(info, [], null, NOW);
    expect(v.stores).toEqual([]);
    expect(v.chart).toEqual([]);
  });
});

describe('review fixes', () => {
  it('a count with no on-hand figure carries its delivery to the next count', () => {
    const s = store([c('2026-09-01', '2026-09-15', 10), c('2026-09-16', '2026-09-30', null, 20), c('2026-10-01', '2026-10-15', 5)]);
    const total = [...s.soldByMonth.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(25); // 10 + 20 delivered − 5
  });

  it('an item missing from the store\'s latest count reads "not counted", not stale figures', () => {
    const s = store(CUBAO, {storeLatestEnd: '2026-10-31'});
    expect(s.missingFromLatest).toBe(true);
    expect(s.movement).toMatchObject({status: 'not_counted', onHand: null, suggestedOrder: 0, coverDays: null});
    expect(s.latestEnd).toBe('2026-10-15');
    expect(store(CUBAO, {storeLatestEnd: '2026-10-15'}).missingFromLatest).toBe(false);
  });

  it('a B count (month closed) projects from the month end, no current-month runs-out', () => {
    const s = store([c('2026-09-16', '2026-09-30', 100), c('2026-10-01', '2026-10-15', 90), c('2026-10-16', '2026-10-31', 80)]);
    const p = buildProductPage([s], NOW);
    expect(p.soldTable[0].partial).toBe(false);
    expect(p.chart[2].runsOut).toBe(false);
    expect(p.chart[3].stockForecast).toBeGreaterThan(0);
  });

  it('linked sales fill their months; counts fill the gaps', () => {
    const s = store(CUBAO, {sales: [{period_start: '2026-09-01', period_end: '2026-09-30', units: 50}]});
    expect(s.source).toBe('sales');
    expect(s.soldByMonth.get('2026-09')).toBe(50); // register
    expect(s.soldByMonth.get('2026-08')).toBe(38); // counts fallback
  });
});
