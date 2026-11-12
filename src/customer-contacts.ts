/**
 * The manual contact log (RET-05, table customer_contacts, DDL supabase/customer_contacts.sql): a DM, SMS, call,
 * hand-sent email or other contact a team member logs against a website customer. Pure: the session, the insert and
 * the delete are injected, so the rules below are unit-tested (test/customer-contacts.test.ts) and the server action
 * (src/customer-contacts-actions.ts) and the read seam (src/customer-contacts-data.ts) only wire them.
 *
 * Nothing here sends anything: this records that a person reached out by hand, it never reaches out.
 */
import {fetchAllRows, type MakePage} from './pos-fetch-paginate';
import {isMissingTable, type DbError} from './supabase-errors';

/**
 * In the order the Log contact dialog lists them: the most used first. Stage 7B added instagram / facebook / viber (the DB
 * check widens with supabase/customer_contacts_channels_7b.sql); 'dm' stays, as "DM (other app)", so older rows stay valid.
 */
export const CONTACT_CHANNELS = ['instagram', 'facebook', 'viber', 'dm', 'sms', 'call', 'email', 'other'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];
export const CHANNEL_LABEL: Readonly<Record<ContactChannel, string>> = Object.freeze({
  instagram: 'Instagram',
  facebook: 'Facebook',
  viber: 'Viber',
  dm: 'DM (other app)',
  sms: 'SMS',
  call: 'Call',
  email: 'Email (by hand)',
  other: 'Other',
});
/** Characters; the table checks the same limit. */
export const CONTACT_NOTE_MAX = 500;

/** One logged contact as the page reads it. */
export type CustomerContact = {id: string; email: string; channel: ContactChannel; note: string | null; contactedAt: string; createdBy: string};

export type ContactResult = {ok: true} | {ok: false; error: string};
export type NewContactRow = {customer_email: string; channel: ContactChannel; note: string | null; created_by: string};

export interface ContactLogDeps {
  /** The signed-in user's lower-cased email, or null with no session. Never taken from the input. */
  actor: () => Promise<string | null>;
  insert: (row: NewContactRow) => Promise<DbError | null>;
  /** Deletes the row with this id ONLY when created_by is `by`; returns how many rows went. */
  deleteOwn: (id: string, by: string) => Promise<{error: DbError | null; deleted: number}>;
}

const NOT_SET_UP = 'The contact log is not set up yet in this environment (supabase/customer_contacts.sql has not been applied). Nothing was saved.';
const SIGN_IN = 'Sign in again to log contacts.';
const CHANNEL_NOT_ENABLED = "This channel isn't enabled in the database yet — run the Stage 7B SQL (supabase/customer_contacts_channels_7b.sql). Nothing was saved.";
/** The pre-7B channel check refused the row (Postgres check_violation 23514 on customer_contacts_channel_check). */
const isOldChannelCheck = (e: DbError): boolean => e.code === '23514' && /customer_contacts_channel_check/.test(e.message);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (error: string): ContactResult => ({ok: false, error});

/** The input of "Log contact", checked in code: a real email, a closed channel, a note of at most 500 characters. */
export function readContactInput(input: unknown): {email: string; channel: ContactChannel; note: string | null} | {error: string} {
  const o = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const email = typeof o.email === 'string' ? o.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email) || email.length > 254) return {error: 'This customer has no valid email address to log a contact against.'};
  if (!(CONTACT_CHANNELS as readonly unknown[]).includes(o.channel)) return {error: `Pick a channel: ${CONTACT_CHANNELS.join(', ')}.`};
  if (o.note !== undefined && o.note !== null && typeof o.note !== 'string') return {error: 'The note must be text.'};
  const note = typeof o.note === 'string' ? o.note.trim() : '';
  if (note.length > CONTACT_NOTE_MAX) return {error: `Keep the note to ${CONTACT_NOTE_MAX} characters.`};
  return {email, channel: o.channel as ContactChannel, note: note || null};
}

export async function logContactWith(deps: ContactLogDeps, input: unknown): Promise<ContactResult> {
  const v = readContactInput(input);
  if ('error' in v) return fail(v.error);
  const by = await deps.actor();
  if (!by) return fail(SIGN_IN);
  const error = await deps.insert({customer_email: v.email, channel: v.channel, note: v.note, created_by: by});
  if (!error) return {ok: true};
  if (isMissingTable(error)) return fail(NOT_SET_UP);
  if (isOldChannelCheck(error)) return fail(CHANNEL_NOT_ENABLED);
  console.warn(`customer_contacts insert failed: ${error.code ?? ''} ${error.message}`);
  return fail('Saving the contact failed. Nothing was saved; try again.');
}

/** Delete-own: the delete is filtered by id AND the caller's email, so another person's row matches nothing and stays. */
export async function deleteContactWith(deps: ContactLogDeps, id: unknown): Promise<ContactResult> {
  if (typeof id !== 'string' || !UUID.test(id)) return fail('That contact could not be found.');
  const by = await deps.actor();
  if (!by) return fail(SIGN_IN);
  const {error, deleted} = await deps.deleteOwn(id, by);
  if (error) {
    if (isMissingTable(error)) return fail(NOT_SET_UP.replace('Nothing was saved.', 'Nothing was deleted.'));
    console.warn(`customer_contacts delete failed: ${error.code ?? ''} ${error.message}`);
    return fail('Deleting the contact failed; try again.');
  }
  return deleted > 0 ? {ok: true} : fail('You can only delete a contact you logged (or it is already gone).');
}

/**
 * Every logged contact, newest first, paged (PostgREST caps a response at 1000 rows). Null when the table is not applied
 * or the read failed: the page and Ask Coop then say "unavailable", never 0.
 */
export async function loadContactRows(makePage: MakePage): Promise<CustomerContact[] | null> {
  let lastError: DbError | null = null;
  try {
    const rows = await fetchAllRows('customer_contacts', async (from, to) => {
      const r = await makePage(from, to);
      if (r.error) lastError = r.error;
      return r;
    });
    return rows.map((r) => ({
      id: String(r.id),
      email: String(r.customer_email ?? '').trim().toLowerCase(),
      channel: r.channel as ContactChannel,
      note: (r.note as string | null) ?? null,
      contactedAt: String(r.contacted_at),
      createdBy: String(r.created_by),
    }));
  } catch (e) {
    if (!isMissingTable(lastError)) console.warn(`customer_contacts read failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
