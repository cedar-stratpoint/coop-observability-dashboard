// The preview of an import: which days are new, unchanged or changed, which are frozen, and what to look at before approving.
// Pure. `current` is what the app reads today (the newest accepted figure per day). The plan's `rows` are what the new import will
// contain: EVERY day of the span, with the figure that should win, so the import covers its own window without holes.
import type {DayFigures} from './types';

export const FREEZE_DAYS = 28;
const BIG_CHANGE_PCT = 5;
const BIG_CHANGE_MIN_PESOS = 100;

export interface PlanOptions {
  today: string;
  freezeDays: number;
  restate: boolean;
  onlyNew: boolean;
}
export interface Change {day: string; before: number; after: number; pct: number}
export interface Flag {code: 'BIG_CHANGE' | 'FROZEN_BLOCKED'; day: string; message: string}
export interface Plan {
  rows: DayFigures[];
  newDays: string[];
  unchanged: string[];
  changed: Change[];
  keptCurrent: string[];
  frozenBlocked: string[];
  flags: Flag[];
  /** False when nothing is new and nothing changes: there is nothing to apply. */
  hasEffect: boolean;
}

const dayNumber = (iso: string): number => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
const same = (a: DayFigures, b: DayFigures): boolean =>
  a.salesPlaced === b.salesPlaced && a.salesConfirmed === b.salesConfirmed && a.ordersPlaced === b.ordersPlaced && a.ordersConfirmed === b.ordersConfirmed &&
  a.unitsPlaced === b.unitsPlaced && a.unitsConfirmed === b.unitsConfirmed && a.buyersPlaced === b.buyersPlaced && a.buyersConfirmed === b.buyersConfirmed && a.visitors === b.visitors;
const pctOf = (before: number, after: number): number => (before === 0 ? (after === 0 ? 0 : 100) : Math.round(((after - before) / before) * 1000) / 10);

export function buildPlan(incoming: readonly DayFigures[], current: ReadonlyMap<string, DayFigures>, o: PlanOptions): Plan {
  const plan: Plan = {rows: [], newDays: [], unchanged: [], changed: [], keptCurrent: [], frozenBlocked: [], flags: [], hasEffect: false};
  for (const inc of incoming) {
    const cur = current.get(inc.day);
    if (!cur) {
      plan.newDays.push(inc.day);
      plan.rows.push(inc);
    } else if (same(cur, inc)) {
      plan.unchanged.push(inc.day);
      plan.rows.push(inc);
    } else if (dayNumber(o.today) - dayNumber(inc.day) > o.freezeDays && !o.restate) {
      plan.frozenBlocked.push(inc.day);
      plan.flags.push({code: 'FROZEN_BLOCKED', day: inc.day, message: `${inc.day} is older than ${o.freezeDays} days and differs from what is loaded; it is left as it is (use restate with a reason to change it).`});
      plan.rows.push(cur);
    } else if (o.onlyNew) {
      plan.keptCurrent.push(inc.day);
      plan.rows.push(cur);
    } else {
      const change = {day: inc.day, before: cur.salesConfirmed, after: inc.salesConfirmed, pct: pctOf(cur.salesConfirmed, inc.salesConfirmed)};
      plan.changed.push(change);
      if (Math.abs(change.pct) > BIG_CHANGE_PCT && Math.abs(change.after - change.before) >= BIG_CHANGE_MIN_PESOS) {
        plan.flags.push({code: 'BIG_CHANGE', day: inc.day, message: `${inc.day}: confirmed sales move from ${change.before} to ${change.after} (${change.pct}%).`});
      }
      plan.rows.push(inc);
    }
  }
  plan.hasEffect = plan.newDays.length > 0 || plan.changed.length > 0;
  return plan;
}
