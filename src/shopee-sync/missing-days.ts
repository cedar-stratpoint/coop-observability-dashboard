// Which days a sync should load: every MISSING and CLOSED Shopee day, worked out by the server from the loaded days (the client never sends days).
// Closed = before today in Philippine time (UTC+8) AND past the finality cutoff (06:00 PH the next day), so today and not-yet-final days never qualify.
import {weeksCoverage} from '../shopee-import/coverage';

export const MAX_SYNC_DAYS = 31;
export const FINALITY_CUTOFF_HOUR_PH = 6;
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
}

/** With nothing loaded at all there is no first week to measure from, so nothing is reported missing. */
export function missingClosedDays(loadedDays: readonly string[], now: Date): MissingDays {
  const yesterday = new Date(Date.parse(`${phDay(now)}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
  const all = weeksCoverage(loadedDays, yesterday)
    .flatMap((w) => w.missing)
    .filter((d) => now.getTime() >= finalFrom(d))
    .sort();
  return {days: all.slice(0, MAX_SYNC_DAYS), more: Math.max(0, all.length - MAX_SYNC_DAYS)};
}
