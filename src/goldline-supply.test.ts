import {describe, expect, it} from 'vitest';
import type {ItemMovement} from './goldline-movement';
import {boardSummary, buildBoard, inTransitFor, lastsLabel, manilaDate, productionDaysFor, transitDaysFor, type StoreBlock, type SupplyConfig} from './goldline-supply';

const TODAY = '2026-10-20';
const cfg: SupplyConfig = {
  defaultProductionDays: 30,
  defaultTransitDays: 3,
  lineProductionDays: {'Two Way Cake': 21},
  storeTransitDays: {'1': 2, '4': 6},
  isSample: true,
};
const mv = (p: Partial<ItemMovement>): ItemMovement => ({
  item_code: 'X',
  onHand: 10,
  cyclesSold: [15, 15, 15],
  velocity: 15,
  coverDays: 10,
  stockOutDate: '2026-10-25',
  suggestedOrder: 50,
  status: 'reorder',
  deadStock: false,
  anomaly: null,
  ...p,
});
const block = (code: string, items: StoreBlock['items'], latestEnd = '2026-10-15'): StoreBlock => ({storeCode: code, storeName: `S${code}`, latestEnd, cycleDays: 15, items});
const item = (itemCode: string, m: Partial<ItemMovement>, monthly: Record<string, number> = {}) => ({
  itemCode,
  movement: mv({item_code: itemCode, ...m}),
  row: {item_code: itemCode, stockroom: 4, drawer: 1, selling_area: 5, delivery: 0, ending_on_hand: null},
  monthly: new Map(Object.entries(monthly)),
});
const catalog = {
  TWC: {name: 'Natural', productLine: 'Two Way Cake', price: 185, bestseller: true, hidden: false},
  LIP: {name: 'Love On Fire', productLine: 'Lipstick', price: 299, bestseller: false, hidden: false},
};

describe('lead time lookups', () => {
  it('falls back to the company defaults', () => {
    expect(transitDaysFor(cfg, '1')).toBe(2);
    expect(transitDaysFor(cfg, '9')).toBe(3);
    expect(productionDaysFor(cfg, 'Two Way Cake')).toBe(21);
    expect(productionDaysFor(cfg, 'Lipstick')).toBe(30);
    expect(productionDaysFor(cfg, null)).toBe(30);
  });
});

describe('buildBoard — one store', () => {
  const stores = [block('1', [item('TWC', {}, {'2026-08': 28, '2026-09': 30, '2026-10': 14})]), block('4', [item('TWC', {onHand: 40, suggestedOrder: 0, status: 'healthy', stockOutDate: '2026-11-30', coverDays: 40})])];
  const rows = buildBoard({stores, catalog, warehouse: {TWC: 100}, config: cfg, shipments: [], currentMonth: '2026-10', today: TODAY, store: '1'});
  const r = rows[0];

  it('ship by = stock-out − the store\'s transit days; arrives = today + transit', () => {
    expect(r.shipBy).toEqual({kind: 'date', date: '2026-10-23'}); // Oct 25 − 2
    expect(r.arrivesIfSentToday).toBe('2026-10-22');
    expect(r.transitDays).toBe(2);
  });

  it('pace per month, monthly sold and the back room / display split', () => {
    expect(r.perMonth).toBe(30); // 15 per 15-day cycle → 1/day × 30.4
    expect(r.trend).toEqual([28, 30, 14]);
    expect(r.threeMonths).toBe(72);
    expect(r.backRoom).toBe(5);
    expect(r.display).toBe(5);
  });

  it('warehouse weighs every store, then produce by = stock-out − production', () => {
    // need 50 (store 1) + 0 (store 4) = 50 → 50 left; total pace 1 + 1 per day → 25 days.
    expect(r.warehouseAfterNeeds).toBe(50);
    expect(r.warehouseShort).toBe(false);
    expect(r.productionDays).toBe(21);
    expect(r.produceBy).toEqual({kind: 'date', date: '2026-10-24'}); // Oct 20 + 25 − 21
  });
});

describe('ship now / warehouse short / produce now', () => {
  it('an item already out ships now; needs beyond the warehouse mean produce now', () => {
    const rows = buildBoard({
      stores: [block('1', [item('LIP', {onHand: 0, status: 'out', suggestedOrder: 60, stockOutDate: null, coverDays: 0})])],
      catalog,
      warehouse: {LIP: 20},
      config: cfg,
      shipments: [],
      currentMonth: '2026-10',
      today: TODAY,
      store: '1',
    });
    expect(rows[0].shipBy).toEqual({kind: 'now'});
    expect(rows[0].warehouseShort).toBe(true);
    expect(rows[0].produceBy).toEqual({kind: 'now'});
    expect(boardSummary(rows, TODAY)).toMatchObject({reorder: 1, out: 1, shipNow: 1, warehouseShort: 1, produceSoon: 1});
  });
  it('a stock-out date already within transit time means ship now', () => {
    const rows = buildBoard({
      stores: [block('4', [item('TWC', {stockOutDate: '2026-10-24'})])],
      catalog,
      warehouse: {TWC: 500},
      config: cfg,
      shipments: [],
      currentMonth: '2026-10',
      today: TODAY,
      store: '4',
    });
    expect(rows[0].shipBy).toEqual({kind: 'now'}); // Oct 24 − 6 days < today
  });
});

describe('shipments in transit', () => {
  const ship = {id: 's1', storeCode: '1', itemCode: 'TWC', qty: 30, shippedOn: '2026-10-18', arrivesOn: '2026-10-20'};
  it('count as on the way until a count covers the arrival', () => {
    expect(inTransitFor([ship], '1', 'TWC', '2026-10-15')).toEqual({qty: 30, arrivesOn: '2026-10-20'});
    expect(inTransitFor([ship], '1', 'TWC', '2026-10-31')).toBeNull(); // the Oct B count recorded it
    expect(inTransitFor([ship], '2', 'TWC', '2026-10-15')).toBeNull();
  });
  it('reduce the need (never below zero)', () => {
    const rows = buildBoard({stores: [block('1', [item('TWC', {})])], catalog, warehouse: {TWC: 100}, config: cfg, shipments: [ship], currentMonth: '2026-10', today: TODAY, store: '1'});
    expect(rows[0].suggested).toBe(50);
    expect(rows[0].need).toBe(20);
    expect(rows[0].inTransit).toEqual({qty: 30, arrivesOn: '2026-10-20'});
  });
});

describe('all stores', () => {
  it('adds stores up and takes the most urgent status and earliest ship-by', () => {
    const stores = [
      block('1', [item('TWC', {onHand: 10, suggestedOrder: 50}, {'2026-10': 14})]),
      block('4', [item('TWC', {onHand: 40, suggestedOrder: 0, status: 'healthy', stockOutDate: '2026-12-01', coverDays: 42}, {'2026-10': 6})]),
    ];
    const r = buildBoard({stores, catalog, warehouse: {TWC: 100}, config: cfg, shipments: [], currentMonth: '2026-10', today: TODAY, store: null})[0];
    expect(r.onHand).toBe(50);
    expect(r.thisMonth).toBe(20);
    expect(r.status).toBe('reorder');
    expect(r.storesNeeding).toBe(1);
    expect(r.storesCounted).toBe(2);
    expect(r.need).toBe(50);
    expect(r.shipBy).toEqual({kind: 'date', date: '2026-10-23'});
    expect(r.transitDays).toBeNull();
    expect(r.coverDays).toBe(25); // 50 on hand ÷ 2 per day
  });
  it('dead stock reads "not moving"', () => {
    const r = buildBoard({stores: [block('5', [item('TWC', {deadStock: true, status: 'healthy'})])], catalog, warehouse: {}, config: cfg, shipments: [], currentMonth: '2026-10', today: TODAY, store: '5'})[0];
    expect(r.status).toBe('not_moving');
    expect(r.warehouse).toBeNull();
    expect(r.produceBy).toBeNull();
  });
});

describe('lastsLabel', () => {
  it('days under ~6 weeks, months after', () => {
    expect(lastsLabel(12.7)).toBe('~12 days');
    expect(lastsLabel(93)).toBe('~3.1 mo');
    expect(lastsLabel(Infinity)).toBe('not selling');
    expect(lastsLabel(0)).toBe('runs out');
    expect(lastsLabel(null)).toBeNull();
  });
});

describe('review fixes', () => {
  it('a shipment that covers the whole need clears "ship by" (nothing left to send)', () => {
    const ship = {id: 's1', storeCode: '1', itemCode: 'LIP', qty: 60, shippedOn: '2026-10-19', arrivesOn: '2026-10-21'};
    const rows = buildBoard({
      stores: [block('1', [item('LIP', {onHand: 0, status: 'out', suggestedOrder: 60, stockOutDate: null, coverDays: 0})])],
      catalog,
      warehouse: {LIP: 200},
      config: cfg,
      shipments: [ship],
      currentMonth: '2026-10',
      today: TODAY,
      store: '1',
    });
    expect(rows[0].need).toBe(0);
    expect(rows[0].shipBy).toBeNull();
    expect(boardSummary(rows, TODAY).shipNow).toBe(0);
  });
  it('"today" is the Philippine date, not UTC', () => {
    // 2026-10-20 18:30 UTC = 2026-10-21 02:30 in Manila.
    expect(manilaDate(new Date('2026-10-20T18:30:00Z'))).toBe('2026-10-21');
    expect(manilaDate(new Date('2026-10-20T15:30:00Z'))).toBe('2026-10-20');
  });
});
