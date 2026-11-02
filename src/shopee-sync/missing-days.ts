// Which days a sync should load: every MISSING and CLOSED Shopee day, worked out by the server from the loaded days (the client never sends days).
// Closed = before today in Philippine time (UTC+8) AND past the finality cutoff (06:00 PH the next day), so today and not-yet-final days never qualify.
import {weeksCoverage} from '../shopee-import/coverage';

export const MAX_SYNC_DAYS = 31;
export const FINALITY_CUTOFF_HOUR_PH = 6;
/** How far back (days before yesterday, inclusive of yesterday: 35 days in all) By Week can reasonably reach. Older gaps are left for the Monday import. */
export const REACHABLE_DAYS = 35;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The Philippine calendar day (YYYY-MM-DD) of an instant. */
export const phDay = (now: Date): string => new Date(now.getTime() + 8 * HOUR).toISOString().slice(0, 10);

/** The instant from which `day` counts as final: 06:00 PH on the following day. */
const finalFrom = (day: string): number => Date.parse(`${day}T00:00:00+08:00`) + DAY + FINALITY_CUTOFF_HOUR_PH * HOUR;

export interface MissingDays {
  /** Oldest first, at most MAX_SYNC_DAYS. */
  days: string[];
  /** Missing closed days that did not fit in this job; the next press picks them up. */
  more: number;
  /** Missing closed days older than REACHABLE_DAYS: never put in a job, left for the Monday import. */
  unreachable: number;
}

const yesterdayPh = (now: Date): string => new Date(Date.parse(`${phDay(now)}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
/** The oldest day a sync may still be asked to load. */
export const oldestReachable = (now: Date): string => new Date(Date.parse(`${yesterdayPh(now)}T00:00:00Z`) - (REACHABLE_DAYS - 1) * DAY).toISOString().slice(0, 10);

/** With nothing loaded at all there is no first week to measure from, so nothing is reported missing. */
export function missingClosedDays(loadedDays: readonly string[], now: Date): MissingDays {
  const oldest = oldestReachable(now);
  const closed = weeksCoverage(loadedDays, yesterdayPh(now))
    .flatMap((w) => w.missing)
    .filter((d) => now.getTime() >= finalFrom(d))
    .sort();
  const all = closed.filter((d) => d >= oldest);
  return {days: all.slice(0, MAX_SYNC_DAYS), more: Math.max(0, all.length - MAX_SYNC_DAYS), unreachable: closed.length - all.length};
}

/** The newest day that is already final: yesterday (PH) once it passes 06:00 PH today, else the day before. What a refresh press re-exports when nothing is missing. */
export function latestClosedDay(now: Date): string {
  const yesterday = new Date(Date.parse(`${phDay(now)}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
  return now.getTime() >= finalFrom(yesterday) ? yesterday : new Date(Date.parse(`${yesterday}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
}
