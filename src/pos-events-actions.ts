'use server';

import {revalidatePath, revalidateTag} from 'next/cache';
import {POS_TAGS} from './pos-cache';
import {posClient, usingPosMock} from './pos-data';
import type {ActionResult} from './pos-actions';

const ACTOR = 'coop';

/** Fields the Coop scheduling form can set. event_id present = edit an existing
 *  event; absent = create (the RPC mints the id). Only keys included are written
 *  (upsert_pos_event overwrites just the keys the payload carries). */
export type EventInput = {
  event_id?: string;
  name: string;
  venue?: string | null;
  city?: string | null;
  organizer?: string | null;
  starts_on?: string | null; // 'YYYY-MM-DD'
  ends_on?: string | null;   // 'YYYY-MM-DD'
  opening_cash?: number | null;
  cash_note?: string | null;
  status?: 'active' | 'closed';
  closing_cash?: number | null;
};

/**
 * Create or edit a bazaar event from Coop, through the SECURITY DEFINER
 * upsert_pos_event RPC (the single write path). Overlapping / same-day events are
 * allowed; the cashier declares which event a sale belongs to on the POS.
 * Online-only, mirrors the other pos_* server actions. Revalidates the events +
 * offline-sales surfaces so the change shows on next render.
 */
export async function upsertEventAction(input: EventInput): Promise<ActionResult> {
  if (usingPosMock()) {
    return {ok: false, error: 'Running in mock mode. Set the Supabase pos_* env to schedule events.'};
  }

  const name = input.name?.trim() ?? '';
  if (name === '') return {ok: false, error: 'Give the event a name.'};

  const starts = input.starts_on || null;
  const ends = input.ends_on || null;
  if (starts && ends && ends < starts) {
    return {ok: false, error: 'The end date is before the start date.'};
  }

  // Build the jsonb payload; the RPC extracts every value as text, so numbers and
  // strings both work. Only send keys the form owns so a partial edit is safe.
  const p_event: Record<string, unknown> = {
    name,
    venue: input.venue?.trim() || null,
    city: input.city?.trim() || null,
    organizer: input.organizer?.trim() || null,
    starts_on: starts,
    ends_on: ends,
    opening_cash: input.opening_cash ?? null,
    cash_note: input.cash_note?.trim() || null,
    created_by: ACTOR,
  };
  if (input.event_id) p_event.event_id = input.event_id;
  if (input.status) p_event.status = input.status;
  if (input.closing_cash !== undefined) p_event.closing_cash = input.closing_cash;

  const {data, error} = await posClient().rpc('upsert_pos_event', {p_event});
  if (error) return {ok: false, error: error.message};

  // Persist the read-time attribution: attach untagged sales whose date now falls
  // in this event's range, so the DB (and the POS app) match Coop's reporting. The
  // event already saved, so a hiccup here shouldn't fail the save (read-time still
  // covers Coop's own views).
  const eventId = typeof data === 'string' ? data : input.event_id;
  if (eventId) {
    // Best-effort: the RPC returns its error rather than throwing, so a hiccup here
    // never fails the (already-committed) event save.
    await posClient().rpc('attribute_untagged_orders_to_event', {p_event_id: eventId});
  }

  revalidatePath('/offline-sales/events');
  revalidatePath('/offline-sales');
  revalidatePath('/inventory');
  revalidateTag(POS_TAGS.events, 'max');
  revalidateTag(POS_TAGS.orders, 'max'); // attribute_untagged_orders may re-tag orders' event_id
  return {ok: true};
}

/** Close an event and optionally record the counted till, via close_pos_event. */
export async function closeEventAction(eventId: string, closingCash: number | null): Promise<ActionResult> {
  if (usingPosMock()) {
    return {ok: false, error: 'Running in mock mode. Set the Supabase pos_* env to close events.'};
  }
  const {error} = await posClient().rpc('close_pos_event', {
    p_event_id: eventId,
    p_closing_cash: closingCash,
  });
  if (error) return {ok: false, error: error.message};

  revalidatePath('/offline-sales/events');
  revalidatePath('/offline-sales');
  revalidateTag(POS_TAGS.events, 'max');
  return {ok: true};
}

/**
 * Correct a sale's event attribution (multi-event): move an order to a different
 * event, or untag it (pass null). Goes through the SECURITY DEFINER
 * set_pos_order_event RPC. Used by the dashboard reassign control when the POS
 * tagged a sale to the wrong same-day event. Online-only.
 */
export async function reassignOrderEventAction(orderId: string, eventId: string | null): Promise<ActionResult> {
  if (usingPosMock()) {
    return {ok: false, error: 'Running in mock mode. Set the Supabase pos_* env to reassign sales.'};
  }
  if (!orderId) return {ok: false, error: 'Missing order.'};

  const {error} = await posClient().rpc('set_pos_order_event', {
    p_order_id: orderId,
    p_event_id: eventId,
  });
  if (error) return {ok: false, error: error.message};

  revalidatePath('/offline-sales/events');
  revalidatePath('/offline-sales');
  revalidateTag(POS_TAGS.orders, 'max');
  revalidateTag(POS_TAGS.events, 'max');
  return {ok: true};
}
