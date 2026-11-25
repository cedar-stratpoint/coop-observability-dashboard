import type {CustomerContact} from './customer-contacts';
import type {CustomerLink} from './customer-links';
import {fmtPh, fmtPhDate} from './crm-compute';
import {leadKey} from './lead-order-match';
import type {SpinVoucherInfo} from './spin-voucher';
import {contactStatus, type ContactState, type ContactStatus, type LogRead, type Person} from './person-identity';

/** One spin-the-wheel booth lead, as the event card consumes it. */
export interface SpinLead {
  email: string | null; // null when the lead gave an Instagram handle instead
  instagram: string | null; // handle without the "@" (Sep 27 event onwards)
  name: string | null; // full name (late Oct 2026 events onwards)
  pet: string | null; // e.g. "Mimi / Puspin" (Sep 27 event onwards)
  picky: string | null; // "Yes" / "No": is the pet a picky eater (Oct 2026 events, until the full name replaced it)
  mobile: string | null;
  prize: string;
  campaign: string | null; // the storefront admin's event slug, e.g. "modern-market-sept2026"
  collectedAt: string; // ISO instant
  consentAt?: string | null; // when the FIRST sign-up of this contact gave consent (Shopify); never updated, so it says nothing about a later unsubscribe
}

/** Leads collected on any of an event's days (Manila). */
export function leadsInDays(leads: SpinLead[], days: string[], dayKey: (iso: string) => string): SpinLead[] {
  if (days.length === 0) return [];
  const set = new Set(days);
  return leads.filter((l) => set.has(dayKey(l.collectedAt)));
}

/** Prize tally, biggest first. */
export function prizeTally(leads: SpinLead[]): {prize: string; count: number}[] {
  const m = new Map<string, number>();
  for (const l of leads) m.set(l.prize, (m.get(l.prize) ?? 0) + 1);
  return [...m].map(([prize, count]) => ({prize, count})).sort((a, b) => b.count - a.count || a.prize.localeCompare(b.prize));
}

/**
 * Free-text lead search: name, email, Instagram handle, pet or mobile contain
 * the query (case-insensitive). A leading "@" is ignored so "@mimi" finds the
 * handle, and a number matches the mobile with spaces/dashes ignored.
 */
export function matchesLeadSearch(l: SpinLead, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^@/, '');
  if (!q) return true;
  if ([l.name, l.email, l.instagram, l.pet, l.mobile].some((v) => v?.toLowerCase().includes(q))) return true;
  const digits = q.replace(/\D/g, '');
  return digits.length >= 3 && digits.length === q.replace(/[\s()+-]/g, '').length && (l.mobile ?? '').replace(/\D/g, '').includes(digits);
}

/** A PH day key (YYYY-MM-DD) inside an inclusive From–To range; 'all' on either end leaves that side open. Keys compare as text. */
export function inDayRange(day: string, from: string, to: string): boolean {
  return (from === 'all' || day >= from) && (to === 'all' || day <= to);
}

/**
 * RET-17 Task 4: each lead's contact status from the manual log (src/person-identity.ts), keyed by leadKey. Pass the `legacy` flag
 * from getCustomerContactLog(): on the legacy log a lead without an email is 'unknown', never 'not_contacted'.
 */
export function leadStatuses(leads: readonly SpinLead[], contacts: readonly CustomerContact[] | null, links: readonly CustomerLink[], read: LogRead = {}): Record<string, ContactStatus> {
  const out: Record<string, ContactStatus> = {};
  for (const l of leads) out[leadKey(l)] = contactStatus(leadPerson(l), contacts, links, read);
  return out;
}

/** A lead as a person: the keys it gave at the booth. */
export const leadPerson = (l: SpinLead): Person => ({email: l.email, instagram: l.instagram, mobile: l.mobile});

export type StatusCounts = Record<ContactState, number>;
/** How many leads are in each status, from statuses already computed (a lead missing from `statuses` counts as unknown). */
export function countStates(leads: readonly SpinLead[], statuses: Readonly<Record<string, ContactStatus>>): StatusCounts {
  const c: StatusCounts = {not_contacted: 0, contacted: 0, replied: 0, unknown: 0};
  for (const l of leads) c[statuses[leadKey(l)]?.state ?? 'unknown']++;
  return c;
}

export type StatusFilter = ContactState | 'all';
/** The leads in one status, from statuses already computed; 'all' keeps every lead. */
export function withState<T extends SpinLead>(leads: readonly T[], status: StatusFilter, statuses: Readonly<Record<string, ContactStatus>>): T[] {
  return status === 'all' ? [...leads] : leads.filter((l) => (statuses[leadKey(l)]?.state ?? 'unknown') === status);
}

/** Counts per status straight from the log. */
export const leadStatusCounts = (leads: readonly SpinLead[], contacts: readonly CustomerContact[] | null, links: readonly CustomerLink[], read: LogRead = {}): StatusCounts =>
  countStates(leads, leadStatuses(leads, contacts, links, read));

/** The leads in one status straight from the log ('not_contacted' never includes an unknown lead). */
export const filterByStatus = (leads: readonly SpinLead[], status: StatusFilter, contacts: readonly CustomerContact[] | null, links: readonly CustomerLink[], read: LogRead = {}): SpinLead[] =>
  withState(leads, status, leadStatuses(leads, contacts, links, read));

/** "Nov 21": a PH day without the year, for the status chip. */
const phDayShort = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', {timeZone: 'Asia/Manila', month: 'short', day: 'numeric'});

/** The chip text: "Not contacted", "Contacted · Nov 20", "Replied · Nov 21" or "Unknown". */
export function contactStatusLabel(s: ContactStatus): string {
  if (s.state === 'unknown') return 'Unknown';
  if (s.state === 'not_contacted') return 'Not contacted';
  const word = s.state === 'replied' ? 'Replied' : 'Contacted';
  return s.lastAt && Number.isFinite(Date.parse(s.lastAt)) ? `${word} · ${phDayShort(s.lastAt)}` : word;
}

/** The Event leads CSV: status first (status, last contacted, replied), then the lead, then the website order since the spin. */
export function leadsCsv(
  leads: readonly SpinLead[],
  statuses: Readonly<Record<string, ContactStatus>>,
  vouchers: Readonly<Record<string, SpinVoucherInfo>>,
  asOf: string,
): string[][] {
  const head = ['Status', 'Last contacted', 'Replied', 'Name', 'Instagram', 'Email', 'Mobile', 'Pet', 'Prize', 'Event', 'Collected (PH)', 'Website order since spin'];
  const body = leads.map((l) => {
    const s = statuses[leadKey(l)] ?? {state: 'unknown' as const, lastAt: null, lastChannel: null};
    const known = s.state !== 'unknown';
    const v = vouchers[leadKey(l)]?.state ?? null;
    return [
      s.state === 'unknown' ? 'Unknown' : s.state === 'not_contacted' ? 'Not contacted' : s.state === 'replied' ? 'Replied' : 'Contacted',
      !known ? 'Unknown' : s.lastAt ? fmtPhDate(s.lastAt) : 'Never',
      !known ? 'Unknown' : s.state === 'replied' ? 'Yes' : 'No',
      l.name ?? '',
      l.instagram ? `@${l.instagram}` : '',
      l.email ?? '',
      l.mobile ?? '',
      l.pet ?? '',
      l.prize,
      l.campaign ?? '',
      fmtPh(l.collectedAt),
      v === 'ordered' ? fmtPhDate(vouchers[leadKey(l)]?.orderAt) : v === 'not_used' ? 'No' : v === 'no_email' ? 'No email' : 'Unknown',
    ];
  });
  return [[`Event leads, as of ${fmtPh(asOf)}`], head, ...body];
}
