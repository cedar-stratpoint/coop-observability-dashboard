import {describe, expect, it} from 'vitest';
import {halfMonths, periodLabel, snapPeriodYear} from '../src/period-date';

// QA Nov 27: "July 16 - 31, 2026" read as 07/16/2024 (a third of prod pages had a wrong year).
describe('snapPeriodYear', () => {
  it('moves a misread year to the scan\'s year and says what was read', () => {
    expect(snapPeriodYear({start: '2024-07-16', end: '2024-07-31'}, 2026)).toEqual({start: '2026-07-16', end: '2026-07-31', yearRead: 2024});
    expect(snapPeriodYear({start: '2016-09-01', end: '2016-09-15'}, 2026)).toEqual({start: '2026-09-01', end: '2026-09-15', yearRead: 2016});
  });
  it('leaves a matching year, a missing scan year, or no period alone', () => {
    expect(snapPeriodYear({start: '2026-10-01', end: '2026-10-15'}, 2026)).toEqual({start: '2026-10-01', end: '2026-10-15', yearRead: null});
    expect(snapPeriodYear({start: '2024-07-16', end: '2024-07-31'}, null).yearRead).toBeNull();
    expect(snapPeriodYear({start: null, end: null}, 2026)).toEqual({start: null, end: null, yearRead: null});
  });
  it('uses the end when only the end was read', () => {
    expect(snapPeriodYear({start: null, end: '2020-08-31'}, 2026)).toEqual({start: null, end: '2026-08-31', yearRead: 2020});
  });
  it('Feb 29 into a non-leap year becomes Feb 28', () => {
    expect(snapPeriodYear({start: '2024-02-16', end: '2024-02-29'}, 2026)).toEqual({start: '2026-02-16', end: '2026-02-28', yearRead: 2024});
  });
});

describe('halfMonths', () => {
  it('gives the two cut-offs with the month\'s real last day', () => {
    expect(halfMonths(2026, 6)).toEqual([
      {start: '2026-07-01', end: '2026-07-15', label: '1 to 15'},
      {start: '2026-07-16', end: '2026-07-31', label: '16 to 31'},
    ]);
    expect(halfMonths(2026, 8)[1]).toEqual({start: '2026-09-16', end: '2026-09-30', label: '16 to 30'});
    expect(halfMonths(2026, 1)[1].end).toBe('2026-02-28');
    expect(halfMonths(2028, 1)[1].end).toBe('2028-02-29');
  });
});

describe('periodLabel', () => {
  it('is short within a month and says "to", never a dash', () => {
    expect(periodLabel('2026-09-16', '2026-09-30')).toBe('Sep 16 to 30, 2026');
    expect(periodLabel('2026-09-16', '2026-10-03')).toBe('Sep 16 to Oct 3, 2026');
    expect(periodLabel('2025-12-16', '2026-01-03')).toBe('Dec 16, 2025 to Jan 3, 2026');
    expect(periodLabel('2026-09-16', '2026-09-16')).toBe('Sep 16, 2026');
  });
});
