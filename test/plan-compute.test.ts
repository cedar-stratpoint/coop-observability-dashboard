import {describe, expect, it} from 'vitest';
import {assemblePlan, cardMonths, cmLadder, currentMonthKey, fmtPlan, METRICS, metricStatus, monthPhase, monthProgress, runwayMonths, stepWindow, windowStart} from '../src/plan-compute';

const MONTHS = Array.from({length: 17}, (_, i) => `${2026 + Math.floor((7 + i) / 12)}-${String(((7 + i) % 12) + 1).padStart(2, '0')}-01`);

describe('metricStatus', () => {
  const base = {direction: 'higher' as const, target: 100, phase: 'past' as const, hasSource: true};
  it('met means actual >= target', () => {
    expect(metricStatus({...base, actual: 100})).toBe('ok');
    expect(metricStatus({...base, actual: 140})).toBe('ok');
    expect(metricStatus({...base, actual: 99.9})).toBe('bad');
  });
  it('is inverted for lower-is-better metrics', () => {
    expect(metricStatus({...base, direction: 'lower', actual: 90})).toBe('ok');
    expect(metricStatus({...base, direction: 'lower', actual: 100})).toBe('ok');
    expect(metricStatus({...base, direction: 'lower', actual: 101})).toBe('bad');
  });
  it('the current month is never red or green', () => {
    expect(metricStatus({...base, phase: 'current', actual: 500})).toBe('live');
    expect(metricStatus({...base, phase: 'current', actual: 1})).toBe('live');
    expect(metricStatus({...base, phase: 'current', actual: null})).toBe('live');
  });
  it('a missing actual is grey waiting, never red, and a future month is grey', () => {
    expect(metricStatus({...base, actual: null})).toBe('waiting');
    expect(metricStatus({...base, phase: 'future', actual: 500})).toBe('future');
  });
  it('a metric with no source is tagged, never red or green', () => {
    expect(metricStatus({...base, hasSource: false, actual: 500})).toBe('nosource');
    expect(metricStatus({...base, hasSource: false, actual: null})).toBe('nosource');
  });
  it('a target of 0 compares like any other', () => {
    expect(metricStatus({...base, target: 0, actual: 0})).toBe('ok');
  });
});

describe('cmLadder (the workbook ladder, made-up inputs in thousands)', () => {
  it('follows the workbook ladder', () => {
    const r = cmLadder({gmv: 200, cogs: 70, platformFees: 25, fulfilment: 8, eventCosts: 30, adSpend: 55, overhead: 150});
    expect(r.cm1).toBeCloseTo(130, 3);
    expect(r.cm2).toBeCloseTo(67, 3);
    expect(r.cm3).toBeCloseTo(12, 2);
    expect(r.ebitda).toBeCloseTo(-138, 2);
    expect(r.cm1Pct).toBeCloseTo(0.65, 3);
  });
  it('is null when GMV is 0 or missing (no division)', () => {
    expect(cmLadder({gmv: 0, cogs: 1, platformFees: 0, fulfilment: 0, eventCosts: 0, adSpend: 0, overhead: 0}).cm1Pct).toBeNull();
  });
});

describe('metric catalog', () => {
  it('ROAS is typed (workbook input); CAC, customers, coverage and cash are calculated by the workbook formula', () => {
    expect(METRICS.find((m) => m.id === 'roas')?.source).toBe('typed');
    for (const id of ['cac', 'customers', 'coverage', 'cash']) expect(METRICS.find((m) => m.id === id)?.source, id).toBe('calc');
  });
  it('CAC is lower-is-better', () => expect(METRICS.find((m) => m.id === 'cac')?.direction).toBe('lower'));
});

describe('months', () => {
  it('uses the Manila calendar month', () => {
    expect(currentMonthKey(new Date('2026-11-30T17:00:00Z'))).toBe('2026-12'); // 01:00 Dec 1 in Manila
    expect(currentMonthKey(new Date('2026-11-05T01:00:00Z'))).toBe('2026-11');
  });
  it('phases', () => {
    expect(monthPhase('2026-10-01', '2026-11')).toBe('past');
    expect(monthPhase('2026-11-01', '2026-11')).toBe('current');
    expect(monthPhase('2026-12-01', '2026-11')).toBe('future');
  });
  it('cards: last two calendar months and the month to date', () => {
    expect(cardMonths(MONTHS, '2026-11')).toEqual(['2026-09-01', '2026-10-01', '2026-11-01']);
  });
  it('cards clamp at both ends of the plan', () => {
    expect(cardMonths(MONTHS, '2026-08')).toEqual(['2026-08-01']);
    expect(cardMonths(MONTHS, '2026-07')).toEqual(['2026-08-01']);
    expect(cardMonths(MONTHS, '2028-03').at(-1)).toBe('2027-12-01');
  });
});

describe('mobile window', () => {
  it('opens on the 3 months ending at the current one and steps by 3, clamped', () => {
    expect(windowStart(17, 3, 3)).toBe(1); // current index 3 -> months 1..3
    expect(windowStart(17, 3, 0)).toBe(0);
    expect(stepWindow(1, 1, 17, 3)).toBe(4);
    expect(stepWindow(0, -1, 17, 3)).toBe(0);
    expect(stepWindow(14, 1, 17, 3)).toBe(14);
  });
});

describe('runwayMonths: cash / trailing 3-month average net cash burn, information only', () => {
  const c = [100, 80, 60, 40, 60, 90]; // cash at month end, opening cash 120
  it('burning: cash divided by the average monthly fall over the last 3 months', () => {
    expect(runwayMonths(c, 120, 2)).toBeCloseTo(60 / ((120 - 60) / 3)); // 3 months
    expect(runwayMonths(c, 120, 3)).toBeCloseTo(40 / ((100 - 40) / 3));
  });
  it('net change counts: a month that gains cash offsets burn', () => {
    expect(runwayMonths([100, 50, 100, 90], 100, 3)).toBeCloseTo(90 / (10 / 3)); // 100 -> 90 over 3 months, with a dip and a recovery in between
  });
  it('not burning when the 3-month net cash flow is not negative', () => {
    expect(runwayMonths(c, 120, 4)).toBeCloseTo(60 / (20 / 3)); // 80 -> 60 is still a fall
    expect(runwayMonths(c, 120, 5)).toBe('not-burning');
    expect(runwayMonths([10, 10, 10], 10, 2)).toBe('not-burning');
  });
  it('waits (null) with fewer than 3 months of history, an unknown cash or an unknown opening balance', () => {
    expect(runwayMonths(c, 120, 0)).toBeNull();
    expect(runwayMonths(c, 120, 1)).toBeNull();
    expect(runwayMonths([100, 80, null, 40], 120, 2)).toBeNull();
    expect(runwayMonths([null, 80, 60, 40], 120, 3)).toBeNull();
    expect(runwayMonths(c, null, 2)).toBeNull();
  });
  it('no cash left is 0 months', () => {
    expect(runwayMonths([30, 10, -5], 60, 2)).toBe(0);
  });
});


describe('fmtPlan', () => {
  it('formats units', () => {
    expect(fmtPlan('php', 8500)).toBe('₱8.5k');
    expect(fmtPlan('php', 123500)).toBe('₱124k');
    expect(fmtPlan('php', 1234567)).toBe('₱1,235k');
    expect(fmtPlan('php', -162000)).toBe('−₱162k');
    expect(fmtPlan('pct', 0.6125)).toBe('61.3%');
    expect(fmtPlan('x', 2.5)).toBe('2.50x');
    expect(fmtPlan('peso', 290.97)).toBe('₱291');
    expect(fmtPlan('count', 16083.3)).toBe('16,083');
    expect(fmtPlan('months', 1.8)).toBe('1.8 mo');
    expect(fmtPlan('php', null)).toBe('—');
  });
});

describe('assemblePlan', () => {
  it('aligns rows to sorted months; a missing cell is null, not 0; unknown metrics are ignored', () => {
    const p = assemblePlan('v1', [
      {month: '2026-09-01', metric: 'gmv_total', value: '123500.00'},
      {month: '2026-08-01', metric: 'gmv_total', value: 70000},
      {month: '2026-08-01', metric: 'cash', value: -169000},
      {month: '2026-08-01', metric: 'mystery', value: 1},
    ]);
    expect(p.months).toEqual(['2026-08-01', '2026-09-01']);
    expect(p.targets.gmv_total).toEqual([70000, 123500]);
    expect(p.targets.cash).toEqual([-169000, null]);
    expect(p.targets.mystery).toBeUndefined();
    expect(p.source).toBe('db');
  });
});

describe('monthProgress (BHR-08: this month so far against the full-month target, PH day)', () => {
  const nov = {month: '2026-11-01', target: 600_000};
  it('mid month: share of the target, what is left, days left counting today as done', () => {
    expect(monthProgress({...nov, actual: 172_000, today: '2026-11-10'})).toEqual({pct: (172 / 600) * 100, toGo: 428_000, dayOfMonth: 10, daysInMonth: 30, daysLeft: 20, reached: false});
  });
  it('day 1 and the last day', () => {
    expect(monthProgress({...nov, actual: 0, today: '2026-11-01'})).toMatchObject({pct: 0, toGo: 600_000, dayOfMonth: 1, daysLeft: 29});
    expect(monthProgress({...nov, actual: 500_000, today: '2026-11-30'})).toMatchObject({dayOfMonth: 30, daysLeft: 0, reached: false});
  });
  it('knows 31, 30 and 28 day months', () => {
    expect(monthProgress({...nov, month: '2026-12-01', actual: 1, today: '2026-12-05'})).toMatchObject({daysInMonth: 31, daysLeft: 26});
    expect(monthProgress({...nov, actual: 1, today: '2026-11-05'})).toMatchObject({daysInMonth: 30, daysLeft: 25});
    expect(monthProgress({...nov, month: '2027-02-01', actual: 1, today: '2027-02-05'})).toMatchObject({daysInMonth: 28, daysLeft: 23});
  });
  it('over target: reached, nothing to go, pct above 100 (the bar caps its own width)', () => {
    expect(monthProgress({...nov, actual: 660_000, today: '2026-11-20'})).toMatchObject({pct: expect.closeTo(110, 9), toGo: 0, reached: true});
    expect(monthProgress({...nov, actual: 600_000, today: '2026-11-20'})).toMatchObject({pct: 100, toGo: 0, reached: true});
  });
  it('no target (null or 0): no share, no to-go, never reached', () => {
    for (const target of [null, 0]) expect(monthProgress({...nov, target, actual: 100, today: '2026-11-10'})).toMatchObject({pct: null, toGo: null, reached: false, daysLeft: 20});
  });
  it('no actual yet: no share, never reached, never 0', () => {
    expect(monthProgress({...nov, actual: null, today: '2026-11-10'})).toMatchObject({pct: null, toGo: null, reached: false});
  });
  it('clamps a today outside the month', () => {
    expect(monthProgress({...nov, actual: 1, today: '2026-12-02'})).toMatchObject({dayOfMonth: 30, daysLeft: 0});
    expect(monthProgress({...nov, actual: 1, today: '2026-10-31'})).toMatchObject({dayOfMonth: 0, daysLeft: 30});
  });
});
