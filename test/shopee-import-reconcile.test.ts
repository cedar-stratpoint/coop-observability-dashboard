import {describe, expect, it} from 'vitest';
import {reconcileDigests, type DigestForReconcile} from '../src/shopee-import/reconcile';

// FICTIONAL figures. Windows are UTC instants as the digest stores them.
const ph = (day: string): string => new Date(Date.parse(`${day}T00:00:00+08:00`)).toISOString();
const row = (from: string, to: string, created: string, revenue: number | null, exportWindow?: {from: string; to: string}): DigestForReconcile => ({
  window_from: from, window_to: to, created_at: created,
  digest: {comparison: {shopee: {revenue}}, shopee: exportWindow ? {sales: {window: exportWindow}} : null},
});
const facts = (days: Record<string, number>): Map<string, number> => new Map(Object.entries(days));
const WEEK = {'2026-09-28': 100, '2026-09-29': 200, '2026-09-30': 300, '2026-10-01': 400, '2026-10-02': 500, '2026-10-03': 600, '2026-10-04': 700};

describe('reconcileDigests', () => {
  it('matches a digest whose Shopee revenue equals the imported days over its window', () => {
    const [l] = reconcileDigests([row(ph('2026-09-28'), ph('2026-10-05'), '2026-10-05T01:00:00Z', 2800)], facts(WEEK));
    expect(l).toMatchObject({status: 'match', digestRevenue: 2800, factsRevenue: 2800, gap: 0, basis: 'digest window'});
  });

  it('reports the gap and its size when the digest is lower than the facts (an early export)', () => {
    const [l] = reconcileDigests([row(ph('2026-09-28'), ph('2026-10-05'), '2026-10-05T01:00:00Z', 2600)], facts(WEEK));
    expect(l).toMatchObject({status: 'differs', gap: -200, gapPct: -7.1});
  });

  it('places the figure by the export dates when the digest carries them, not by its own window', () => {
    // a UTC-midnight window would touch an extra day; the export dates say exactly 28 Sep to 4 Oct
    const [l] = reconcileDigests([row('2026-09-28T00:00:00.000Z', '2026-10-05T00:00:00.000Z', '2026-10-05T01:00:00Z', 2800, {from: '2026-09-28', to: '2026-10-04'})], facts(WEEK));
    expect(l).toMatchObject({status: 'match', basis: 'export dates', from: '2026-09-28', to: '2026-10-04'});
  });

  it('says so when the facts do not cover the window, and when the digest has no Shopee figure', () => {
    const part = facts({'2026-09-28': 100, '2026-09-29': 200});
    expect(reconcileDigests([row(ph('2026-09-28'), ph('2026-10-05'), '2026-10-05T01:00:00Z', 2800)], part)[0]).toMatchObject({status: 'partial_facts', daysMissing: 5});
    expect(reconcileDigests([row(ph('2026-08-03'), ph('2026-08-10'), '2026-08-10T01:00:00Z', 2800)], part)[0]).toMatchObject({status: 'no_facts'});
    expect(reconcileDigests([row(ph('2026-09-28'), ph('2026-10-05'), '2026-10-05T01:00:00Z', null)], facts(WEEK))[0].status).toBe('no_digest_figure');
  });

  it('shows only the newest run of a re-run window, newest window first', () => {
    const lines = reconcileDigests([
      row(ph('2026-09-28'), ph('2026-10-05'), '2026-10-05T01:00:00Z', 2800),
      row(ph('2026-09-28'), ph('2026-10-05'), '2026-10-05T01:20:00Z', 2700),
      row(ph('2026-09-21'), ph('2026-09-28'), '2026-09-28T01:00:00Z', 900),
    ], facts(WEEK));
    expect(lines.map((l) => [l.from, l.digestRevenue])).toEqual([['2026-09-28', 2700], ['2026-09-21', 900]]);
  });
});
