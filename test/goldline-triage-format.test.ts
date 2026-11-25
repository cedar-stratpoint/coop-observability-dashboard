import {describe, expect, it} from 'vitest';
import {
  fmtTriagePeriod,
  flagTone,
  periodHeading,
  periodSortKey,
  VERSION_LABEL,
} from '../src/goldline-triage-format';

describe('fmtTriagePeriod', () => {
  it('uses "to", never a dash, and collapses a shared month/year', () => {
    const s = fmtTriagePeriod('2026-09-01', '2026-09-15');
    expect(s).toBe('Sep 1 to 15, 2026');
    expect(s).not.toContain('–');
    expect(s).not.toContain('-');
  });
  it('spans months and years when needed', () => {
    expect(fmtTriagePeriod('2026-09-16', '2026-10-02')).toBe('Sep 16 to Oct 2, 2026');
    expect(fmtTriagePeriod('2026-12-20', '2027-01-05')).toBe('Dec 20, 2026 to Jan 5, 2027');
  });
  it('handles missing ends', () => {
    expect(fmtTriagePeriod(null, null)).toBe('No period');
    expect(fmtTriagePeriod('2026-09-01', null)).toBe('Sep 1, 2026');
  });
});

describe('period grouping', () => {
  it('heading names the half-month', () => {
    expect(periodHeading('2026-09-09', '2026-09-15')).toBe('Sep 2026 · first half');
    expect(periodHeading('2026-09-16', '2026-09-30')).toBe('Sep 2026 · second half');
  });
  it('sort key orders chronologically, first half before second', () => {
    expect(periodSortKey('2026-09-01', '2026-09-15') < periodSortKey('2026-09-16', '2026-09-30')).toBe(true);
    expect(periodSortKey('2026-09-16', '2026-09-30') < periodSortKey('2026-10-01', '2026-10-15')).toBe(true);
  });
});

describe('flag + version meta', () => {
  it('maps flag severity to a tone', () => {
    expect(flagTone('duplicate-pages')).toBe('crit');
    expect(flagTone('store-corrected')).toBe('info');
    expect(flagTone('period-partial')).toBe('warn');
  });
  it('labels every version', () => {
    expect(VERSION_LABEL.legacy).toBe('Legacy');
    expect(VERSION_LABEL.v2).toBe('V2');
    expect(VERSION_LABEL.unknown).toBe('Unknown version');
  });
});
