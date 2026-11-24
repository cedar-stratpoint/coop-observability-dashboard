// Goldline restock hit or miss (pure, unit-tested). Every line the owner decides on the
// Restock run (F11) is a hit or a miss for Coop's number (decided Nov 4):
//
//   hit   approved as is (an edit back to Coop's own number is stored as approved)
//   miss  edited or rejected
//
// Lines still pending don't count; held and covered lines are never decided. A miss also
// says which way Coop was off:
//   too high  rejected (nothing sent), or edited down
//   too low   edited up
// and by how much: units off = |final − Coop's number| (a rejected line is off by all of it).
// The decided lines come from restock_decisions() (supabase/nichido/p3e_hit_rate.sql).

import type {Decision} from './goldline-restock';

export type DecidedLine = {
  cycle: string;
  runDate: string;
  storeCode: string;
  itemCode: string;
  productLine: string | null;
  decision: Exclude<Decision, 'pending'>;
  suggested: number | null;
  finalQty: number | null;
  remark: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
};

export type Tally = {
  decided: number;
  hits: number;
  edited: number;
  rejected: number;
  misses: number;
  rate: number | null; // hits ÷ decided, null when nothing is decided
  tooHigh: number; // units Coop suggested over the final number
  tooLow: number; // units Coop suggested under it
};

export const isHit = (l: Pick<DecidedLine, 'decision'>) => l.decision === 'approved';

/** Final − Coop's number: negative = Coop too high, positive = too low, 0 for a hit. */
export function change(l: Pick<DecidedLine, 'decision' | 'suggested' | 'finalQty'>): number {
  if (isHit(l)) return 0;
  const suggested = l.suggested ?? 0;
  const final = l.decision === 'rejected' ? 0 : (l.finalQty ?? suggested);
  return final - suggested;
}

export function missDirection(l: Pick<DecidedLine, 'decision' | 'suggested' | 'finalQty'>): 'too_high' | 'too_low' | null {
  const c = change(l);
  if (l.decision === 'rejected' || c < 0) return 'too_high';
  return c > 0 ? 'too_low' : null;
}

export function tally(lines: DecidedLine[]): Tally {
  const t: Tally = {decided: 0, hits: 0, edited: 0, rejected: 0, misses: 0, rate: null, tooHigh: 0, tooLow: 0};
  for (const l of lines) {
    t.decided++;
    if (l.decision === 'approved') t.hits++;
    else if (l.decision === 'edited') t.edited++;
    else t.rejected++;
    const c = change(l);
    if (c < 0) t.tooHigh += -c;
    else t.tooLow += c;
  }
  t.misses = t.edited + t.rejected;
  t.rate = t.decided ? t.hits / t.decided : null;
  return t;
}

export type RunTally = Tally & {cycle: string; runDate: string};

/** One tally per run, oldest first. */
export function byRun(lines: DecidedLine[]): RunTally[] {
  const by = new Map<string, DecidedLine[]>();
  for (const l of lines) by.set(l.cycle, [...(by.get(l.cycle) ?? []), l]);
  return [...by.entries()]
    .map(([cycle, ls]) => ({cycle, runDate: ls[0].runDate, ...tally(ls)}))
    .sort((a, b) => a.runDate.localeCompare(b.runDate) || a.cycle.localeCompare(b.cycle));
}

/** The latest run's hit rate against the run before it, in percentage points. */
export function deltaVsPrevious(runs: RunTally[]): {latest: number; previous: number | null; points: number | null} | null {
  const withRate = runs.filter((r) => r.rate != null);
  const last = withRate.at(-1);
  if (!last) return null;
  const prev = withRate.at(-2);
  const latest = last.rate as number;
  const previous = prev ? (prev.rate as number) : null;
  return {latest, previous, points: previous == null ? null : Math.round(latest * 100) - Math.round(previous * 100)};
}

export type GroupTally = Tally & {key: string};

/** One tally per key (store, product line), lowest hit rate first, then most decided. */
export function byKey(lines: DecidedLine[], key: (l: DecidedLine) => string): GroupTally[] {
  const by = new Map<string, DecidedLine[]>();
  for (const l of lines) by.set(key(l), [...(by.get(key(l)) ?? []), l]);
  return [...by.entries()]
    .map(([k, ls]) => ({key: k, ...tally(ls)}))
    .sort((a, b) => (a.rate ?? 1) - (b.rate ?? 1) || b.decided - a.decided || a.key.localeCompare(b.key, undefined, {numeric: true}));
}

export const OTHER_LINE = 'Other';
export const byStore = (lines: DecidedLine[]) => byKey(lines, (l) => l.storeCode);
export const byProductLine = (lines: DecidedLine[]) => byKey(lines, (l) => l.productLine?.trim() || OTHER_LINE);

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const newestFirst = (a: DecidedLine, b: DecidedLine) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? '') || b.runDate.localeCompare(a.runDate);

export type MissedItem = {itemCode: string; productLine: string | null; missed: number; decided: number; typicalChange: number; latestRemark: string | null};

/** Items missed most often (ties: most decided), with the median change and the latest remark. */
export function mostMissed(lines: DecidedLine[], n = 5): MissedItem[] {
  const by = new Map<string, DecidedLine[]>();
  for (const l of lines) by.set(l.itemCode, [...(by.get(l.itemCode) ?? []), l]);
  return [...by.entries()]
    .map(([itemCode, ls]) => {
      const misses = ls.filter((l) => !isHit(l)).sort(newestFirst);
      return {
        itemCode,
        productLine: ls[0].productLine,
        missed: misses.length,
        decided: ls.length,
        typicalChange: misses.length ? median(misses.map(change)) : 0,
        latestRemark: misses.find((l) => l.remark?.trim())?.remark?.trim() ?? null,
      };
    })
    .filter((i) => i.missed > 0)
    .sort((a, b) => b.missed - a.missed || b.decided - a.decided || a.itemCode.localeCompare(b.itemCode))
    .slice(0, n);
}

/** The newest misses with a remark (what the owner said, stored to teach Coop later). */
export const latestRemarks = (lines: DecidedLine[], n = 6) => lines.filter((l) => !isHit(l) && l.remark?.trim()).sort(newestFirst).slice(0, n);

export type HitFilter = {store?: string | null; productLine?: string | null; decidedBy?: string | null};

/** Narrow the lines to one store, product line and/or person who decided ('' = no name on file). */
export function filterLines(lines: DecidedLine[], f: HitFilter): DecidedLine[] {
  return lines.filter(
    (l) =>
      (!f.store || l.storeCode === f.store) &&
      (!f.productLine || (l.productLine?.trim() || OTHER_LINE) === f.productLine) &&
      (f.decidedBy == null || (l.decidedBy ?? '') === f.decidedBy),
  );
}
