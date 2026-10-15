import {describe, expect, it} from 'vitest';
import {
  dedupeReruns, fullDays, isPhAligned, nearestWindows, pickCovering, sameWindow, windowDays, windowLabel, windowOf,
} from '../src/digest-windows';
import {SEPTEMBER_ROWS} from './support/channel-report-fixture';

const W = SEPTEMBER_ROWS.map(windowOf);
const [A, B, C, D, E2, E1] = W;

describe('PH days of a stored window (F.5 date fix)', () => {
  it('a PH-midnight start is that PH day, and the exclusive end is the day before it (never iso.slice(0, 10))', () => {
    expect(A.from).toBe('2026-09-27T16:00:00.000Z');
    expect(A.from.slice(0, 10)).toBe('2026-09-27'); // the old, wrong reading
    expect(windowDays(A)).toEqual({min: '2026-09-28', max: '2026-10-04'});
    expect(isPhAligned(A)).toBe(true);
  });
  it('a window at UTC midnight touches its first and last PH day only partly', () => {
    expect(isPhAligned(D)).toBe(false);
    expect(windowDays(D)).toEqual({min: '2026-08-01', max: '2026-09-01'});
    expect(fullDays(D)).toEqual({min: '2026-08-02', max: '2026-08-31'});
    expect(fullDays(A)).toEqual(windowDays(A));
  });
  it('labels: PH dates when aligned, exact PH times when not', () => {
    expect(windowLabel(A)).toBe('Sep 28 to Oct 4, 2026');
    expect(windowLabel(B)).toBe('Sep 21 to Sep 27, 2026');
    expect(windowLabel(D)).toBe('Aug 1, 2026 08:00 to Sep 1, 2026 08:00 (PH time)');
  });
});

describe('re-runs', () => {
  it('windows within 1 hour at both ends keep only the newest run, newest window first', () => {
    const kept = dedupeReruns(W, (w) => w);
    expect(kept).toHaveLength(5);
    expect(kept.map(windowLabel)).toEqual([
      'Sep 28 to Oct 4, 2026', 'Sep 21 to Sep 27, 2026', 'Sep 1 to Sep 27, 2026',
      'Aug 1, 2026 08:00 to Sep 1, 2026 08:00 (PH time)', 'Jul 10, 2026 11:40 to Aug 9, 2026 11:40 (PH time)',
    ]);
    expect(kept.some((w) => sameWindow(w, E1))).toBe(false);
    expect(kept.some((w) => sameWindow(w, E2))).toBe(true);
  });
  it('sameWindow compares instants, not spellings', () => {
    expect(sameWindow(A, {from: '2026-09-27T16:00:00+00:00', to: '2026-10-04T16:00:00+00:00', createdAt: '2026-10-05T01:00:00+00:00'})).toBe(true);
  });
});

describe('covering', () => {
  const idx = dedupeReruns(W, (w) => w);
  it('a date inside one window picks it; PH 28 Sep is the 28 Sep to 4 Oct window', () => {
    expect(pickCovering(idx, '2026-09-28', '2026-09-28')).toEqual({window: A, covered: {fromDay: '2026-09-28', toDay: '2026-09-28'}, full: true});
  });
  it('a range picks the window that overlaps it most and says which part it covers', () => {
    const p = pickCovering(idx, '2026-09-01', '2026-09-30');
    expect(p?.window).toEqual(C);
    expect(p?.covered).toEqual({fromDay: '2026-09-01', toDay: '2026-09-27'});
    expect(p?.full).toBe(false);
  });
  it('a tie on overlap prefers the shorter window', () => {
    expect(pickCovering(idx, '2026-09-24', '2026-09-24')?.window).toEqual(B);
  });
  it('nothing overlapping is null, and the nearest windows come back nearest first', () => {
    expect(pickCovering(idx, '2026-06-01', '2026-06-01')).toBeNull();
    expect(nearestWindows(idx, '2026-06-01', '2026-06-01', 2)).toEqual([E2, D]);
  });
});
