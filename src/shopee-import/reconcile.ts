// Digest versus imported facts: for each stored digest window, the Shopee revenue the digest published against the sum of the imported daily
// confirmed sales over the same days. Pure; measures the gap, changes nothing. The window is placed by Shopee's own export dates when the
// digest carries them (they are exact days), else by the days the digest window touches.
import {dedupeReruns, windowDays, windowOf} from '../digest-windows';

export interface DigestForReconcile {
  window_from: string;
  window_to: string;
  created_at: string;
  digest: {
    comparison?: {shopee?: {revenue?: number | null} | null} | null;
    shopee?: {sales?: {window?: {from?: string | null; to?: string | null} | null} | null} | null;
  };
}

export interface ReconcileLine {
  from: string;
  to: string;
  basis: 'export dates' | 'digest window';
  digestRevenue: number | null;
  factsRevenue: number | null;
  daysMissing: number;
  gap: number | null;
  gapPct: number | null;
  status: 'match' | 'differs' | 'no_facts' | 'partial_facts' | 'no_digest_figure';
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;
const dayKeys = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};
const round2 = (n: number): number => Math.round(n * 100) / 100;

export function reconcileDigests(rows: readonly DigestForReconcile[], factsByDay: ReadonlyMap<string, number>): ReconcileLine[] {
  const newest = dedupeReruns(rows, windowOf).sort((a, b) => (a.window_to < b.window_to ? 1 : -1));
  return newest.map((r): ReconcileLine => {
    const own = r.digest.shopee?.sales?.window;
    const exact = own?.from && own?.to && DAY_RE.test(own.from) && DAY_RE.test(own.to) && own.from <= own.to ? {from: own.from, to: own.to} : null;
    const span = exact ?? (() => {
      const d = windowDays(windowOf(r));
      return {from: d.min, to: d.max};
    })();
    const days = dayKeys(span.from, span.to);
    const have = days.filter((d) => factsByDay.has(d));
    const digestRevenue = r.digest.comparison?.shopee?.revenue ?? null;
    const factsRevenue = have.length ? round2(have.reduce((s, d) => s + (factsByDay.get(d) ?? 0), 0)) : null;
    const base = {from: span.from, to: span.to, basis: exact ? 'export dates' as const : 'digest window' as const, digestRevenue, factsRevenue, daysMissing: days.length - have.length, gap: null, gapPct: null};
    if (digestRevenue === null) return {...base, status: 'no_digest_figure'};
    if (have.length === 0) return {...base, status: 'no_facts'};
    if (have.length < days.length) return {...base, status: 'partial_facts'};
    const gap = round2(digestRevenue - (factsRevenue as number));
    return {...base, gap, gapPct: factsRevenue ? Math.round((gap / (factsRevenue as number)) * 1000) / 10 : null, status: Math.abs(gap) < 1 ? 'match' : 'differs'};
  });
}
