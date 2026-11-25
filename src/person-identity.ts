/**
 * One person across the Event leads page, the Website CRM and Ask Coop (RET-17, plan
 * knowledge/tasks/2026-11-25-ret17-implementation-plan.md, D3), and their contact status from the manual log (D1, D2). Pure.
 *
 * Two records are the same person when they share an email, an Instagram handle, a saved Same person link (src/customer-links.ts),
 * or a mobile; a mobile only when the two records do not carry DIFFERENT emails (one household phone, two people). Keys are
 * compared the way they are stored: emailKey, igHandle (no "@", lower case), phoneKey (last 10 digits).
 */
import {emailKey} from './contacts-merge';
import {loggableKeys, type ContactChannel, type CustomerContact} from './customer-contacts';
import type {CustomerLink} from './customer-links';

export type Person = {email: string | null; instagram: string | null; mobile: string | null};

type Keys = {email: string | null; instagram: string | null; mobile: string | null};
/** A key a contact could not be logged against (an invalid email or handle, a short mobile) is not a key here either. */
const keysOf = (p: Person): Keys => loggableKeys(p);

/** Direct match on the records' own keys. */
function sameKeys(a: Keys, b: Keys): boolean {
  if (a.email && a.email === b.email) return true;
  if (a.instagram && a.instagram === b.instagram) return true;
  // One mobile, two different emails or two different Instagram handles = two people sharing a phone (Review Focus 2): not joined.
  return (
    a.mobile !== null &&
    a.mobile === b.mobile &&
    !(a.email && b.email && a.email !== b.email) &&
    !(a.instagram && b.instagram && a.instagram !== b.instagram)
  );
}

/** `customer` is the link's customer, and `lead` carries one of the link's lead keys. */
function linkedBy(link: CustomerLink, customer: Keys, lead: Keys): boolean {
  if (!customer.email || customer.email !== emailKey(link.customerEmail)) return false;
  return sameKeys(lead, keysOf({email: link.leadEmail, instagram: link.leadInstagram, mobile: link.leadMobile}));
}

export function samePerson(a: Person, b: Person, links: readonly CustomerLink[]): boolean {
  const ka = keysOf(a);
  const kb = keysOf(b);
  return sameKeys(ka, kb) || links.some((l) => linkedBy(l, ka, kb) || linkedBy(l, kb, ka));
}

/**
 * A logged contact belongs to this person: {@link samePerson}, except that a contact keyed ONLY by a mobile never joins a
 * person who has an email by that mobile alone (one household phone: it would attach to every emailed person on it). It
 * still joins a person without an email, or a customer a saved Same person link ties that mobile to.
 */
function isTheirs(p: Person, c: CustomerContact, links: readonly CustomerLink[]): boolean {
  const kp = keysOf(p);
  const kc = keysOf(c);
  if (kc.mobile && !kc.email && !kc.instagram && kp.email) return links.some((l) => linkedBy(l, kp, kc));
  return samePerson(p, c, links);
}

/** How the log was read: `legacy` = before supabase/customer_contacts_lead_keys.sql (no Instagram / mobile / replied columns). */
export type LogRead = {legacy?: boolean};

/**
 * The logged contacts of this person, in the log's order (newest first). Null when the log could not be read, or when it was
 * read without the Instagram / mobile columns (legacy) and the person has no email: their contacts cannot be seen.
 */
export function contactsOf(p: Person, contacts: readonly CustomerContact[] | null, links: readonly CustomerLink[], read: LogRead = {}): CustomerContact[] | null {
  if (contacts === null) return null;
  if (read.legacy && !keysOf(p).email) return null;
  return contacts.filter((c) => isTheirs(p, c, links));
}

export type ContactState = 'not_contacted' | 'contacted' | 'replied' | 'unknown';
export type ContactStatus = {state: ContactState; lastAt: string | null; lastChannel: ContactChannel | null};

const UNKNOWN: ContactStatus = {state: 'unknown', lastAt: null, lastChannel: null};

/**
 * Contacted = a contact the team logged (D1; automated CRM emails never count here). Replied = any of them has replied (D2).
 * Unknown is never "never": an unreadable log, or a person with no email, Instagram or mobile, is 'unknown', not 'not_contacted'.
 */
export function contactStatus(p: Person, contacts: readonly CustomerContact[] | null, links: readonly CustomerLink[], read: LogRead = {}): ContactStatus {
  const k = keysOf(p);
  if (!k.email && !k.instagram && !k.mobile) return UNKNOWN;
  const mine = contactsOf(p, contacts, links, read);
  if (mine === null) return UNKNOWN;
  if (mine.length === 0) return {state: 'not_contacted', lastAt: null, lastChannel: null};
  // The newest contact with a readable time; an unparseable contactedAt still counts as a contact but never as "last".
  let last: CustomerContact | null = null;
  for (const c of mine) if (Number.isFinite(Date.parse(c.contactedAt)) && (!last || Date.parse(c.contactedAt) > Date.parse(last.contactedAt))) last = c;
  return {state: mine.some((c) => c.replied) ? 'replied' : 'contacted', lastAt: last?.contactedAt ?? null, lastChannel: last?.channel ?? null};
}
