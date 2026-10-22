import {describe, expect, it} from 'vitest';
import {runGates} from '../src/shopee-import/gates';
import {buildPlan, FREEZE_DAYS} from '../src/shopee-import/plan';
import {parseSalesOverview} from '../src/shopee-import/sales-overview';
import type {DayFigures} from '../src/shopee-import/types';
import {salesOverviewFile, week} from './support/shopee-fixture';

const TODAY = '2026-10-25'; // PH today: 24 Oct and earlier are closed days
const parse = async (days: ReturnType<typeof week>, opts = {}) => parseSalesOverview(await salesOverviewFile(days, opts));

describe('runGates', () => {
  it('accepts a clean week and a short span (a Monday to Saturday file is fine)', async () => {
    expect((await runGates(await parse(week('2026-10-12', [1, 2, 3, 4, 5, 6, 7])), {today: TODAY})).failures).toEqual([]);
    expect((await runGates(await parse(week('2026-10-19', [1, 2, 3, 4, 5, 6])), {today: TODAY})).failures).toEqual([]);
  });

  it('rejects a file whose daily rows do not add up to its own total', async () => {
    const g = runGates(await parse(week('2026-10-12', [100, 200, 300]), {summaryConf: 999}), {today: TODAY});
    expect(g.failures.map((f) => f.code)).toContain('SUM_CONFIRMED');
  });

  it('rejects a missing day and a repeated day', async () => {
    const gap = week('2026-10-12', [1, 2, 3, 4]).filter((d) => d.day !== '2026-10-14');
    expect(runGates(await parse(gap, {summaryConf: 1 + 2 + 4, summaryPlaced: 7}), {today: TODAY}).failures.map((f) => f.code)).toContain('GAP');
    const dup = [...week('2026-10-12', [1, 2]), ...week('2026-10-13', [5])];
    expect(runGates(await parse(dup, {summaryConf: 8, summaryPlaced: 8}), {today: TODAY}).failures.map((f) => f.code)).toContain('DUPLICATE_DAY');
  });

  it('accepts a day where confirmed is above placed (confirmed counts orders confirmed that day, earlier ones included), and rejects a file whose name period is not its period', async () => {
    const odd = week('2026-10-12', [100, 200]);
    odd[0].salesPlaced = 50;
    expect(runGates(await parse(odd, {summaryPlaced: 250, summaryConf: 300}), {today: TODAY}).failures).toEqual([]);
    const g = runGates(await parse(week('2026-10-12', [1, 2])), {today: TODAY, filenamePeriod: {from: '2026-10-05', to: '2026-10-11'}});
    expect(g.failures.map((f) => f.code)).toContain('FILENAME_MISMATCH');
  });

  it('leaves out today and later (an open day) but still checks the file as a whole', async () => {
    const g = runGates(await parse(week('2026-10-19', [1, 2, 3, 4, 5, 6, 7])), {today: '2026-10-24'}); // 24 Oct is open
    expect(g.failures).toEqual([]);
    expect(g.days.map((d) => d.day)).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']);
    expect(g.openSkipped).toEqual(['2026-10-24', '2026-10-25']);
    expect(runGates(await parse(week('2026-10-25', [1, 2])), {today: '2026-10-25'}).failures.map((f) => f.code)).toContain('ALL_DAYS_OPEN');
  });
});

const fig = (day: string, sales: number, placed = sales): DayFigures => ({day, salesPlaced: placed, salesConfirmed: sales, ordersPlaced: 3, ordersConfirmed: 3, unitsPlaced: 5, unitsConfirmed: 5, buyersPlaced: 3, buyersConfirmed: 3, visitors: 100});
const current = (...d: DayFigures[]): Map<string, DayFigures> => new Map(d.map((x) => [x.day, x]));
const base = {today: TODAY, freezeDays: FREEZE_DAYS, restate: false, onlyNew: false};

describe('buildPlan (loaded to 22 Oct, next file covers 19 to 24 Oct)', () => {
  const have = current(fig('2026-10-19', 1000), fig('2026-10-20', 2000), fig('2026-10-21', 3070), fig('2026-10-22', 500));
  const incoming = [fig('2026-10-19', 1000), fig('2026-10-20', 2000), fig('2026-10-21', 2980), fig('2026-10-22', 500), fig('2026-10-23', 800), fig('2026-10-24', 900)];

  it('adds the new days, leaves equal days, replaces recent changed days, and carries every day of the span', () => {
    const p = buildPlan(incoming, have, base);
    expect(p.newDays).toEqual(['2026-10-23', '2026-10-24']);
    expect(p.unchanged).toEqual(['2026-10-19', '2026-10-20', '2026-10-22']);
    expect(p.changed).toEqual([{day: '2026-10-21', before: 3070, after: 2980, pct: -2.9}]);
    expect(p.rows.map((r) => r.day)).toHaveLength(6); // the whole span, so the import covers its window without holes
    expect(p.rows.find((r) => r.day === '2026-10-21')?.salesConfirmed).toBe(2980);
  });

  it('only-new keeps every loaded day as it is and still adds the new days', () => {
    const p = buildPlan(incoming, have, {...base, onlyNew: true});
    expect(p.newDays).toEqual(['2026-10-23', '2026-10-24']);
    expect(p.keptCurrent).toEqual(['2026-10-21']);
    expect(p.rows.find((r) => r.day === '2026-10-21')?.salesConfirmed).toBe(3070);
  });

  it('freezes days older than the window: a changed old day is blocked and keeps its current figures, unless restated', () => {
    const old = current(fig('2026-08-01', 1000));
    const blocked = buildPlan([fig('2026-08-01', 1500)], old, base);
    expect(blocked.frozenBlocked).toEqual(['2026-08-01']);
    expect(blocked.changed).toEqual([]);
    expect(blocked.rows[0].salesConfirmed).toBe(1000);
    const restated = buildPlan([fig('2026-08-01', 1500)], old, {...base, restate: true});
    expect(restated.changed.map((c) => c.day)).toEqual(['2026-08-01']);
    expect(restated.rows[0].salesConfirmed).toBe(1500);
  });

  it('flags a big change (over 5% and over 100 pesos) for the person to look at', () => {
    const p = buildPlan([fig('2026-10-21', 1000)], current(fig('2026-10-21', 3070)), base);
    expect(p.flags.map((f) => f.code)).toContain('BIG_CHANGE');
    expect(buildPlan([fig('2026-10-21', 3060)], current(fig('2026-10-21', 3070)), base).flags).toEqual([]);
  });

  it('says there is nothing to do when nothing is new or changed', () => {
    const p = buildPlan([fig('2026-10-19', 1000)], current(fig('2026-10-19', 1000)), base);
    expect(p.hasEffect).toBe(false);
  });
});
