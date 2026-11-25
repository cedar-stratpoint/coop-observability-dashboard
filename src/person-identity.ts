/**
 * One person across the Event leads page, the Website CRM and Ask Coop (RET-17, plan
 * knowledge/tasks/2026-11-25-ret17-implementation-plan.md, D3), and their contact status from the manual log (D1, D2). Pure.
 *
 * Two records are the same person when they share an email, an Instagram handle, a saved Same person link (src/customer-links.ts),
 * or a mobile; a mobile only when the two records do not carry DIFFERENT emails (one household phone, two people). Keys are
 * compared the way they are stored: emailKey, igHandle (no "@", lower case), phoneKey (last 10 digits).
 */
import {emailKey, phoneKey} from './contacts-merge';
import type {ContactChannel, CustomerContact} from './customer-contacts';
import {igHandle, type CustomerLink} from './customer-links';

export type Person = {email: string | null; instagram: string | null; mobile: string | null};

type Keys = {email: string | null; instagram: string | null; mobile: string | null};
const keysOf = (p: Person): Keys => ({email: emailKey(p.email), instagram: igHandle(p.instagram), mobile: phoneKey(p.mobile)});

/** Direct match on the records' own keys. */
function sameKeys(a: Keys, b: Keys): boolean {
  if (a.email && a.email === b.email) return true;
  if (a.instagram && a.instagram === b.instagram) return true;
  // One mobile, two different emails = two people sharing a phone (Review Focus 2): not joined.
  return a.mobile !== null && a.mobile === b.mobile && !(a.email && b.email && a.email !== b.email);
}

/** `customer` is the link's customer, and `lead` carries one of the link's lead keys. */
function linkedBy(link: CustomerLink, customer: Keys, lead: Keys): boolean {
  if (!customer.email || customer.email !== emailKey(link.customerEmail)) return false;
  return sameKeys(lead, {email: emailKey(link.leadEmail), instagram: igHandle(link.leadInstagram), mobile: phoneKey(link.leadMobile)});
}

export function samePerson(a: Person, b: Person, links: readonly CustomerLink[]): boolean {
  const ka = keysOf(a);
  const kb = keysOf(b);
  return sameKeys(ka, kb) || links.some((l) => linkedBy(l, ka, kb) || linkedBy(l, kb, ka));
}

/** The logged contacts of this person, in the log's order (newest first); null when the log could not be read. */
export function contactsOf(p: Person, contacts: readonly CustomerContact[] | null, links: readonly CustomerLink[]): CustomerContact[] | null {
  if (contacts === null) return null;
  return contacts.filter((c) => samePerson(p, c, links));
}

export type ContactState = 'not_contacted' | 'contacted' | 'replied' | 'unknown';
export type ContactStatus = {state: ContactState; lastAt: string | null; lastChannel: ContactChannel | null};

const UNKNOWN: ContactStatus = {state: 'unknown', lastAt: null, lastChannel: null};

/**
 * Contacted = a contact the team logged (D1; automated CRM emails never count here). Replied = any of them has replied (D2).
 * Unknown is never "never": an unreadable log, or a person with no email, Instagram or mobile, is 'unknown', not 'not_contacted'.
 */
export function contactStatus(p: Person, contacts: readonly CustomerContact[] | null, links: readonly CustomerLink[]): ContactStatus {
  const k = keysOf(p);
  if (!k.email && !k.instagram && !k.mobile) return UNKNOWN;
  const mine = contactsOf(p, contacts, links);
  if (mine === null) return UNKNOWN;
  if (mine.length === 0) return {state: 'not_contacted', lastAt: null, lastChannel: null};
  const at = (c: CustomerContact) => Date.parse(c.contactedAt);
  const last = mine.reduce((best, c) => (at(c) > at(best) ? c : best));
  return {state: mine.some((c) => c.replied) ? 'replied' : 'contacted', lastAt: last.contactedAt, lastChannel: last.channel};
}
