import {describe, expect, it} from 'vitest';
import {
  buildForecastLines,
  clampSettings,
  forecastSummary,
  forecastWindow,
  salesYear,
  storeRollup,
  type ForecastWindow,
  type MonthStatus,
} from './goldline-forecast';

const S31 = {windowMonths: 3, safetyMonths: 1};
// Staging's months: Oct 2025 to Sep 2026, with Feb and Mar 2026 never loaded.
const LOADED = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
const status = (months: string[]): MonthStatus[] =>
  months.map((m) => ({month: m, loaded: LOADED.includes(m), units: LOADED.includes(m) ? 1000 : 0, unlinkedUnits: LOADED.includes(m) ? 200 : 0}));

const run = (window: ForecastWindow, over: Partial<Parameters<typeof buildForecastLines>[0]> = {}) =>
  buildForecastLines({
    window,
    months: status(window.lastYear),
    history: [],
    inScope: new Set(['1', '2']),
    retired: new Set(),
    openFlags: new Set(),
    counted: [],
    ...over,
  });

describe('forecastWindow', () => {
  it('covers the 3 months after the run date (Oct 31 → Nov to Jan)', () => {
    const w = forecastWindow('2026-10-31', S31);
    expect(w.months).toEqual(['2026-11', '2026-12', '2027-01']);
    expect(w.lastYear).toEqual(['2025-11', '2025-12', '2026-01']);
    expect(w.safety).toEqual(['2026-01']);
  });

  it('starts at the next month for a mid-month run too (Nov 15 → Dec to Feb)', () => {
    expect(forecastWindow('2026-11-15', S31).months).toEqual(['2026-12', '2027-01', '2027-02']);
  });

  it('crosses the year boundary', () => {
    const w = forecastWindow('2026-12-31', S31);
    expect(w.months).toEqual(['2027-01', '2027-02', '2027-03']);
    expect(w.lastYear).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('follows the settings (window 2, safety 1; safety 0)', () => {
    expect(forecastWindow('2026-10-27', {windowMonths: 2, safetyMonths: 1})).toMatchObject({lastYear: ['2025-11', '2025-12'], safety: ['2025-12']});
    expect(forecastWindow('2026-10-27', {windowMonths: 3, safetyMonths: 0}).safety).toEqual([]);
  });

  it('keeps settings in range', () => {
    expect(clampSettings({windowMonths: 9, safetyMonths: 9})).toEqual({windowMonths: 6, safetyMonths: 6});
    expect(clampSettings({windowMonths: 2, safetyMonths: 3})).toEqual({windowMonths: 2, safetyMonths: 2});
    expect(clampSettings(null)).toEqual(S31);
  });

  it('salesYear is the 12 months before the run month', () => {
    expect(salesYear('2026-10-27')).toEqual(['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
  });
});

describe('buildForecastLines', () => {
  const oct31 = forecastWindow('2026-10-31', S31);

  it("uses last year's same months and the final month as safety (the meeting's wedge sponge)", () => {
    const [l] = run(oct31, {history: [{storeCode: '1', itemCode: 'SPONGE', units: [15, 25, 10]}]});
    expect(l).toEqual({storeCode: '1', itemCode: 'SPONGE', units: [15, 25, 10], need: 50, safety: 10, holds: []});
  });

  it('counts a month with no row as 0 when the month was loaded', () => {
    const [l] = run(oct31, {history: [{storeCode: '1', itemCode: 'A', units: [0, 4, 0]}]});
    expect(l.need).toBe(4);
    expect(l.safety).toBe(0);
    expect(l.holds).toEqual([]);
  });

  it('holds every line when one of last year’s months was never loaded (no fallback)', () => {
    const nov15 = forecastWindow('2026-11-15', S31); // needs Feb 2026
    const lines = run(nov15, {history: [{storeCode: '1', itemCode: 'A', units: [9, 9, 0]}]});
    expect(lines[0]).toMatchObject({units: [9, 9, null], need: null, safety: null, holds: ['missing_month']});
  });

  it('lists every hold reason that applies, in order', () => {
    const lines = run(oct31, {
      history: [
        {storeCode: '9', itemCode: 'OLD', units: [1, 1, 1]},
        {storeCode: '1', itemCode: 'FLAG', units: [3, 3, 3]},
      ],
      retired: new Set(['OLD']),
      openFlags: new Set(['9|OLD', '1|FLAG']),
    });
    expect(lines.find((l) => l.itemCode === 'OLD')!.holds).toEqual(['out_of_scope', 'retired', 'open_flag']);
    expect(lines.find((l) => l.itemCode === 'FLAG')!.holds).toEqual(['open_flag']);
  });

  it('holds a counted product with no sales last year instead of offering 0', () => {
    const lines = run(oct31, {counted: [{storeCode: '2', itemCode: 'NEW'}]});
    expect(lines).toEqual([{storeCode: '2', itemCode: 'NEW', units: [0, 0, 0], need: 0, safety: 0, holds: ['no_history']}]);
  });

  it('does not duplicate a counted pair that also sold', () => {
    const lines = run(oct31, {history: [{storeCode: '1', itemCode: 'A', units: [1, 2, 3]}], counted: [{storeCode: '1', itemCode: 'A'}]});
    expect(lines).toHaveLength(1);
    expect(lines[0].need).toBe(6);
  });
});

describe('forecastSummary and storeRollup', () => {
  it('counts ready and held lines, reasons, missing months and unlinked units', () => {
    const w = forecastWindow('2026-10-31', S31);
    const months = status(w.lastYear);
    const lines = run(w, {
      history: [
        {storeCode: '1', itemCode: 'A', units: [15, 25, 10]},
        {storeCode: '1', itemCode: 'B', units: [1, 0, 0]},
        {storeCode: '9', itemCode: 'A', units: [5, 5, 5]},
      ],
      openFlags: new Set(['1|B']),
    });
    const s = forecastSummary(lines, w, months);
    expect(s).toMatchObject({lines: 3, ready: 1, held: 2, needUnits: 50, missingMonths: [], windowUnits: 3000, unlinkedUnits: 600});
    expect(s.byReason).toMatchObject({open_flag: 1, out_of_scope: 1, missing_month: 0});
    expect(storeRollup(lines, new Set(['1', '2']))).toEqual([
      {storeCode: '1', lines: 2, ready: 1, held: 1, needUnits: 50, inScope: true},
      {storeCode: '9', lines: 1, ready: 0, held: 1, needUnits: 0, inScope: false},
    ]);
  });

  it('names the missing months to ask for', () => {
    const w = forecastWindow('2026-12-31', S31);
    expect(forecastSummary([], w, status(w.lastYear)).missingMonths).toEqual(['2026-02', '2026-03']);
  });
});
