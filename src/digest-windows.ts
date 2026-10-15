// The stored digest windows in Philippine days (spec F.5). Pure; shared by the dashboard and Ask Coop.
// window_from / window_to are timestamptz, half-open [from, to). A day is a PH calendar day (UTC+8, no DST). Never read a window with
// iso.slice(0, 10): a PH-midnight start (16:00Z) would show as the day before, and the exclusive end as the day after.
import {periodDays, phDay, phDayStart} from './custom-range';
import {rangeLabel} from './chat/range';

export interface DigestWindow {
  from: string;
  to: string;
  createdAt: string;
}
export type CoverPick = {window: DigestWindow; covered: {fromDay: string; toDay: string}; full: boolean};

const DAY_MS = 86_400_000;
const PH_MS = 8 * 3_600_000;
const RERUN_MS = 3_600_000; // re-runs: same start and end within one hour (PROD, 5 re-runs on 9 Aug)

export const windowOf = (r: {window_from: string; window_to: string; created_at: string}): DigestWindow => ({from: r.window_from, to: r.window_to, createdAt: r.created_at});

export const isPhMidnight = (iso: string): boolean => (Date.parse(iso) + PH_MS) % DAY_MS === 0;
export const isPhAligned = (w: Pick<DigestWindow, 'from' | 'to'>): boolean => isPhMidnight(w.from) && isPhMidnight(w.to);

/** The first and last PH day a window touches (periodDays, the dashboard's own picker bounds). */
export const windowDays = (w: Pick<DigestWindow, 'from' | 'to'>): {min: string; max: string} => periodDays(w.from, w.to);

/** The first and last PH day a window covers IN FULL (a window starting 08:00 PH does not cover its first day). Null when none. */
export function fullDays(w: Pick<DigestWindow, 'from' | 'to'>): {min: string; max: string} | null {
  const start = Math.ceil((Date.parse(w.from) + PH_MS) / DAY_MS) * DAY_MS - PH_MS;
  const end = Math.floor((Date.parse(w.to) + PH_MS) / DAY_MS) * DAY_MS - PH_MS;
  return end > start ? {min: phDay(start), max: phDay(end - 1)} : null;
}

const two = (n: number): string => String(n).padStart(2, '0');

/** "Aug 1, 2026 08:00": an instant in PH time. */
export function phStamp(iso: string): string {
  const d = new Date(Date.parse(iso) + PH_MS);
  const day = d.toISOString().slice(0, 10);
  return `${rangeLabel(day, day)} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** "Sep 21 to Sep 27, 2026" for a PH-aligned window; exact PH boundaries otherwise (spec F.6, from the PROD data). */
export function windowLabel(w: Pick<DigestWindow, 'from' | 'to'>): string {
  if (!isPhAligned(w)) return `${phStamp(w.from)} to ${phStamp(w.to)} (PH time)`;
  const {min, max} = windowDays(w);
  return rangeLabel(min, max);
}

export const sameWindow = (a: DigestWindow, b: DigestWindow): boolean =>
  Date.parse(a.from) === Date.parse(b.from) && Date.parse(a.to) === Date.parse(b.to) && Date.parse(a.createdAt) === Date.parse(b.createdAt);

/** Re-runs (same start and end within an hour) keep only the newest created_at. Newest window first (window_to, then created_at). */
export function dedupeReruns<T>(items: readonly T[], win: (t: T) => DigestWindow): T[] {
  const t = (s: string): number => Date.parse(s);
  const kept: T[] = [];
  for (const it of [...items].sort((a, b) => t(win(b).createdAt) - t(win(a).createdAt))) {
    const w = win(it);
    if (!kept.some((k) => Math.abs(t(win(k).from) - t(w.from)) <= RERUN_MS && Math.abs(t(win(k).to) - t(w.to)) <= RERUN_MS)) kept.push(it);
  }
  return kept.sort((a, b) => t(win(b).to) - t(win(a).to) || t(win(b).createdAt) - t(win(a).createdAt));
}

/** The window that covers PH days fromDay..toDay, or overlaps them most (ties: the shorter, then the newer run). Null when none touches them. */
export function pickCovering(windows: readonly DigestWindow[], fromDay: string, toDay: string): CoverPick | null {
  const lo = phDayStart(fromDay);
  const hi = phDayStart(toDay) + DAY_MS;
  const best = windows
    .map((w) => ({w, f: Date.parse(w.from), t: Date.parse(w.to)}))
    .map((x) => ({...x, ov: Math.min(hi, x.t) - Math.max(lo, x.f)}))
    .filter((x) => x.ov > 0)
    .sort((a, b) => b.ov - a.ov || a.t - a.f - (b.t - b.f) || Date.parse(b.w.createdAt) - Date.parse(a.w.createdAt))[0];
  if (!best) return null;
  return {window: best.w, covered: {fromDay: phDay(Math.max(lo, best.f)), toDay: phDay(Math.min(hi, best.t) - 1)}, full: best.f <= lo && best.t >= hi};
}

/** The stored windows closest to fromDay..toDay, nearest first (for "no digest covers it"). */
export function nearestWindows(windows: readonly DigestWindow[], fromDay: string, toDay: string, n = 3): DigestWindow[] {
  const lo = phDayStart(fromDay);
  const hi = phDayStart(toDay) + DAY_MS;
  const gap = (w: DigestWindow): number => Math.max(Date.parse(w.from) - hi, lo - Date.parse(w.to), 0);
  return [...windows].sort((a, b) => gap(a) - gap(b)).slice(0, n);
}
