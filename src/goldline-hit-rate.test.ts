import {describe, expect, it} from 'vitest';
import {
  byProductLine,
  byRun,
  byStore,
  change,
  deltaVsPrevious,
  filterLines,
  isHit,
  latestRemarks,
  missDirection,
  mostMissed,
  tally,
  type DecidedLine,
} from './goldline-hit-rate';

const line = (over: Partial<DecidedLine> = {}): DecidedLine => ({
  cycle: '2026-11-a',
  runDate: '2026-11-03',
  storeCode: '1',
  itemCode: 'USMLLC04',
  productLine: 'Ultra Stay Matte Liquid Lip Color',
  decision: 'approved',
  suggested: 52,
  finalQty: 52,
  remark: null,
  decidedBy: 'owner@nichido',
  decidedAt: '2026-11-03T04:00:00Z',
  ...over,
});
const edited = (finalQty: number, over: Partial<DecidedLine> = {}) => line({decision: 'edited', finalQty, remark: 'Mall sale ends this week', ...over});
const rejected = (over: Partial<DecidedLine> = {}) => line({decision: 'rejected', finalQty: 0, remark: 'Slow seller, skip', ...over});

describe('hit or miss', () => {
  it('approved as is is a hit; edited and rejected are misses', () => {
    expect(isHit(line())).toBe(true);
    expect(isHit(edited(40))).toBe(false);
    expect(isHit(rejected())).toBe(false);
  });
  it('rejected and edited down are Coop too high, edited up too low', () => {
    expect(missDirection(rejected())).toBe('too_high');
    expect(missDirection(edited(40))).toBe('too_high');
    expect(missDirection(edited(60))).toBe('too_low');
    expect(missDirection(line())).toBeNull();
  });
  it('change is final − Coop’s number; a rejected line is off by all of it', () => {
    expect(change(edited(40))).toBe(-12);
    expect(change(edited(60))).toBe(8);
    expect(change(rejected())).toBe(-52);
    expect(change(line())).toBe(0);
  });
});

describe('tally', () => {
  it('adds up hits, misses, rate and units off each way', () => {
    expect(tally([line(), line(), edited(40), edited(60), rejected()])).toEqual({
      decided: 5,
      hits: 2,
      edited: 2,
      rejected: 1,
      misses: 3,
      rate: 0.4,
      tooHigh: 12 + 52,
      tooLow: 8,
    });
  });
  it('has no rate when nothing is decided', () => {
    expect(tally([]).rate).toBeNull();
  });
});

describe('runs', () => {
  const lines = [
    line({cycle: '2026-10-b', runDate: '2026-10-30'}),
    rejected({cycle: '2026-10-b', runDate: '2026-10-30'}),
    line(),
    line(),
    line(),
    edited(40),
  ];
  it('tallies each run, oldest first', () => {
    expect(byRun(lines).map((r) => [r.cycle, r.decided, r.rate])).toEqual([
      ['2026-10-b', 2, 0.5],
      ['2026-11-a', 4, 0.75],
    ]);
  });
  it('compares the latest run with the one before, in points', () => {
    expect(deltaVsPrevious(byRun(lines))).toEqual({latest: 0.75, previous: 0.5, points: 25});
    expect(deltaVsPrevious(byRun([line()]))).toEqual({latest: 1, previous: null, points: null});
    expect(deltaVsPrevious([])).toBeNull();
  });
});

describe('breakdowns', () => {
  const lines = [
    line({storeCode: '1'}),
    edited(40, {storeCode: '1'}),
    line({storeCode: '2'}),
    line({storeCode: '2', itemCode: 'TWC01154', productLine: 'Two Way Cake (21 Grams)'}),
    rejected({storeCode: '3', productLine: null, itemCode: 'X1'}),
  ];
  it('ranks stores and product lines lowest hit rate first', () => {
    expect(byStore(lines).map((s) => [s.key, s.rate])).toEqual([
      ['3', 0],
      ['1', 0.5],
      ['2', 1],
    ]);
    expect(byProductLine(lines).map((s) => s.key)).toEqual(['Other', 'Ultra Stay Matte Liquid Lip Color', 'Two Way Cake (21 Grams)']);
  });
  it('lists the most missed items with the typical change and latest remark', () => {
    const items = mostMissed([
      edited(40, {decidedAt: '2026-11-01T00:00:00Z', remark: 'Older remark'}),
      edited(30, {decidedAt: '2026-11-03T00:00:00Z', remark: 'Newest remark'}),
      line(),
      rejected({itemCode: 'X1'}),
    ]);
    expect(items[0]).toEqual({itemCode: 'USMLLC04', productLine: 'Ultra Stay Matte Liquid Lip Color', missed: 2, decided: 3, typicalChange: -17, latestRemark: 'Newest remark'});
    expect(items.map((i) => i.itemCode)).toEqual(['USMLLC04', 'X1']);
  });
  it('lists the newest miss remarks only', () => {
    const r = latestRemarks([line({remark: 'not a miss'}), edited(40, {decidedAt: '2026-11-01T00:00:00Z'}), rejected({decidedAt: '2026-11-03T00:00:00Z'}), edited(10, {remark: ' '})]);
    expect(r.map((l) => l.decision)).toEqual(['rejected', 'edited']);
  });
  it('filters by store, product line and who decided', () => {
    expect(filterLines(lines, {store: '2'})).toHaveLength(2);
    expect(filterLines(lines, {productLine: 'Other'})).toHaveLength(1);
    expect(filterLines(lines, {decidedBy: 'owner@nichido'})).toHaveLength(5);
    expect(filterLines([line({decidedBy: null})], {decidedBy: ''})).toHaveLength(1);
  });
});
