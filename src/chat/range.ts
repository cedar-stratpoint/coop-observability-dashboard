import type {MetricRequest} from './result-types';
import {manilaDayKey} from '../pos-sales-compute';

// Date-range resolution for Ask Coop metrics. Pure. Every date is a Philippine-time
// (PHT, Asia/Manila, UTC+8, no DST) calendar day written as inclusive YYYY-MM-DD.
// Weeks run Monday to Sunday. The machine's timezone is never used.

export const MAX_RANGE_DAYS = 400;

export interface RangeBounds {
  dataFrom: string | null;
  dataTo: string | null;
}

export interface ResolvedRange {
  ok: true;
  from: string;
  to: string;
  label: string;
  /** The period of equal length immediately before [from, to]. */
  previous: {from: string; to: string};
}

export interface RangeError {
  ok: false;
  error: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RANGES = ['last_week', 'this_week', 'last_month', 'all_available', 'custom'] as const;

/** Epoch ms of 00:00 UTC for a valid YYYY-MM-DD, or null when it is not a real calendar date. */
function dayMs(key: string): number | null {
  if (!ISO_DAY.test(key)) return null;
  const ms = Date.parse(`${key}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10) === key ? ms : null; // rejects 2026-02-30
}

/** True for a real calendar date written YYYY-MM-DD (false for 2026-02-30). */
export const isRealDay = (key: string): boolean => dayMs(key) !== null;

const keyOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const addDays = (key: string, n: number): string => keyOf((dayMs(key) as number) + n * DAY_MS);
/** Inclusive number of days from..to. */
const spanDays = (from: string, to: string): number => Math.round(((dayMs(to) as number) - (dayMs(from) as number)) / DAY_MS) + 1;
/** Days since the Monday of this date's week (Monday = 0 ... Sunday = 6). */
const sinceMonday = (key: string): number => (new Date(dayMs(key) as number).getUTCDay() + 6) % 7;

/** The Monday (YYYY-MM-DD) of the week a valid day falls in. */
export const mondayOf = (key: string): string => addDays(key, -sinceMonday(key));
export const addDaysKey = addDays;

/** Every day from..to inclusive (both valid, from <= to), ascending. */
export function dayKeysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function fmt(key: string, withYear: boolean): string {
  const [y, m, d] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ''}`;
}

/** e.g. "Sep 11 to Sep 27, 2026"; "Dec 28, 2025 to Jan 3, 2026" across years; "Sep 27, 2026" for one day. */
export function rangeLabel(from: string, to: string): string {
  if (from === to) return fmt(from, true);
  if (from.slice(0, 4) === to.slice(0, 4)) return `${fmt(from, false)} to ${fmt(to, true)}`;
  return `${fmt(from, true)} to ${fmt(to, true)}`;
}

function build(from: string, to: string): ResolvedRange {
  const n = spanDays(from, to);
  const prevTo = addDays(from, -1);
  return {ok: true, from, to, label: rangeLabel(from, to), previous: {from: addDays(prevTo, -(n - 1)), to: prevTo}};
}

const fail = (error: string): RangeError => ({ok: false, error});

export function resolveRange(req: Pick<MetricRequest, 'range' | 'from' | 'to'>, now: Date, bounds: RangeBounds): ResolvedRange | RangeError {
  const today = manilaDayKey(now.toISOString());
  const {range, from, to} = req;

  if (!(RANGES as readonly string[]).includes(range)) {
    return fail(`Unknown range '${String(range)}'. Allowed: ${RANGES.join(', ')}.`);
  }

  if (range !== 'custom') {
    if (from !== '' || to !== '') {
      return fail(`'from' and 'to' must be '' (empty) unless range is 'custom'; got range '${range}' with from '${from}' and to '${to}'. Use range 'custom' with both dates, or send '' for both.`);
    }
    if (range === 'this_week') return build(addDays(today, -sinceMonday(today)), today);
    if (range === 'last_week') {
      const lastSunday = addDays(today, -sinceMonday(today) - 1);
      return build(addDays(lastSunday, -6), lastSunday);
    }
    if (range === 'last_month') {
      const firstOfThisMonth = `${today.slice(0, 7)}-01`;
      const lastDay = addDays(firstOfThisMonth, -1);
      return build(`${lastDay.slice(0, 7)}-01`, lastDay);
    }
    // all_available
    if (!bounds.dataFrom || !bounds.dataTo) {
      return fail("No data yet: there are no completed orders, so 'all_available' has no dates. Try again once sales are recorded.");
    }
    return build(bounds.dataFrom, bounds.dataTo);
  }

  // custom
  if (from === '' || to === '') {
    return fail("range 'custom' needs both 'from' and 'to' as YYYY-MM-DD dates; one or both were empty ('').");
  }
  const fromMs = dayMs(from);
  const toMs = dayMs(to);
  if (fromMs === null) return fail(`'from' must be a real calendar date written YYYY-MM-DD; got '${from}'.`);
  if (toMs === null) return fail(`'to' must be a real calendar date written YYYY-MM-DD; got '${to}'.`);
  if (toMs < fromMs) return fail(`'to' (${to}) is before 'from' (${from}). 'to' must be on or after 'from'.`);
  if (to > today) return fail(`'to' (${to}) is after today in Philippine time (${today}). The latest allowed 'to' is ${today}.`);
  const n = spanDays(from, to);
  if (n > MAX_RANGE_DAYS) return fail(`The range ${from} to ${to} is ${n} days; the maximum is ${MAX_RANGE_DAYS} days. Use a shorter range or 'all_available'.`);
  return build(from, to);
}
