import {describe, expect, it} from 'vitest';
import {forecastWindow, salesYear, type MonthStatus} from './goldline-forecast';
import type {StoreCount} from './goldline-restock';
import {itemProjection, itemStoreLines, itemTotals, itemYear, sendOf, type SavedLine} from './goldline-restock-item';

// Staging's MPEPC at Cubao (store 1), run of Oct 28 2026: covers Nov to Jan.
const RUN = '2026-10-28';
const W = forecastWindow(RUN, {windowMonths: 3, safetyMonths: 1});
const YEAR = salesYear(RUN);
const MPEPC = [30, 47, 76, 46, 40, 44, 66, 71, 60, 27, 33, 62];
const status = (missing: string[] = []): MonthStatus[] => YEAR.map((month) => ({month, loaded: !missing.includes(month), units: 1000, unlinkedUnits: 0}));
const count = (onHand: number | null, periodEnd = '2026-10-15'): StoreCount => ({periodEnd, onHand: new Map([['MPEPC', onHand]])});

const lines = (over: Partial<Parameters<typeof itemStoreLines>[0]> = {}) =>
  itemStoreLines({
    itemCode: 'MPEPC',
    window: W,
    months: status(),
    history: [{storeCode: '1', units: [47, 76, 46]}],
    inScope: new Set(['1', '2']),
    retired: false,
    openFlagStores: new Set(),
    counts: new Map([['1', count(8)]]),
    shipments: [],
    warehouse: 1000,
    saved: new Map(),
    ...over,
  });

describe('itemYear', () => {
  it('marks last year’s window and safety month in the 12 months before the run', () => {
    const y = itemYear(status(), W, MPEPC);
    expect(y.map((m) => m.month)).toEqual(YEAR);
    expect(y.filter((m) => m.inWindow).map((m) => [m.month, m.units])).toEqual([['2025-11', 47], ['2025-12', 76], ['2026-01', 46]]);
    expect(y.filter((m) => m.safety).map((m) => m.month)).toEqual(['2026-01']);
  });
  it('gives no number for a month that isn’t loaded', () => {
    const y = itemYear(status(['2026-02']), W, MPEPC);
    expect(y.find((m) => m.month === '2026-02')).toMatchObject({loaded: false, units: null});
  });
});

describe('itemProjection', () => {
  it('ends the window at the safety stock with the full send', () => {
    const p = itemProjection({window: W, lastYearUnits: [47, 76, 46], have: 8, send: 207});
    expect(p.map((m) => [m.month, m.lastYear, m.units, m.stockWith, m.stockWithout])).toEqual([
      ['2026-11', '2025-11', 47, 168, 0],
      ['2026-12', '2025-12', 76, 92, 0],
      ['2027-01', '2026-01', 46, 46, 0],
    ]);
  });
  it('stops when a month or the stock is unknown', () => {
    expect(itemProjection({window: W, lastYearUnits: [47, null, 46], have: 8, send: 207}).map((m) => m.stockWith)).toEqual([168, null, null]);
    expect(itemProjection({window: W, lastYearUnits: [47, 76, 46], have: null, send: null}).every((m) => m.stockWith == null && m.stockWithout == null)).toBe(true);
  });
});

describe('itemStoreLines', () => {
  it('works out the same send as the run (169 − 8 + 46 = 207)', () => {
    const [l] = lines();
    expect(l).toMatchObject({storeCode: '1', need: 169, safety: 46, onHand: 8, suggested: 207, state: 'send', saved: false, decision: null});
    expect(sendOf(l)).toBe(207);
  });

  it('holds a store with no count, and a blank row on the form', () => {
    const [a] = lines({counts: new Map()});
    expect(a.holds).toContain('no_count');
    const [b] = lines({counts: new Map([['1', count(null)]])});
    expect(b.holds).toContain('blank_on_form');
    expect(sendOf(b)).toBeNull();
  });

  it('caps the stores together at the warehouse', () => {
    const ls = lines({
      history: [{storeCode: '1', units: [47, 76, 46]}, {storeCode: '2', units: [47, 76, 46]}],
      counts: new Map([['1', count(8)], ['2', count(8)]]),
      warehouse: 207,
    });
    expect(ls.map((l) => l.suggested)).toEqual([104, 103]);
    expect(ls.every((l) => l.warehouseShort)).toBe(true);
  });

  it('shows the saved line and decision over the live numbers', () => {
    const saved = new Map<string, SavedLine>([
      ['1', {id: 'r1', suggested: 207, rawSend: 207, warehouseShort: false, holds: [], decision: 'edited', finalQty: 150, remark: 'slow month'}],
    ]);
    const [l] = lines({saved});
    expect(l).toMatchObject({saved: true, decision: 'edited', finalQty: 150, need: 169, onHand: 8, id: 'r1'});
    expect(sendOf(l)).toBe(150);
  });

  it('takes approved units off the warehouse before capping the rest', () => {
    const saved = new Map<string, SavedLine>([['1', {id: 'r1', suggested: 150, rawSend: 207, warehouseShort: true, holds: [], decision: 'approved', finalQty: 150, remark: null}]]);
    const ls = lines({
      history: [{storeCode: '1', units: [47, 76, 46]}, {storeCode: '2', units: [47, 76, 46]}],
      counts: new Map([['1', count(8)], ['2', count(8)]]),
      warehouse: 200,
      saved,
    });
    expect(ls.find((l) => l.storeCode === '2')).toMatchObject({saved: false, suggested: 50, warehouseShort: true});
  });
});

describe('itemTotals', () => {
  it('adds up ready stores; held stores count only in last year', () => {
    const ls = lines({
      history: [{storeCode: '1', units: [47, 76, 46]}, {storeCode: '2', units: [10, 10, 10]}],
      counts: new Map([['1', count(8)]]),
    });
    const t = itemTotals(ls, 3);
    expect(t).toMatchObject({stores: 2, ready: 1, held: 1, need: 199, onHand: 8, send: 207, lyUnits: [47, 76, 46]});
  });
});
