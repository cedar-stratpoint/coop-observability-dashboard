import {describe, expect, it} from 'vitest';
import {MAX_SYNC_DAYS, latestClosedDay, missingClosedDays, phDay} from '../src/shopee-sync/missing-days';

// PH = UTC+8. 2026-10-26 is a Monday.
const at = (phIso: string) => new Date(`${phIso}+08:00`);

describe('phDay', () => {
  it('is the Philippine calendar day', () => {
    expect(phDay(new Date('2026-10-26T17:00:00Z'))).toBe('2026-10-27');
    expect(phDay(new Date('2026-10-26T15:59:00Z'))).toBe('2026-10-26');
  });
});

describe('missingClosedDays', () => {
  const loaded = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];

  it('lists every missing day that is closed, never today', () => {
    const r = missingClosedDays(loaded, at('2026-10-26T12:00:00'));
    expect(r.days).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25']);
    expect(r.more).toBe(0);
  });

  it('keeps yesterday out until 06:00 PH today (the finality cutoff)', () => {
    expect(missingClosedDays(loaded, at('2026-10-26T05:59:59')).days.at(-1)).toBe('2026-10-24');
    expect(missingClosedDays(loaded, at('2026-10-26T06:00:00')).days.at(-1)).toBe('2026-10-25');
  });

  it('skips days that are already loaded and finds gaps in the middle', () => {
    const r = missingClosedDays([...loaded, '2026-10-19', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'], at('2026-10-27T12:00:00'));
    expect(r.days).toEqual(['2026-10-20', '2026-10-26']);
  });

  it('is empty when up to date, or when nothing is loaded at all', () => {
    expect(missingClosedDays([...loaded, '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'], at('2026-10-26T12:00:00')).days).toEqual([]);
    expect(missingClosedDays([], at('2026-10-26T12:00:00')).days).toEqual([]);
  });

  it('caps one job at 31 days, oldest first, and reports how many more wait', () => {
    const r = missingClosedDays(['2026-08-03'], at('2026-10-26T12:00:00'));
    expect(MAX_SYNC_DAYS).toBe(31);
    expect(r.days).toHaveLength(31);
    expect(r.days[0]).toBe('2026-08-04');
    expect(r.more).toBeGreaterThan(0);
    expect(r.days.length + r.more).toBe(83); // 4 Aug .. 25 Oct
  });
});

describe('latestClosedDay', () => {
  it('is yesterday (PH) once past 06:00 PH, else the day before', () => {
    expect(latestClosedDay(new Date('2026-10-29T08:00:00+08:00'))).toBe('2026-10-28');
    expect(latestClosedDay(new Date('2026-10-29T05:00:00+08:00'))).toBe('2026-10-27');
  });
});
