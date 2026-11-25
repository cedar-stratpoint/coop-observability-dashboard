/**
 * The manual contact log (RET-05, table customer_contacts, DDL supabase/customer_contacts.sql): a DM, SMS, call,
 * hand-sent email or other contact a team member logs against a website customer, or (RET-17,
 * supabase/customer_contacts_lead_keys.sql) against an event lead by Instagram handle or mobile, with "they replied". Pure: the session, the insert and
 * the delete are injected, so the rules below are unit-tested (test/customer-contacts.test.ts) and the server action
 * (src/customer-contacts-actions.ts) and the read seam (src/customer-contacts-data.ts) only wire them.
 *
 * Nothing here sends anything: this records that a person reached out by hand, it never reaches out.
 */
import {emailKey, phoneKey} from './contacts-merge';
import {igHandle} from './customer-links';
import {fetchAllRows, type MakePage} from './pos-fetch-paginate';
import {manilaDayKey} from './pos-sales-compute';
import {isMissingColumn, isMissingTable, type DbError} from './supabase-errors';

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

/**
 * One logged contact as the page reads it. At least one of email / instagram / mobile is set (RET-17): instagram as igHandle
 * (no "@", lower case), mobile as phoneKey (last 10 digits). `replied` = the person answered (D2).
 */
export type CustomerContact = {
  id: string;
  email: string | null;
  instagram: string | null;
  mobile: string | null;
  channel: ContactChannel;
  note: string | null;
  replied: boolean;
  contactedAt: string;
  createdBy: string;
};

export type ContactResult = {ok: true} | {ok: false; error: string};
/**
 * The row written. The RET-17 columns are present only when used, so an email-only contact is exactly the pre-RET-17 row
 * and keeps working on a database where supabase/customer_contacts_lead_keys.sql has not been applied yet.
 */
export type NewContactRow = {
  customer_email: string | null;
  contact_instagram?: string;
  contact_mobile?: string;
  replied?: true;
  /** Only for a past day ("When"); otherwise the database's now(). */
  contacted_at?: string;
  channel: ContactChannel;
  note: string | null;
  created_by: string;
};
export type ContactInput = {
  email: string | null;
  instagram: string | null;
  mobile: string | null;
  channel: ContactChannel;
  note: string | null;
  replied: boolean;
  /** Set only when the "When" day is before today (PH): noon PH that day. Absent = now. */
  contactedAt?: string;
};

export interface ContactLogDeps {
  /** The signed-in user's lower-cased email, or null with no session. Never taken from the input. */
  actor: () => Promise<string | null>;
  insert: (row: NewContactRow) => Promise<DbError | null>;
  /** Deletes the row with this id ONLY when created_by is `by`; returns how many rows went. */
  deleteOwn: (id: string, by: string) => Promise<{error: DbError | null; deleted: number}>;
}

const NOT_SET_UP = 'The contact log is not set up yet in this environment (supabase/customer_contacts.sql has not been applied). Nothing was saved.';
const SIGN_IN = 'Sign in again to log contacts.';
const LEAD_KEYS_NOT_SET_UP = 'Logging by Instagram or mobile, and "they replied", is not set up yet in this environment (supabase/customer_contacts_lead_keys.sql has not been applied). Nothing was saved.';
const CHANNEL_NOT_ENABLED = "This channel isn't enabled in the database yet — run the Stage 7B SQL (supabase/customer_contacts_channels_7b.sql). Nothing was saved.";
/** The pre-7B channel check refused the row (Postgres check_violation 23514 on customer_contacts_channel_check). */
const isOldChannelCheck = (e: DbError): boolean => e.code === '23514' && /customer_contacts_channel_check/.test(e.message);
/** The pre-RET-17 NOT NULL on customer_email refused a row without an email (Postgres not_null_violation 23502). */
const isOldEmailNotNull = (e: DbError): boolean => e.code === '23502' && /customer_email/.test(e.message);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HANDLE = /^[a-z0-9._]{1,30}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (error: string): ContactResult => ({ok: false, error});

/**
 * "When" (owner 2026-11-25: editable last contacted): a PH day 'YYYY-MM-DD', not after today in Manila. Today = undefined (the
 * database stamps now(), so the order of today's contacts holds); a past day = noon PH that day, which reads back as that PH day.
 */
function readContactedAt(raw: unknown, now: Date): {at?: string} | {error: string} {
  if (raw === undefined || raw === null || raw === '') return {};
  const m = typeof raw === 'string' ? DAY.exec(raw.trim()) : null;
  const day = m ? `${m[1]}-${m[2]}-${m[3]}` : '';
  // Round-trip through UTC to refuse days that do not exist (2026-02-30 would roll over to Mar 2).
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!m || !Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== day) return {error: 'The date is not valid (use a day like 2026-11-20).'};
  const today = manilaDayKey(now.toISOString());
  if (day > today) return {error: 'The date cannot be in the future.'};
  return day === today ? {} : {at: `${day}T12:00:00+08:00`};
}

/**
 * The input of "Log contact", checked in code: at least one of a real email, an Instagram handle or a mobile (each given one
 * must be valid), a closed channel, a note of at most 500 characters, an optional boolean `replied` and an optional "When" day.
 */
export function readContactInput(input: unknown, now: Date = new Date()): ContactInput | {error: string} {
  const o = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const emailRaw = str(o.email);
  const email = emailRaw ? emailKey(emailRaw) : null;
  if (emailRaw && (!email || !EMAIL.test(email) || email.length > 254)) return {error: 'The email address is not valid.'};
  const igRaw = str(o.instagram);
  const instagram = igRaw ? igHandle(igRaw) : null;
  if (igRaw && (!instagram || !HANDLE.test(instagram))) return {error: 'The Instagram handle is not valid.'};
  const mobileRaw = str(o.mobile);
  const mobile = mobileRaw ? phoneKey(mobileRaw) : null;
  if (mobileRaw && !mobile) return {error: 'The mobile number is not valid.'};
  if (!email && !instagram && !mobile) return {error: 'This person has no email, Instagram or mobile to log a contact against.'};
  if (!(CONTACT_CHANNELS as readonly unknown[]).includes(o.channel)) return {error: `Pick a channel: ${CONTACT_CHANNELS.join(', ')}.`};
  if (o.note !== undefined && o.note !== null && typeof o.note !== 'string') return {error: 'The note must be text.'};
  const note = typeof o.note === 'string' ? o.note.trim() : '';
  if (note.length > CONTACT_NOTE_MAX) return {error: `Keep the note to ${CONTACT_NOTE_MAX} characters.`};
  if (o.replied !== undefined && o.replied !== null && typeof o.replied !== 'boolean') return {error: '"They replied" must be yes or no.'};
  const when = readContactedAt(o.contactedAt, now);
  if ('error' in when) return when;
  return {email, instagram, mobile, channel: o.channel as ContactChannel, note: note || null, replied: o.replied === true, ...(when.at ? {contactedAt: when.at} : {})};
}

export async function logContactWith(deps: ContactLogDeps, input: unknown, now: Date = new Date()): Promise<ContactResult> {
  const v = readContactInput(input, now);
  if ('error' in v) return fail(v.error);
  const by = await deps.actor();
  if (!by) return fail(SIGN_IN);
  const error = await deps.insert({
    customer_email: v.email,
    ...(v.instagram ? {contact_instagram: v.instagram} : {}),
    ...(v.mobile ? {contact_mobile: v.mobile} : {}),
    ...(v.replied ? {replied: true as const} : {}),
    ...(v.contactedAt ? {contacted_at: v.contactedAt} : {}),
    channel: v.channel,
    note: v.note,
    created_by: by,
  });
  if (!error) return {ok: true};
  if (isMissingTable(error)) return fail(NOT_SET_UP);
  if (isMissingColumn(error) || isOldEmailNotNull(error)) return fail(LEAD_KEYS_NOT_SET_UP);
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
      email: emailKey(r.customer_email as string | null),
      instagram: igHandle(r.contact_instagram as string | null),
      mobile: phoneKey(r.contact_mobile as string | null),
      channel: r.channel as ContactChannel,
      note: (r.note as string | null) ?? null,
      replied: r.replied === true,
      contactedAt: String(r.contacted_at),
      createdBy: String(r.created_by),
    }));
  } catch (e) {
    if (!isMissingTable(lastError)) console.warn(`customer_contacts read failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * The read before and after supabase/customer_contacts_lead_keys.sql: page with `primary` (the RET-17 select); when the
 * database answers "column does not exist" (42703 / PGRST204), switch to `legacy` (the old select) for this and every later
 * page, so the page still loads and the new fields read null / false. Any other error passes through (the read is unknown).
 */
export function withColumnFallback(primary: MakePage, legacy: MakePage, onFallback: () => void = () => {}): MakePage {
  let useLegacy = false;
  return async (from, to) => {
    if (useLegacy) return legacy(from, to);
    const r = await primary(from, to);
    if (r.error && isMissingColumn(r.error)) {
      useLegacy = true;
      onFallback();
      return legacy(from, to);
    }
    return r;
  };
}

/**
 * The log and how it was read. `legacy` = the RET-17 columns are not there yet (read with the old select): contacts keyed by
 * Instagram or mobile cannot exist or be seen, so a person without an email has an UNKNOWN status, never "not contacted"
 * (see contactStatus in src/person-identity.ts).
 */
export type ContactLog = {rows: CustomerContact[]; legacy: boolean};

/** {@link loadContactRows} through {@link withColumnFallback}, saying whether the legacy select was used. Null = unreadable. */
export async function loadContactLog(primary: MakePage, legacy: MakePage): Promise<ContactLog | null> {
  let usedLegacy = false;
  const rows = await loadContactRows(withColumnFallback(primary, legacy, () => (usedLegacy = true)));
  return rows === null ? null : {rows, legacy: usedLegacy};
}
