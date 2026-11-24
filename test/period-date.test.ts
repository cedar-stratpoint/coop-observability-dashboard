import {describe, expect, it} from 'vitest';
import {firstIsoDate, isoPeriod, toIsoDate} from '../src/period-date';

describe('toIsoDate', () => {
  it('keeps ISO dates', () => {
    expect(toIsoDate('2024-10-16')).toBe('2024-10-16');
    expect(toIsoDate('2024/10/1')).toBe('2024-10-01');
  });
  it('reads month-first numeric dates', () => {
    expect(toIsoDate('10/16/2026')).toBe('2026-10-16');
    expect(toIsoDate('10-31-24')).toBe('2024-10-31');
    expect(toIsoDate(' 9.1.2024 ')).toBe('2024-09-01');
  });
  it('reads written months', () => {
    expect(toIsoDate('SEPTEMBER 16, 2026')).toBe('2026-09-16');
    expect(toIsoDate('Oct 16 2024')).toBe('2024-10-16');
    expect(toIsoDate('Sept. 1st, 2024')).toBe('2024-09-01');
    expect(toIsoDate('16 October 2024')).toBe('2024-10-16');
  });
  it('uses the fallback year only for a date written without one', () => {
    expect(toIsoDate('06-16')).toBeNull();
    expect(toIsoDate('06-16', 2024)).toBe('2024-06-16');
    expect(toIsoDate('Oct 16', 2024)).toBe('2024-10-16');
  });
  it('rejects what it cannot read safely', () => {
    expect(toIsoDate('')).toBeNull();
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate('09/31/2024')).toBeNull(); // Sep has 30 days
    expect(toIsoDate('13/01/2024')).toBeNull();
    expect(toIsoDate('Octember 5, 2024')).toBeNull();
    expect(toIsoDate('sometime in October')).toBeNull();
  });
});

describe('firstIsoDate', () => {
  it('prefers an already-ISO candidate over converting an earlier raw one', () => {
    // The page sort's ISO date (right year) beats the reader's raw text (wrong year).
    expect(firstIsoDate(null, '2024-10-16', '10/16/2026')).toBe('2024-10-16');
    expect(firstIsoDate('10/16/2026', '2024-10-16')).toBe('2024-10-16');
  });
  it('converts a raw candidate when none is ISO', () => {
    expect(firstIsoDate(null, '10/16/2026')).toBe('2026-10-16');
    expect(firstIsoDate(null, 'gibberish')).toBeNull();
  });
});

describe('isoPeriod', () => {
  it('borrows the year across the two ends', () => {
    expect(isoPeriod(['10/16'], ['10/31/2024'])).toEqual({start: '2024-10-16', end: '2024-10-31'});
    expect(isoPeriod(['Sep 1, 2026'], ['09/15'])).toEqual({start: '2026-09-01', end: '2026-09-15'});
  });
  it('prefers the page sort ISO date over the written one on each end', () => {
    expect(isoPeriod([null, '2024-10-16', '10/16/2026'], [null, '2024-10-31', '10/31/2026'])).toEqual({start: '2024-10-16', end: '2024-10-31'});
  });
  it('leaves a year-less period empty rather than guessing', () => {
    expect(isoPeriod(['09/15'], ['09/30'])).toEqual({start: null, end: null});
  });
});
