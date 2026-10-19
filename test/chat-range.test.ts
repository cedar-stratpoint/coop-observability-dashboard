import {describe, it, expect} from 'vitest';
import {resolveRange, rangeLabel, MAX_RANGE_DAYS} from '../src/chat/range';

const NO_BOUNDS = {dataFrom: null, dataTo: null};
const BOUNDS = {dataFrom: '2026-09-11', dataTo: '2026-09-27'};
// 2026-10-01 is a Thursday. Noon PHT = 04:00 UTC.
const THU = new Date('2026-10-01T04:00:00Z');
const custom = (from: string, to: string) => ({range: 'custom' as const, from, to});
const preset = (range: 'last_week' | 'this_week' | 'last_month' | 'all_available') => ({range, from: '', to: ''});

function ok(r: ReturnType<typeof resolveRange>) {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r;
}
function err(r: ReturnType<typeof resolveRange>) {
  if (r.ok) throw new Error('expected an error');
  return r.error;
}

describe('presets (PHT, Monday to Sunday)', () => {
  it('this_week = Monday of the current week to today; previous = the 4 days before', () => {
    const r = ok(resolveRange(preset('this_week'), THU, BOUNDS));
    expect([r.from, r.to]).toEqual(['2026-09-28', '2026-10-01']);
    expect(r.previous).toEqual({from: '2026-09-24', to: '2026-09-27'});
  });

  it('this_week on a Monday is one day', () => {
    const r = ok(resolveRange(preset('this_week'), new Date('2026-09-28T01:00:00Z'), BOUNDS));
    expect([r.from, r.to]).toEqual(['2026-09-28', '2026-09-28']);
    expect(r.label).toBe('Sep 28, 2026');
  });

  it('this_week on a Sunday spans the whole week', () => {
    const r = ok(resolveRange(preset('this_week'), new Date('2026-10-04T10:00:00Z'), BOUNDS));
    expect([r.from, r.to]).toEqual(['2026-09-28', '2026-10-04']);
  });

  it('last_week = the full previous Monday to Sunday, crossing a month end', () => {
    const r = ok(resolveRange(preset('last_week'), THU, BOUNDS));
    expect([r.from, r.to]).toEqual(['2026-09-21', '2026-09-27']);
    expect(r.previous).toEqual({from: '2026-09-14', to: '2026-09-20'});
    // Thursday Oct 1: the week Mon Sep 28 - Sun Oct 4 crosses the month end; last week is wholly September.
    const w = ok(resolveRange(preset('last_week'), new Date('2026-10-08T04:00:00Z'), BOUNDS));
    expect([w.from, w.to]).toEqual(['2026-09-28', '2026-10-04']);
    expect(w.label).toBe('Sep 28 to Oct 4, 2026');
  });

  it('last_week crosses a year boundary', () => {
    const r = ok(resolveRange(preset('last_week'), new Date('2027-01-06T04:00:00Z'), BOUNDS)); // Wed Jan 6 2027
    expect([r.from, r.to]).toEqual(['2026-12-28', '2027-01-03']);
    expect(r.label).toBe('Dec 28, 2026 to Jan 3, 2027');
  });

  it('last_month = the full previous calendar month; previous = the whole month before it (A5: August 1 to 31, not Aug 2 to 31)', () => {
    const r = ok(resolveRange(preset('last_month'), THU, BOUNDS));
    expect([r.from, r.to]).toEqual(['2026-09-01', '2026-09-30']);
    expect(r.previous).toEqual({from: '2026-08-01', to: '2026-08-31'});
  });

  it('A5: whole calendar months compare with the same number of whole months before; any other range keeps equal length', () => {
    const custom = (from: string, to: string) => ok(resolveRange({range: 'custom', from, to}, THU, BOUNDS)).previous;
    expect(custom('2026-03-01', '2026-03-31')).toEqual({from: '2026-02-01', to: '2026-02-28'});
    expect(custom('2026-07-01', '2026-09-30')).toEqual({from: '2026-04-01', to: '2026-06-30'}); // a quarter: the quarter before
    expect(custom('2026-01-01', '2026-01-31')).toEqual({from: '2025-12-01', to: '2025-12-31'}); // across a year
    expect(custom('2026-09-01', '2026-09-29')).toEqual({from: '2026-08-03', to: '2026-08-31'}); // not a month end: equal length
    expect(custom('2026-09-02', '2026-09-30')).toEqual({from: '2026-08-04', to: '2026-09-01'}); // not a 1st: equal length
  });

  it('last_month in January is the previous December', () => {
    const r = ok(resolveRange(preset('last_month'), new Date('2027-01-15T04:00:00Z'), BOUNDS));
    expect([r.from, r.to]).toEqual(['2026-12-01', '2026-12-31']);
  });

  it('last_month handles a leap February', () => {
    const r = ok(resolveRange(preset('last_month'), new Date('2028-03-10T04:00:00Z'), BOUNDS));
    expect([r.from, r.to]).toEqual(['2028-02-01', '2028-02-29']);
    expect(r.previous).toEqual({from: '2028-01-01', to: '2028-01-31'});
  });

  it('all_available = dataFrom..dataTo, and errors with "no data yet" when null', () => {
    const r = ok(resolveRange(preset('all_available'), THU, BOUNDS));
    expect([r.from, r.to, r.label]).toEqual(['2026-09-11', '2026-09-27', 'Sep 11 to Sep 27, 2026']);
    expect(r.previous).toEqual({from: '2026-08-25', to: '2026-09-10'});
    expect(err(resolveRange(preset('all_available'), THU, NO_BOUNDS))).toMatch(/no data yet/i);
    expect(err(resolveRange(preset('all_available'), THU, {dataFrom: '2026-09-11', dataTo: null}))).toMatch(/no data yet/i);
  });

  it('uses the Philippine date, not UTC: 16:30 UTC is already the next PHT day', () => {
    // 2026-09-30 16:30 UTC = 2026-10-01 00:30 PHT (Thursday).
    const r = ok(resolveRange(preset('this_week'), new Date('2026-09-30T16:30:00Z'), BOUNDS));
    expect(r.to).toBe('2026-10-01');
    // 2026-09-30 15:59 UTC is still Sep 30 in PHT.
    const before = ok(resolveRange(preset('this_week'), new Date('2026-09-30T15:59:00Z'), BOUNDS));
    expect(before.to).toBe('2026-09-30');
    // On Sunday-night UTC the PHT week has already rolled to Monday.
    const mon = ok(resolveRange(preset('this_week'), new Date('2026-09-27T16:05:00Z'), BOUNDS));
    expect([mon.from, mon.to]).toEqual(['2026-09-28', '2026-09-28']);
  });

  it('rejects from/to on a non-custom range, stating what is allowed', () => {
    const e = err(resolveRange({range: 'last_week', from: '2026-09-01', to: ''}, THU, BOUNDS));
    expect(e).toMatch(/must be ''/);
    expect(e).toMatch(/custom/);
    expect(err(resolveRange({range: 'this_week', from: '', to: '2026-09-01'}, THU, BOUNDS))).toMatch(/must be ''/);
  });

  it('rejects an unknown range value and lists the allowed ones', () => {
    const e = err(resolveRange({range: 'yesterday' as never, from: '', to: ''}, THU, BOUNDS));
    expect(e).toMatch(/last_week.*this_week.*last_month.*all_available.*custom/);
  });
});

describe('custom', () => {
  it('accepts a normal range with a label and an equal-length previous period', () => {
    const r = ok(resolveRange(custom('2026-09-11', '2026-09-27'), THU, BOUNDS));
    expect([r.from, r.to, r.label]).toEqual(['2026-09-11', '2026-09-27', 'Sep 11 to Sep 27, 2026']);
    expect(r.previous).toEqual({from: '2026-08-25', to: '2026-09-10'});
  });

  it('single day, and to = today are allowed', () => {
    expect(ok(resolveRange(custom('2026-09-27', '2026-09-27'), THU, BOUNDS)).label).toBe('Sep 27, 2026');
    expect(ok(resolveRange(custom('2026-09-25', '2026-10-01'), THU, BOUNDS)).to).toBe('2026-10-01');
  });

  it('today is the PHT day: 2026-10-01 is allowed at 00:30 PHT (16:30 UTC) but not at 23:59 UTC the day before', () => {
    expect(ok(resolveRange(custom('2026-10-01', '2026-10-01'), new Date('2026-09-30T16:30:00Z'), BOUNDS)).to).toBe('2026-10-01');
    expect(err(resolveRange(custom('2026-10-01', '2026-10-01'), new Date('2026-09-30T15:30:00Z'), BOUNDS))).toMatch(/after today/);
  });

  it('empty from or to is an error that says so', () => {
    expect(err(resolveRange(custom('', '2026-09-27'), THU, BOUNDS))).toMatch(/needs both/);
    expect(err(resolveRange(custom('2026-09-01', ''), THU, BOUNDS))).toMatch(/needs both/);
    expect(err(resolveRange(custom('', ''), THU, BOUNDS))).toMatch(/needs both/);
  });

  it('rejects invalid and impossible dates', () => {
    expect(err(resolveRange(custom('2026-02-30', '2026-03-05'), THU, BOUNDS))).toMatch(/'from' must be a real calendar date/);
    expect(err(resolveRange(custom('2026-03-01', '2026-13-01'), THU, BOUNDS))).toMatch(/'to' must be a real calendar date/);
    expect(err(resolveRange(custom('09/11/2026', '2026-09-27'), THU, BOUNDS))).toMatch(/YYYY-MM-DD/);
    expect(err(resolveRange(custom('2026-9-1', '2026-09-27'), THU, BOUNDS))).toMatch(/YYYY-MM-DD/);
    expect(err(resolveRange(custom('2026-09-11', 'tomorrow'), THU, BOUNDS))).toMatch(/'to' must be/);
  });

  it('leap day: 2028-02-29 is real, 2026-02-29 is not', () => {
    const r = ok(resolveRange(custom('2028-02-28', '2028-03-01'), new Date('2028-06-01T04:00:00Z'), BOUNDS));
    expect(r.previous).toEqual({from: '2028-02-25', to: '2028-02-27'});
    expect(err(resolveRange(custom('2026-02-29', '2026-03-01'), THU, BOUNDS))).toMatch(/real calendar date/);
  });

  it('rejects to before from', () => {
    expect(err(resolveRange(custom('2026-09-27', '2026-09-11'), THU, BOUNDS))).toMatch(/before 'from'/);
  });

  it('rejects a range after today in PHT', () => {
    expect(err(resolveRange(custom('2026-09-25', '2026-10-02'), THU, BOUNDS))).toMatch(/after today.*2026-10-01/);
  });

  it(`caps the span at ${MAX_RANGE_DAYS} days inclusive`, () => {
    const now = new Date('2027-12-31T04:00:00Z');
    // 2026-11-26 .. 2027-12-30 = 400 days inclusive; one more day is too long.
    expect(ok(resolveRange(custom('2026-11-26', '2027-12-30'), now, BOUNDS)).from).toBe('2026-11-26');
    expect(err(resolveRange(custom('2026-11-25', '2027-12-30'), now, BOUNDS))).toMatch(/401 days; the maximum is 400/);
  });

  it('a custom range in a past year is VALID (coverage reports it later), not an error', () => {
    const r = ok(resolveRange(custom('2025-09-11', '2025-09-27'), THU, BOUNDS));
    expect(r.label).toBe('Sep 11 to Sep 27, 2025');
  });

  it('crosses a year boundary with both years in the label', () => {
    const r = ok(resolveRange(custom('2025-12-28', '2026-01-03'), THU, BOUNDS));
    expect(r.label).toBe('Dec 28, 2025 to Jan 3, 2026');
    expect(r.previous).toEqual({from: '2025-12-21', to: '2025-12-27'});
  });

  it('previous period crosses a month and year boundary', () => {
    const r = ok(resolveRange(custom('2026-01-01', '2026-01-10'), THU, BOUNDS));
    expect(r.previous).toEqual({from: '2025-12-22', to: '2025-12-31'});
  });
});

describe('rangeLabel', () => {
  it('formats single day, same year and cross-year ranges', () => {
    expect(rangeLabel('2026-09-27', '2026-09-27')).toBe('Sep 27, 2026');
    expect(rangeLabel('2026-09-11', '2026-09-27')).toBe('Sep 11 to Sep 27, 2026');
    expect(rangeLabel('2025-12-28', '2026-01-03')).toBe('Dec 28, 2025 to Jan 3, 2026');
  });
});
