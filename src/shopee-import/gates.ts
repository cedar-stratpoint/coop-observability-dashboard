// The checks a Sales Overview file must pass before anything is written. A file that fails any gate is rejected whole.
// Pure. "today" is the PH calendar day; today and later are open days and never loaded.
import type {DayFigures, GateFailure, ParsedSalesOverview} from './types';

export interface GateContext {
  today: string; // YYYY-MM-DD, PH
  /** The dates in the file name, when the name carries them. */
  filenamePeriod?: {from: string; to: string} | null;
}

export interface GateResult {
  failures: GateFailure[];
  /** The days that may be loaded: sorted, closed days only. Empty when a gate failed. */
  days: DayFigures[];
  openSkipped: string[];
}

const nextDay = (iso: string): string => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const fail = (code: string, message: string): GateFailure => ({code, message});
const TOLERANCE = 0.5; // the file rounds each day to whole pesos

export function runGates(p: ParsedSalesOverview, ctx: GateContext): GateResult {
  const failures: GateFailure[] = [];
  const days = [...p.days].sort((a, b) => (a.day < b.day ? -1 : 1));
  if (days.length === 0) return {failures: [fail('EMPTY', 'The file has no daily rows.')], days: [], openSkipped: []};

  const seen = new Set<string>();
  for (const d of days) {
    if (seen.has(d.day)) failures.push(fail('DUPLICATE_DAY', `${d.day} appears more than once.`));
    seen.add(d.day);
  }
  for (let i = 1; i < days.length; i += 1) {
    if (days[i].day !== days[i - 1].day && days[i].day !== nextDay(days[i - 1].day)) {
      failures.push(fail('GAP', `No row between ${days[i - 1].day} and ${days[i].day}.`));
      break;
    }
  }
  if (days[0].day !== p.periodFrom || days[days.length - 1].day !== p.periodTo) {
    failures.push(fail('PERIOD_MISMATCH', `The summary says ${p.periodFrom} to ${p.periodTo} but the daily rows run ${days[0].day} to ${days[days.length - 1].day}.`));
  }
  if (ctx.filenamePeriod && (ctx.filenamePeriod.from !== p.periodFrom || ctx.filenamePeriod.to !== p.periodTo)) {
    failures.push(fail('FILENAME_MISMATCH', `The file name says ${ctx.filenamePeriod.from} to ${ctx.filenamePeriod.to} but the file covers ${p.periodFrom} to ${p.periodTo}.`));
  }
  const sum = (k: 'salesPlaced' | 'salesConfirmed'): number => days.reduce((s, d) => s + d[k], 0);
  if (!(Math.abs(sum('salesPlaced') - p.summary.salesPlaced) <= TOLERANCE)) failures.push(fail('SUM_PLACED', `Daily placed sales add up to ${sum('salesPlaced')} but the file's own total is ${p.summary.salesPlaced}.`));
  if (!(Math.abs(sum('salesConfirmed') - p.summary.salesConfirmed) <= TOLERANCE)) failures.push(fail('SUM_CONFIRMED', `Daily confirmed sales add up to ${sum('salesConfirmed')} but the file's own total is ${p.summary.salesConfirmed}.`));
  for (const d of days) {
    // Not a gate: confirmed can exceed placed on a day (it counts orders confirmed that day, including ones placed earlier). 2 of the 105 real days do.
    const values = [d.salesPlaced, d.salesConfirmed, d.ordersPlaced, d.ordersConfirmed, d.unitsPlaced, d.unitsConfirmed];
    if (values.some((v) => !Number.isFinite(v) || v < 0)) failures.push(fail('BAD_NUMBER', `${d.day}: a figure is negative or not a number.`));
  }

  const open = days.filter((d) => d.day >= ctx.today);
  const closed = days.filter((d) => d.day < ctx.today);
  if (closed.length === 0) failures.push(fail('ALL_DAYS_OPEN', 'Every day in the file is today or later, so none can be loaded yet.'));
  return {failures, days: failures.length ? [] : closed, openSkipped: open.map((d) => d.day)};
}
