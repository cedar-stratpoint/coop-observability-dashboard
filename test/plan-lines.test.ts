import {describe, expect, it} from 'vitest';
import {ALL_LINE_IDS, REQUIRED_COUNT, cashPerFormula, cashSeries, GAP, LINES, MEASURE_LINES, METRICS, filledCount, lineInputText, lineUnit, lineUnitWords, marginCells, metricStatus, monthComplete, parseLineInput, parseThousands, toThousands, validateLine} from '../src/plan-compute';
import {canEditPlan, isActiveCoopAdmin} from '../src/company';

const ok = (value: number) => ({value, state: 'ok' as const});
const full = {cogs: [400], platform_fees: [50], fulfilment: [30], event_costs: [20], ad_marketplace: [10], ad_website: [5], event_marketing: [3], content_other: [2], overhead: [100]};

describe('the typed lines are the workbook INPUT rows only', () => {
  it('are the 21 inputs, one per itemised sheet row; cash and the totals are NOT typed (they are derived), and none may be negative', () => {
    expect(LINES.map((l) => l.id).sort()).toEqual(['accounting', 'ad_marketplace', 'ad_website', 'bridge_funding', 'content_socials', 'event_costs', 'event_marketing', 'events_cogs', 'freight_onetime', 'fulfilment', 'growth_consultant', 'inv_purchases_paid', 'liability_settlement', 'marketplace_cogs', 'other_spend', 'platform_fees', 'rent', 'rnd', 'salaries', 'tech', 'website_cogs']);
    expect(REQUIRED_COUNT).toBe(21);
    for (const derived of ['cash', 'cac', 'customers', 'coverage']) { expect(ALL_LINE_IDS).not.toContain(derived); expect(validateLine(derived, 1), derived).toBe('Unknown line.'); }
  });
  it('validateLine: rejects unknown lines, non-numbers and negative amounts; null clears', () => {
    expect(validateLine('marketplace_cogs', 10)).toBeNull();
    expect(validateLine('marketplace_cogs', 0)).toBeNull();
    expect(validateLine('cash', -500)).toBe('Unknown line.');
    expect(validateLine('marketplace_cogs', null)).toBeNull();
    for (const bad of [-1, NaN, Infinity, '12', undefined, {}]) expect(validateLine('marketplace_cogs', bad)).not.toBeNull();
    expect(validateLine('nope', 1)).toBe('Unknown line.');
    expect(validateLine('salaries', -0.01)).toMatch(/negative/);
  });
  it('parseThousands: empty is missing, 0 is a real 0, junk is rejected', () => {
    expect(parseThousands('')).toEqual({ok: true, pesos: null});
    expect(parseThousands('  ')).toEqual({ok: true, pesos: null});
    expect(parseThousands('0')).toEqual({ok: true, pesos: 0});
    expect(parseThousands('12.5')).toEqual({ok: true, pesos: 12500});
    expect(parseThousands('1,250')).toEqual({ok: true, pesos: 1250000});
    expect(parseThousands('-3')).toEqual({ok: true, pesos: -3000});
    for (const bad of ['abc', '1e3', '12a', '--1', '1.2.3']) expect(parseThousands(bad)).toEqual({ok: false});
    expect(toThousands(12500)).toBe('12.5');
    expect(toThousands(0)).toBe('0');
  });
  it('monthComplete needs all 21, a typed 0 counts, empty does not', () => {
    const lines = Object.fromEntries(LINES.map((l) => [l.id, [0]]));
    expect(monthComplete(lines, 0)).toBe(true);
    expect(filledCount(lines, 0)).toBe(21);
    expect(monthComplete({...lines, website_cogs: [null]}, 0)).toBe(false);
    expect(filledCount({...lines, website_cogs: [null]}, 0)).toBe(20);
  });
});

describe('marginCells follows the workbook ladder', () => {
  it('CM1 = GMV - COGS; CM2 less fees, fulfilment, event costs; CM3 less the four marketing lines; EBITDA less overhead; % of GMV', () => {
    const m = marginCells([ok(1000)], full);
    expect(m.cm1[0].value).toBe(600);
    expect(m.cm1_pct[0].value).toBeCloseTo(0.6);
    expect(m.cm2[0].value).toBe(500);
    expect(m.cm3[0].value).toBe(480);
    expect(m.ebitda[0].value).toBe(380);
    expect(m.ebitda_pct[0].value).toBeCloseTo(0.38);
  });
  it('a missing line leaves its level and the ones below empty, never 0', () => {
    const m = marginCells([ok(1000)], {...full, fulfilment: [null]});
    expect(m.cm1[0].value).toBe(600);
    expect(m.cm2[0]).toEqual(GAP);
    expect(m.cm3[0]).toEqual(GAP);
    expect(m.ebitda[0]).toEqual(GAP);
  });
  it('a typed 0 is a real 0 (CM1 equals GMV), and no GMV leaves everything empty', () => {
    expect(marginCells([ok(1000)], {...full, cogs: [0]}).cm1[0].value).toBe(1000);
    expect(marginCells([GAP], full).cm1[0]).toEqual(GAP);
    expect(marginCells([ok(0)], full).cm1_pct[0]).toEqual(GAP); // no percentage of zero GMV
  });
  it('a partial Total GMV gives partial margins', () => {
    const m = marginCells([{value: 1000, state: 'partial'}], full);
    expect(m.cm1[0].state).toBe('partial');
    expect(m.ebitda[0].state).toBe('partial');
  });
});

describe('canEditPlan', () => {
  it('Coop Admin and Zoomy company admin edit; everyone else does not', () => {
    expect(canEditPlan([{companyId: null, role: 'coop_admin'}])).toBe(true);
    expect(canEditPlan([{companyId: 'zoomy', role: 'company_admin'}])).toBe(true);
    expect(canEditPlan([{companyId: 'zoomy', role: 'store_manager'}])).toBe(false);
    expect(canEditPlan([{companyId: 'zoomy', role: 'analyst'}])).toBe(false);
    expect(canEditPlan([{companyId: 'goldline', role: 'company_admin'}])).toBe(false);
    expect(canEditPlan([])).toBe(false);
  });
  it('a suspended admin does not', () => {
    expect(canEditPlan([{companyId: null, role: 'coop_admin', status: 'suspended'}])).toBe(false);
    expect(canEditPlan([{companyId: 'zoomy', role: 'company_admin', status: 'suspended'}])).toBe(false);
    expect(isActiveCoopAdmin([{companyId: 'zoomy', role: 'company_admin'}])).toBe(false);
  });
});

import {applySnapshots, closeQueue, earlierUnclosed, lastPastMonths, closeWaiting, closeWaitingWho, daysSinceMonthEnd, nextEmptyLine, gmvSnapshot, lastDayOf, monthEnded, type ClosedMonth} from '../src/plan-compute';

describe('closing a month (pure)', () => {
  const closed = (n: number): ClosedMonth => ({by: 'a@x.com', at: '2026-10-31T10:00:00Z', planVersion: 1, gmv: {gmv_events: {value: n, state: 'ok'}, gmv_total: {value: n, state: 'ok'}}});
  it('lastDayOf handles month lengths and leap years', () => {
    expect(lastDayOf('2026-10-01')).toBe('2026-10-31');
    expect(lastDayOf('2026-02-01')).toBe('2026-02-28');
    expect(lastDayOf('2028-02')).toBe('2028-02-29');
  });
  it('monthEnded only AFTER the last day (Manila date), never on it', () => {
    expect(monthEnded('2026-10-01', '2026-10-30')).toBe(false);
    expect(monthEnded('2026-10-01', '2026-10-31')).toBe(false);
    expect(monthEnded('2026-10-01', '2026-11-01')).toBe(true);
    expect(monthEnded('2026-10-01', '2026-11-03')).toBe(true);
  });
  it('a read-only viewer is told who can fill the waiting close', () => {
    expect(closeWaitingWho("Oct'26")).toBe("Ask a Coop Admin to fill in the Oct'26 lines.");
  });
  it('nextEmptyLine walks the grid order from the cell you are on, wraps, and skips filled cells (a real 0 counts)', () => {
    const filled = Object.fromEntries(LINES.map((l) => [l.id, [0]]));
    const lines = {...filled, website_cogs: [null], fulfilment: [null]} as never;
    expect(nextEmptyLine(lines, 0)).toBe('website_cogs'); // sheet order: row 53 before row 60
    expect(nextEmptyLine(lines, 0, 'website_cogs')).toBe('fulfilment');
    expect(nextEmptyLine(lines, 0, 'freight_onetime')).toBe('website_cogs'); // wraps from row 89
    expect(nextEmptyLine(lines, 0, 'salaries', 'website_cogs')).toBe('fulfilment');
    expect(nextEmptyLine({}, 0, 'freight_onetime', 'salaries')).toBe('rent');
  });
  it('nextEmptyLine is null when all 21 are in, and never offers the optional ROAS', () => {
    const full = Object.fromEntries(LINES.map((l) => [l.id, [1]])) as never;
    expect(nextEmptyLine(full, 0, 'salaries')).toBeNull();
  });
  it('daysSinceMonthEnd counts from the last day of the month', () => {
    expect(daysSinceMonthEnd('2026-10-01', '2026-11-05')).toBe(5);
    expect(daysSinceMonthEnd('2026-10-01', '2026-10-31')).toBe(0);
    expect(daysSinceMonthEnd('2026-10-01', '2026-10-20')).toBe(0);
  });
  it('closeQueue lists every ended month not yet closed, oldest first', () => {
    const months = ['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01'];
    expect(closeQueue(months, {}, '2026-11-05')).toEqual(['2026-08-01', '2026-09-01', '2026-10-01']);
    expect(closeQueue(months, {'2026-09-01': closed(1)}, '2026-11-05')).toEqual(['2026-08-01', '2026-10-01']);
    expect(closeQueue(months, {}, '2026-10-31')).toEqual(['2026-08-01', '2026-09-01']);
    expect(closeQueue(months, {'2026-08-01': closed(1), '2026-09-01': closed(1), '2026-10-01': closed(1)}, '2026-11-05')).toEqual([]);
    expect(closeQueue(months, {}, '2026-08-10')).toEqual([]);
  });
  it('closeWaiting is the OLDEST ended month not yet closed (cash chains month to month)', () => {
    const months = ['2026-09-01', '2026-10-01', '2026-11-01'];
    expect(closeWaiting(months, {}, '2026-10-31')).toBe('2026-09-01');
    expect(closeWaiting(months, {}, '2026-11-01')).toBe('2026-09-01');
    expect(closeWaiting(months, {'2026-09-01': closed(1)}, '2026-11-02')).toBe('2026-10-01');
    expect(closeWaiting(months, {'2026-10-01': closed(1)}, '2026-11-02')).toBe('2026-09-01');
    expect(closeWaiting(months, {'2026-09-01': closed(1), '2026-10-01': closed(1)}, '2026-11-02')).toBeNull();
    expect(closeWaiting(months, {}, '2026-09-10')).toBeNull();
  });
  it('earlierUnclosed names the oldest unclosed month before the one being closed, else null', () => {
    const months = ['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01'];
    expect(earlierUnclosed('2026-10-01', months, {}, '2026-11-05')).toBe('2026-08-01');
    expect(earlierUnclosed('2026-10-01', months, {'2026-08-01': closed(1)}, '2026-11-05')).toBe('2026-09-01');
    expect(earlierUnclosed('2026-08-01', months, {}, '2026-11-05')).toBeNull();
    expect(earlierUnclosed('2026-10-01', months, {'2026-08-01': closed(1), '2026-09-01': closed(1)}, '2026-11-05')).toBeNull();
  });
  it('closeBlocker blocks an out-of-order close with a clear reason', () => {
    const full = {gmv_events: ok(1), gmv_website: ok(1), gmv_marketplace: ok(1)};
    expect(closeBlocker({month: '2026-10-01', today: '2026-11-05', tag: "Oct'26", gmv: full, earlier: "Aug'26"})).toBe("Close Aug'26 first. Cash carries from month to month, so months close oldest first.");
    expect(closeBlocker({month: '2026-10-01', today: '2026-11-05', tag: "Oct'26", gmv: full, earlier: null})).toBeNull();
  });
  it('lastPastMonths is the last three ended months (never the current one), fewer at the start of the plan', () => {
    const months = ['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01'];
    expect(lastPastMonths(months, '2026-11')).toEqual([0, 1, 2]);
    expect(lastPastMonths(months, '2026-12')).toEqual([1, 2, 3]);
    expect(lastPastMonths(months, '2026-09')).toEqual([0]);
    expect(lastPastMonths(months, '2026-08')).toEqual([]);
    expect(lastPastMonths(months, '2026-07')).toEqual([]);
  });
  it('a closed month reads GMV from its snapshot, not live; open months stay live; a channel missing in the snapshot is a gap', () => {
    const live = {gmv_events: [ok(5), ok(999)], gmv_website: [ok(1), ok(2)], gmv_marketplace: [ok(1), ok(2)], gmv_total: [ok(7), ok(1001)]};
    const out = applySnapshots(live, ['2026-09-01', '2026-10-01'], {'2026-10-01': closed(300)});
    expect(out.gmv_events[0].value).toBe(5);
    expect(out.gmv_events[1].value).toBe(300);
    expect(out.gmv_total[1].value).toBe(300);
    expect(out.gmv_website[1]).toEqual(GAP);
  });
  it('gmvSnapshot keeps the four GMV cells of the one month', () => {
    expect(Object.keys(gmvSnapshot({gmv_events: [ok(1)], gmv_total: [ok(2)], other: [ok(3)]})).sort()).toEqual(['gmv_events', 'gmv_marketplace', 'gmv_total', 'gmv_website']);
  });
});

describe('ROAS: the one optional typed measure (workbook row 9 is an input)', () => {
  it('is typed in its own unit and kept out of the lines that gate Close month', () => {
    expect(MEASURE_LINES.map((l) => [l.id, l.unit])).toEqual([['roas', 'x'], ['opening_cash', 'php'], ['opening_inventory', 'php'], ['opening_customers', 'count']]);
    expect(ALL_LINE_IDS).toHaveLength(25); // 21 typed lines + ROAS + the three opening balances
    const lines = Object.fromEntries(LINES.map((l) => [l.id, [0]]));
    expect(monthComplete(lines, 0)).toBe(true); // no ROAS typed, still closable
    expect(filledCount({...lines, roas: [3.2]}, 0)).toBe(21); // ROAS is not counted
  });

  it('validateLine: never negative; 0 and decimals are fine; clear is fine; non-numbers are not', () => {
    expect(validateLine('roas', -1)).toMatch(/cannot be negative/);
    expect(validateLine('roas', 0)).toBeNull();
    expect(validateLine('roas', null)).toBeNull();
    expect(validateLine('roas', Number.NaN)).toBe('Enter a number.');
    expect(validateLine('roas', '3')).toBe('Enter a number.');
    expect(validateLine('roas', 3.2)).toBeNull();
  });

  it('parseLineInput: thousands lines convert to pesos, ROAS is stored exactly as typed', () => {
    expect(parseLineInput('cogs', '1,250.5')).toEqual({ok: true, value: 1250500});
    expect(parseLineInput('roas', '3.2x')).toEqual({ok: true, value: 3.2});
    expect(parseLineInput('roas', '')).toEqual({ok: true, value: null});
    expect(parseLineInput('roas', '0')).toEqual({ok: true, value: 0});
    expect(parseLineInput('roas', 'abc')).toEqual({ok: false});
  });

  it('lineInputText is the inverse, and each line says its unit', () => {
    expect(lineInputText('cogs', 1250500)).toBe('1250.5');
    expect(lineInputText('roas', 3.2)).toBe('3.2');
    expect(lineUnitWords('cogs')).toBe('thousands of pesos');
    expect(lineUnitWords('roas')).toBe('a multiple, for example 3.2');
  });

  it('metricStatus: higher/lower colouring works, coverage is informational', () => {
    const base = {actual: 3.2, target: 3, phase: 'past' as const, hasSource: true};
    expect(metricStatus({...base, direction: 'higher'})).toBe('ok');
    expect(metricStatus({...base, direction: 'higher', actual: 2.5})).toBe('bad');
    expect(metricStatus({...base, direction: 'lower', actual: 250, target: 200})).toBe('bad');
    expect(metricStatus({...base, direction: 'higher', actual: 1.2, target: 1.8, informational: true})).toBe('info');
    expect(metricStatus({...base, direction: 'higher', actual: null, informational: true})).toBe('waiting');
    expect(metricStatus({...base, direction: 'higher', phase: 'current', informational: true})).toBe('live');
  });

  it('only ROAS is typed; cash, coverage, customers and CAC are calculated by the workbook formula', () => {
    expect(METRICS.find((m) => m.id === 'roas')?.source).toBe('typed');
    for (const id of ['cash', 'coverage', 'customers', 'cac', 'cm1', 'ebitda']) expect(METRICS.find((m) => m.id === id)?.source, id).toBe('calc');
  });
});

describe('the cash-flow inputs (rows 87, 88, 89 and the stock bought) are typed like any line', () => {
  it('thousands of pesos, never negative, required to close the month (cash needs them all)', () => {
    for (const id of ['bridge_funding', 'liability_settlement', 'freight_onetime', 'inv_purchases_paid']) {
      expect(lineUnit(id)).toBe('php');
      expect(validateLine(id, -1), id).toMatch(/cannot be negative/);
      expect(validateLine(id, 0), id).toBeNull();
      expect(parseLineInput(id, '1,500')).toEqual({ok: true, value: 1500000});
      expect(LINES.some((l) => l.id === id), id).toBe(true);
    }
  });
});

describe('cashPerFormula: workbook row 90 = previous cash + row 86 + funding − settlement − freight, row 86 = EBITDA + COGS − stock bought', () => {
  // Made-up inputs in thousands: a first month and the month after it.
  const aug = {prevCash: 0, ebitda: -200, cogs: 31, invPurchases: 0, funding: 0, settlement: 0, freight: 0};
  const sep = {prevCash: -169, ebitda: -150, cogs: 64, invPurchases: 210, funding: 1500, settlement: 330, freight: 0};
  it('follows the workbook cash formula month to month', () => {
    expect(cashPerFormula(aug)).toBeCloseTo(-169, 6);
    expect(cashPerFormula(sep)).toBeCloseTo(705, 6);
  });
  it('a missing input gives null, never a guess (a typed 0 is a real 0)', () => {
    for (const k of Object.keys(sep) as (keyof typeof sep)[]) expect(cashPerFormula({...sep, [k]: null}), k).toBeNull();
    expect(cashPerFormula({...sep, funding: 0})).not.toBeNull();
  });
});

describe('cashSeries: derived, never typed', () => {
  const e = (v: number | null, state: 'ok' | 'partial' | 'gap' = 'ok') => ({value: v, state});
  const lines = {cogs: [31000, 64000], inv_purchases_paid: [0, 210000], bridge_funding: [0, 1500000], liability_settlement: [0, 330000], freight_onetime: [0, 0]};
  const r = cashSeries([e(-200000), e(-150000)], {...lines, opening_cash: [0]});
  it('the first month starts from the typed opening cash (the workbook starts from 0), the second from the first', () => {
    expect(r[0].value).toBeCloseTo(-169000, 4);
    expect(r[1].value).toBeCloseTo(705000, 4);
  });
  it('waits when EBITDA is missing, an input is empty, or an earlier month waits; a partial EBITDA is a partial cash', () => {
    expect(cashSeries([e(null)], {...lines, opening_cash: [0]})[0]).toEqual(GAP);
    expect(cashSeries([e(-1)], {...lines, opening_cash: [0], bridge_funding: [null]})[0]).toEqual(GAP);
    expect(cashSeries([e(-1), e(-1)], {...lines, opening_cash: [0], bridge_funding: [null, 0]}).map((c) => c.value)).toEqual([null, null]);
    expect(cashSeries([e(-1, 'partial')], {...lines, opening_cash: [0]})[0].state).toBe('partial');
  });
  it('without a typed opening cash every month waits: never a guess; a negative opening cash is allowed and carried', () => {
    expect(cashSeries([e(-200000), e(-1)], lines).map((c) => c.value)).toEqual([null, null]);
    expect(cashSeries([e(-200000)], {...lines, opening_cash: [null]})[0]).toEqual(GAP);
    expect(cashSeries([e(-200000)], {...lines, opening_cash: [-100000]})[0].value).toBeCloseTo(-269000, 4);
    expect(cashSeries([e(-200000)], {...lines, opening_cash: [500000]})[0].value).toBeCloseTo(331000, 4);
  });
  it('opening cash may be negative (an overdraft), unlike every cost line', () => {
    expect(validateLine('opening_cash', -5000)).toBeNull();
    expect(validateLine('opening_cash', 0)).toBeNull();
    expect(validateLine('opening_cash', null)).toBeNull();
    expect(validateLine('opening_cash', NaN)).toBe('Enter a number.');
    expect(parseLineInput('opening_cash', '-120')).toEqual({ok: true, value: -120000});
    expect(monthComplete(Object.fromEntries(LINES.map((l) => [l.id, [0]])), 0)).toBe(true); // opening cash never gates a close
  });
});

import {closeBlocker, gmvComplete} from '../src/plan-compute';

describe('the close gate: the month is over (Manila time) AND all three GMV channels are complete', () => {
  const full = {gmv_events: ok(1), gmv_website: ok(2), gmv_marketplace: ok(3)};
  const tag = "Oct'26";
  it('gmvComplete needs all three channels fully covered: a gap, a partial or a missing channel is not complete', () => {
    expect(gmvComplete(full)).toBe(true);
    expect(gmvComplete({...full, gmv_marketplace: {value: 3, state: 'partial'}})).toBe(false);
    expect(gmvComplete({...full, gmv_website: GAP})).toBe(false);
    expect(gmvComplete({gmv_events: ok(1), gmv_website: ok(2)})).toBe(false);
    expect(gmvComplete({...full, gmv_events: {value: null, state: 'ok'}})).toBe(false);
    expect(gmvComplete({...full, gmv_events: ok(0)})).toBe(true); // a real 0 is complete
  });
  it('nothing blocks a past month with all three channels complete', () => {
    expect(closeBlocker({month: '2026-10-01', today: '2026-11-01', tag, gmv: full})).toBeNull();
  });
  it('a month that has not ended is blocked, including on its last day', () => {
    expect(closeBlocker({month: '2026-11-01', today: '2026-11-05', tag: "Nov'26", gmv: full})).toMatch(/Nov'26 is not over yet/);
    expect(closeBlocker({month: '2026-10-01', today: '2026-10-31', tag, gmv: full})).toMatch(/not over yet/);
  });
  it('says which channel is partial or missing', () => {
    expect(closeBlocker({month: '2026-10-01', today: '2026-11-05', tag, gmv: {...full, gmv_marketplace: {value: 3, state: 'partial'}}})).toBe("Marketplace data for Oct'26 is still partial.");
    expect(closeBlocker({month: '2026-10-01', today: '2026-11-05', tag, gmv: {...full, gmv_website: GAP}})).toBe("Website data for Oct'26 is not in yet.");
    expect(closeBlocker({month: '2026-10-01', today: '2026-11-05', tag, gmv: {...full, gmv_events: GAP, gmv_marketplace: {value: 1, state: 'partial'}}})).toBe("Events data for Oct'26 is not in yet. Marketplace data for Oct'26 is still partial.");
  });
});

import {LINE_TARGET_ID, assemblePlan} from '../src/plan-compute';
import {LINE_ROW, sheetStatus} from '../src/plan-sheet';

/** The colour of a typed actual cell: its own sheet row's rule (BHR-06). */
const lineStatus = (id: string, actual: number | null, target: number | null, phase: 'past' | 'current' | 'future', gmv?: {actual: number; target: number}) =>
  sheetStatus({row: LINE_ROW[id], actual: actual === null ? GAP : {value: actual, state: 'ok'}, target, phase, ctx: {actualBase: gmv?.actual, targetBase: gmv?.target}});

describe('plan targets for the typed lines (BHR cost-line targets)', () => {
  it('every typed line names the target it is judged against: its own sheet row; stock bought is the inv_purchases target', () => {
    expect(Object.keys(LINE_TARGET_ID).sort()).toEqual(LINES.map((l) => l.id).sort());
    expect(LINE_TARGET_ID.inv_purchases_paid).toBe('inv_purchases');
    expect(LINE_TARGET_ID.salaries).toBe('r33');
    expect(LINE_TARGET_ID.marketplace_cogs).toBe('r52');
  });
  it('assemblePlan keeps the cost-line targets (and still ignores unknown metrics)', () => {
    const p = assemblePlan('v', [{month: '2026-10-01', metric: 'r52', value: 5}, {month: '2026-10-01', metric: 'bridge_funding', value: 7}, {month: '2026-10-01', metric: 'nope', value: 1}]);
    expect(p.targets.r52).toEqual([5]);
    expect(p.targets.bridge_funding).toEqual([7]);
    expect(p.targets.nope).toBeUndefined();
  });
  it('a typed cost is lower-is-better (variable costs as a share of GMV, BHR-06)', () => {
    const gmv = {actual: 1000, target: 1000};
    expect(lineStatus('marketplace_cogs', 90, 100, 'past', gmv)).toBe('ok');
    expect(lineStatus('marketplace_cogs', 100, 100, 'past', gmv)).toBe('ok');
    expect(lineStatus('ad_website', 130, 100, 'past', gmv)).toBe('bad');
    expect(lineStatus('marketplace_cogs', 120, 100, 'past', {actual: 2000, target: 1000})).toBe('ok'); // a lower share of a bigger GMV
    expect(lineStatus('marketplace_cogs', 90, 100, 'past')).toBe('waiting'); // no GMV yet
    expect(lineStatus('salaries', 130, 100, 'past')).toBe('bad'); // overhead rows are absolute
    expect(lineStatus('salaries', 100, 100, 'past')).toBe('ok');
  });
  it('funding, settlement, freight and stock bought are never red or green', () => {
    for (const id of ['bridge_funding', 'liability_settlement', 'freight_onetime', 'inv_purchases_paid']) {
      expect(lineStatus(id, 150, 100, 'past'), id).toBe('info');
      expect(lineStatus(id, 0, 100, 'past'), id).toBe('info');
    }
  });
  it('the month in progress is never judged; a missing actual or target waits', () => {
    expect(lineStatus('marketplace_cogs', 500, 100, 'current', {actual: 1, target: 1})).toBe('live');
    expect(lineStatus('marketplace_cogs', null, 100, 'past')).toBe('waiting');
    expect(lineStatus('salaries', 5, null, 'past')).toBe('waiting');
  });
});
