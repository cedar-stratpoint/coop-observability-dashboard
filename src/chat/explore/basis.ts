// Evidence notes for an Explore result, written by CODE from the parsed query and fixed coverage figures, never by the model (spec R6).
// Pure. The sentences are part of the result's caveats and coverage_note, so the model sees them and quoting their figures is not a new claim.
import type {ValidateOk} from './types';
import {baseRelation} from './views';

export const ORDERS_BY_TAG_NOTE = 'Orders counted are those tagged to the event in the POS (untagged sales on the event dates are not included).';
export const ORDERS_BY_DATE_NOTE = 'Orders attributed to the event by date window (includes untagged sales rung up on the event dates).';

export interface LeadFacts {
  count: number;
  withPet: number;
  /** Manila date (YYYY-MM-DD) of the earliest lead that has a pet value, or null when none has. */
  petFrom: string | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dayLabel = (v: unknown): string | null => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  return `${Number(v.slice(8, 10))} ${MONTHS[Number(v.slice(5, 7)) - 1]} ${v.slice(0, 4)}`;
};

/** How many leads exist, how many carry a pet value, and since when the pet field was collected (all leads in the view, not only this result's scope). */
export function leadsCoverageNote(f: LeadFacts): string {
  const from = f.petFrom ? dayLabel(f.petFrom) : null;
  return `${f.count} lead${f.count === 1 ? '' : 's'} in the leads view, ${f.withPet} with a pet value${from ? ` (pet was only collected from ${from})` : ''}.`;
}

/** Orders joined to events: say whether orders were counted by the POS event tag (orders.event_id), by the event date window (starts_on / ends_on), or both. */
export function ordersBasisNotes(v: Pick<ValidateOk, 'relations' | 'columnRefs'>): string[] {
  const isOrders = (r: string | null): boolean => r !== null && ['pos_orders', 'pos_orders_completed'].includes(baseRelation(r));
  if (!v.relations.some(isOrders) || !v.relations.some((r) => baseRelation(r) === 'pos_events')) return [];
  const byTag = v.columnRefs.some((c) => isOrders(c.relation) && c.column === 'event_id');
  const byDate = v.columnRefs.some((c) => c.column === 'starts_on' || c.column === 'ends_on');
  return [...(byTag ? [ORDERS_BY_TAG_NOTE] : []), ...(byDate ? [ORDERS_BY_DATE_NOTE] : [])];
}

// The registry views (coop_chat_*) are 1:1 projections of these base tables, so they carry the same basis.
const CHAT_VIEW_BASE: Record<string, string> = {coop_chat_orders: 'pos_orders', coop_chat_stock_by_location: 'pos_inventory_by_location'};

/** One sentence per basis the query's tables imply (spec 2.5), written by code; shown in Notes and given to the model as a caveat. A query that reads both order bases gets both notes. */
export function tableBasisNotes(relations: readonly string[]): string[] {
  const bases = relations.map((r) => CHAT_VIEW_BASE[r] ?? baseRelation(r));
  const has = (base: string): boolean => bases.includes(base);
  const notes: string[] = [];
  if (relations.includes('pos_orders_completed')) notes.push('Basis: completed orders only (status = completed, the pos_orders_completed default).');
  if (has('pos_orders')) notes.push('Basis: all orders (pos_orders), including voided ones unless the query filters status.');
  if (relations.includes('coop_explore_stock_event')) notes.push('Basis: Event (sellable) stock only.');
  else if (has('pos_inventory')) notes.push('Basis: stock at all locations (event + office).');
  else if (has('pos_inventory_by_location')) notes.push('Basis: stock per location.');
  return notes;
}
