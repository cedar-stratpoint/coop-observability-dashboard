// FICTIONAL digests shaped like PROD digest_archive on 2026-10-07 (spec evidence log): mixed windows; per-day `daily` on the three
// newest, PH-aligned rows (1 to 27 Sep, 21 to 27 Sep, 28 Sep to 4 Oct); an August window at UTC midnight (08:00 PH boundaries); two
// re-runs of a rolling 30-day window 30 minutes apart. scripts/local-supabase/seed-digest.sql seeds the same rows (Task 3).
import {dayKeysBetween} from '../../src/chat/range';
import type {DigestRow} from '../../src/chat/read/digest';
import type {ChannelComparison, DigestDocument} from '../../src/types';

type Day = {day: string; revenue: number; orders: number; units: number};

/** The UTC instant of a PH midnight, e.g. '2026-09-28' -> '2026-09-27T16:00:00.000Z'. */
export const phMidnight = (day: string): string => new Date(Date.parse(`${day}T00:00:00+08:00`)).toISOString();

export const series = (from: string, to: string, revenue: number, orders: number, units: number, skip: string[] = []): Day[] =>
  dayKeysBetween(from, to).filter((d) => !skip.includes(d)).map((day) => ({day, revenue, orders, units}));

export const cmp = (revenue: number, orders: number, units: number): ChannelComparison =>
  ({revenue, orders, aov: Math.round((revenue / orders) * 100) / 100, units, adSpend: null, roas: null});

export function digestRow(from: string, to: string, createdAt: string, extra: Pick<DigestDocument, 'daily' | 'comparison'> = {}): DigestRow {
  return {window_from: from, window_to: to, created_at: createdAt, digest: {window: {label: '', from, to}, degraded: false, headline: 'FICTIONAL', themes: [], figures: [], recommendations: [], ...extra}};
}

/** Newest window first, as the reader returns them. Index 0..2 carry `daily`; 3 is the August UTC window; 4 and 5 are re-runs. */
export const SEPTEMBER_ROWS: DigestRow[] = [
  digestRow(phMidnight('2026-09-28'), phMidnight('2026-10-05'), '2026-10-05T01:00:00.000Z', {
    daily: {shopee: series('2026-09-28', '2026-10-04', 800, 2, 2), lazada: series('2026-09-28', '2026-10-04', 900, 2, 3)},
    comparison: {shopee: cmp(5600, 14, 14), lazada: cmp(6300, 14, 21)},
  }),
  digestRow(phMidnight('2026-09-21'), phMidnight('2026-09-28'), '2026-09-28T01:00:00.000Z', {
    daily: {shopee: series('2026-09-21', '2026-09-27', 1200, 3, 4), lazada: series('2026-09-21', '2026-09-27', 1600, 4, 5)},
    comparison: {shopee: cmp(8400, 21, 28), lazada: cmp(11200, 28, 35)},
  }),
  digestRow(phMidnight('2026-09-01'), phMidnight('2026-09-28'), '2026-09-27T20:00:00.000Z', {
    daily: {shopee: series('2026-09-01', '2026-09-27', 1000, 2, 3, ['2026-09-15']), lazada: series('2026-09-01', '2026-09-27', 1500, 3, 4, ['2026-09-15'])},
    comparison: {shopee: cmp(26000, 52, 78), lazada: cmp(39000, 78, 104)},
  }),
  digestRow('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', '2026-09-01T02:00:00.000Z', {comparison: {shopee: cmp(30000, 60, 90), lazada: cmp(41000, 80, 110)}}),
  digestRow('2026-07-10T03:40:00.000Z', '2026-08-09T03:40:00.000Z', '2026-08-09T03:45:00.000Z', {comparison: {shopee: cmp(28000, 56, 84), lazada: cmp(39500, 79, 105)}}),
  digestRow('2026-07-10T03:12:00.000Z', '2026-08-09T03:12:00.000Z', '2026-08-09T03:15:00.000Z', {comparison: {shopee: cmp(27900, 55, 83), lazada: cmp(39400, 78, 104)}}),
];

/**
 * September 2026 (PH), by hand from the rows above:
 * - Sep 1-20 except 15 from the 1-27 Sep row (19 days).
 * - Sep 15 is a covered zero.
 * - Sep 21-27 from the newer 21-27 Sep row (not both).
 * - Sep 28-30 from the 28 Sep-4 Oct row.
 */
export const SEPTEMBER_EXPECTED = {
  shopee: {revenue: 29800, orders: 65, units: 91, aov: 458.46},
  lazada: {revenue: 42400, orders: 91, units: 120, aov: 465.93},
} as const;
