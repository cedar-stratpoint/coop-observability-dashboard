// The SYN-06 pilot check: a day the sync loaded against the same day in the Monday weekly import. Pure; the runbook (docs/shopee-sync-runbook.md) says how to gather the figures.
// Pass = placed sales within 1% and confirmed sales within 5% of the weekly figure, for each of 7 days.
export const PLACED_TOLERANCE = 1;
export const CONFIRMED_TOLERANCE = 5;
export const PILOT_DAYS = 7;

export interface Figures {
  placed: number;
  confirmed: number;
}
export interface DayComparison {
  day: string;
  placedDeltaPct: number;
  confirmedDeltaPct: number;
  pass: boolean;
  reasons: string[];
}

/** Percent the synced figure is off the weekly one (weekly is the truth). 0 when both are 0; infinite when only the weekly one is 0. */
const deltaPct = (synced: number, weekly: number): number => {
  if (weekly === 0) return synced === 0 ? 0 : synced > 0 ? Infinity : -Infinity;
  return Math.round(((synced - weekly) / Math.abs(weekly)) * 1e6) / 1e4;
};

export function compareDay(i: {day: string; synced: Figures; weekly: Figures}): DayComparison {
  const placedDeltaPct = deltaPct(i.synced.placed, i.weekly.placed);
  const confirmedDeltaPct = deltaPct(i.synced.confirmed, i.weekly.confirmed);
  const reasons: string[] = [];
  if (Math.abs(placedDeltaPct) > PLACED_TOLERANCE) reasons.push(`placed sales off by ${placedDeltaPct}% (limit ${PLACED_TOLERANCE}%)`);
  if (Math.abs(confirmedDeltaPct) > CONFIRMED_TOLERANCE) reasons.push(`confirmed sales off by ${confirmedDeltaPct}% (limit ${CONFIRMED_TOLERANCE}%)`);
  return {day: i.day, placedDeltaPct, confirmedDeltaPct, pass: reasons.length === 0, reasons};
}

export interface PilotSummary {
  pass: boolean;
  compared: number;
  failedDays: string[];
}
/** The pilot passes only when seven days have been compared and none is outside the bounds. A short pilot is neither a pass nor a fail. */
export function summarizePilot(days: readonly DayComparison[]): PilotSummary {
  const failedDays = days.filter((d) => !d.pass).map((d) => d.day);
  return {pass: days.length >= PILOT_DAYS && failedDays.length === 0, compared: days.length, failedDays};
}
