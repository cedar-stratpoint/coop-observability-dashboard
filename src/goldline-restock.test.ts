import {describe, expect, it} from 'vitest';
import type {ForecastLine} from './goldline-forecast';
import type {Shipment} from './goldline-supply';
import {
  buildRecommendations,
  capToWarehouse,
  decidable,
  lineState,
  overallScore,
  runCycle,
  sendFor,
  splitForSave,
  storeScores,
  type Recommendation,
  type StoreCount,
} from './goldline-restock';

// The meeting's Wedge Sponge: last year Nov 15 + Dec 25 + Jan 10, safety = January.
const line = (over: Partial<ForecastLine> = {}): ForecastLine => ({storeCode: '1', itemCode: 'WEDGE', units: [15, 25, 10], need: 50, safety: 10, holds: [], ...over});
const count = (items: Record<string, number | null>, periodEnd = '2026-10-15'): StoreCount => ({periodEnd, onHand: new Map(Object.entries(items))});
const ship = (over: Partial<Shipment>): Shipment => ({id: 's', storeCode: '1', itemCode: 'WEDGE', qty: 5, shippedOn: '2026-10-20', arrivesOn: '2026-10-23', ...over});

const build = (over: Partial<Parameters<typeof buildRecommendations>[0]> = {}) =>
  buildRecommendations({lines: [line()], counts: new Map([['1', count({WEDGE: 7})]]), shipments: [], warehouse: {WEDGE: 1000}, ...over});

describe('sendFor', () => {
  it('is the meeting example: 50 − 7 + 10 = 53', () => {
    expect(sendFor(50, 10, 7, 0)).toEqual({cover: 60, have: 7, send: 53});
  });
  it('sends nothing when the store already holds the window plus safety', () => {
    expect(sendFor(50, 10, 60, 0).send).toBe(0);
    expect(sendFor(50, 10, 80, 0).send).toBe(0);
  });
  it('counts stock on the way as stock the store has', () => {
    expect(sendFor(50, 10, 7, 20).send).toBe(33);
  });
  it('treats a negative or missing count as 0', () => {
    expect(sendFor(50, 10, -2, 0).send).toBe(60);
    expect(sendFor(50, 10, null, 0).send).toBe(60);
  });
});

describe('buildRecommendations', () => {
  it('suggests 53 for the meeting example, ready to decide', () => {
    const [r] = build();
    expect(r).toMatchObject({onHand: 7, onHandPeriodEnd: '2026-10-15', onTheWay: 0, rawSend: 53, suggested: 53, warehouseShort: false, holds: []});
    expect(lineState(r)).toBe('send');
    expect(decidable(r)).toBe(true);
  });

  it('marks a covered line as nothing to send', () => {
    const [r] = build({counts: new Map([['1', count({WEDGE: 60})]])});
    expect(r.suggested).toBe(0);
    expect(lineState(r)).toBe('covered');
    expect(decidable(r)).toBe(false);
  });

  it('holds a store with no counted form (no_count), keeping F10 holds in order', () => {
    const [r] = build({lines: [line({holds: ['open_flag']})], counts: new Map()});
    expect(r.holds).toEqual(['no_count', 'open_flag']);
    expect(r.suggested).toBeNull();
    expect(lineState(r)).toBe('held');
  });

  it('keeps F10 holds and gives no number', () => {
    const [r] = build({lines: [line({holds: ['retired']})]});
    expect(r.holds).toEqual(['retired']);
    expect(r.rawSend).toBeNull();
  });

  it('holds a product whose row is blank or missing on the latest form (blank_on_form)', () => {
    for (const items of [{WEDGE: null}, {OTHER: 4}] as Array<Record<string, number | null>>) {
      const [r] = build({lines: [line({holds: ['open_flag']})], counts: new Map([['1', count(items)]])});
      expect(r.holds).toEqual(['blank_on_form', 'open_flag']);
      expect(r.suggested).toBeNull();
    }
  });

  it('subtracts shipments arriving after the latest count only', () => {
    const shipments = [ship({qty: 20, arrivesOn: '2026-10-23'}), ship({id: 'old', qty: 99, arrivesOn: '2026-10-10'})];
    const [r] = build({shipments});
    expect(r.onTheWay).toBe(20);
    expect(r.suggested).toBe(33);
  });
});

describe('capToWarehouse', () => {
  const rec = (storeCode: string, rawSend: number, itemCode = 'X'): Recommendation => ({
    storeCode, itemCode, lyUnits: [], need: 0, safety: 0, onHand: 0, onHandPeriodEnd: null, onTheWay: 0, rawSend, suggested: rawSend, warehouseShort: false, holds: [],
  });

  it('leaves lines alone when the warehouse covers them all', () => {
    const out = capToWarehouse([rec('1', 40), rec('2', 50)], {X: 90});
    expect(out.map((r) => [r.suggested, r.warehouseShort])).toEqual([[40, false], [50, false]]);
  });

  it('shares the warehouse in proportion and never goes over it', () => {
    const out = capToWarehouse([rec('1', 80), rec('2', 40)], {X: 90});
    expect(out.map((r) => r.suggested)).toEqual([60, 30]);
    expect(out.every((r) => r.warehouseShort)).toBe(true);
  });

  it('gives the leftover units to the largest remainders', () => {
    // 10 units over 3 equal asks: 3.33 each → 3, 3, 3 and one left, to store 1 (code order).
    const out = capToWarehouse([rec('2', 5), rec('1', 5), rec('3', 5)], {X: 10});
    expect(Object.fromEntries(out.map((r) => [r.storeCode, r.suggested]))).toEqual({1: 4, 2: 3, 3: 3});
    expect(out.reduce((a, r) => a + r.suggested!, 0)).toBe(10);
  });

  it('takes what this run already approved off the warehouse first', () => {
    const out = capToWarehouse([rec('1', 50)], {X: 60}, {X: 30});
    expect(out[0].suggested).toBe(30);
  });

  it('sends nothing for an item with no warehouse stock', () => {
    const out = capToWarehouse([rec('1', 50, 'GONE')], {});
    expect(out[0]).toMatchObject({rawSend: 50, suggested: 0, warehouseShort: true});
  });

  it('caps each item on its own', () => {
    const out = capToWarehouse([rec('1', 50, 'A'), rec('1', 50, 'B')], {A: 10, B: 100});
    expect(out.map((r) => r.suggested)).toEqual([10, 50]);
  });
});

describe('storeScores', () => {
  const row = (storeCode: string, decision: 'pending' | 'approved' | 'edited' | 'rejected', suggested: number | null = 10) => ({storeCode, decision, suggested, holds: []});

  it('is approved as is ÷ decided, per store', () => {
    const s = storeScores([row('1', 'approved'), row('1', 'approved'), row('1', 'edited'), row('1', 'rejected'), row('1', 'pending'), row('2', 'pending')]);
    expect(s).toEqual([
      {storeCode: '1', decided: 4, approved: 2, edited: 1, rejected: 1, pending: 1, score: 0.5},
      {storeCode: '2', decided: 0, approved: 0, edited: 0, rejected: 0, pending: 1, score: null},
    ]);
    expect(overallScore(s)).toBe(0.5);
  });

  it('ignores covered and held lines that were never decided', () => {
    expect(storeScores([row('1', 'pending', 0), row('1', 'pending', null)])).toEqual([]);
  });
});

describe('runCycle and splitForSave', () => {
  it('splits the month at the 15th', () => {
    expect(runCycle('2026-10-15')).toBe('2026-10-a');
    expect(runCycle('2026-10-31')).toBe('2026-10-b');
    expect(runCycle('2026-11-01')).toBe('2026-11-a');
  });

  it('saves counted in-scope lines and totals the rest', () => {
    const recs = build({
      lines: [line(), line({storeCode: '2'}), line({storeCode: '2', itemCode: 'B'}), line({storeCode: '3', holds: ['out_of_scope']})],
    });
    const {keep, skipped} = splitForSave(recs);
    expect(keep.map((r) => r.storeCode)).toEqual(['1']);
    expect(skipped).toEqual({no_count: {stores: 1, lines: 2}, out_of_scope: {stores: 1, lines: 1}});
  });
});
