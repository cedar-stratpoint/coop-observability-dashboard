// RET-18 P2 (plan knowledge/tasks/2026-11-25-pawsport-data-in-coop.md): what Ask Coop says about a person's team contact status
// (RET-17, src/person-identity.ts) and PawSport (RET-18 P1, src/pawsport.ts). Pure: the facts come through the route's server seam
// (app/api/chat/people-seam.ts), shared by the `contacts` tool and list_crm_customers so both answer the same way.
// Unknown is never "never": an unreadable log reads 'unknown', never 'not_contacted'; an unread or cut-off Shopify list reads
// PawSport 'unknown', never 'no'. Passport details (number, pet) are identity data (D3): only for an allowlisted viewer.
import type {CustomerContact} from '../../customer-contacts';
import type {CustomerLink} from '../../customer-links';
import {pawsportLine, pawsportMatcher, pawsportState, type PawsportBadge, type PawsportRead, type PawsportState} from '../../pawsport';
import {contactsOf, contactStatus, type ContactState, type Person} from '../../person-identity';
import {manilaDayKey} from '../../pos-sales-compute';
import type {MetricRow, ResultColumn} from '../result-types';

/** What the seam reads: the team's contact log (null = unreadable), the Same person links (null = unread) and the PawSport holders. */
export type PeopleFacts = {log: {rows: CustomerContact[]; legacy: boolean} | null; links: CustomerLink[] | null; pawsport: PawsportRead};
export type PeopleFactsRead = () => Promise<PeopleFacts>;

export const CONTACT_STATUSES = ['all', 'not_contacted', 'contacted', 'replied', 'unknown'] as const;
export const HAS_PAWSPORT = ['all', 'yes', 'no', 'unknown'] as const;
export type FactFilter = {contact_status: (typeof CONTACT_STATUSES)[number]; has_pawsport: (typeof HAS_PAWSPORT)[number]; contacted_since: string};
export const NO_FACT_FILTER: FactFilter = {contact_status: 'all', has_pawsport: 'all', contacted_since: ''};
export const factFilterOn = (f: FactFilter): boolean => f.contact_status !== 'all' || f.has_pawsport !== 'all' || f.contacted_since !== '';

/** Every key a person is known by (a merged person can carry several emails and mobiles). */
export type PersonKeys = {emails: readonly (string | null)[]; mobiles: readonly (string | null)[]; instagram: string | null; shopifyCustomerId?: string | null};
export type PawsportYesNo = 'yes' | 'no' | 'unknown';
export type PersonFacts = {state: ContactState; lastAt: string | null; contacts: CustomerContact[] | null; pawsport: PawsportYesNo; badge: PawsportBadge | null};

const YES_NO: Record<PawsportState, PawsportYesNo> = {has: 'yes', none: 'no', unknown: 'unknown'};
const MAX_KEYS = 5;
const uniq = (xs: readonly (string | null)[]): (string | null)[] => {
  const s = [...new Set(xs.filter((x): x is string => typeof x === 'string' && x.trim() !== ''))].slice(0, MAX_KEYS);
  return s.length ? s : [null];
};
/** One Person per email x mobile, so each carries the email when the person has one (the legacy log then still reads them). */
const expand = (k: PersonKeys): Person[] => uniq(k.emails).flatMap((email) => uniq(k.mobiles).map((mobile) => ({email, instagram: k.instagram, mobile})));

const RANK: Record<ContactState, number> = {replied: 3, contacted: 2, not_contacted: 1, unknown: 0};

/** The facts reader for one result. `facts` null = the seam is absent or failed: everything reads unknown. */
export function personFacts(facts: PeopleFacts | null) {
  const match = facts ? pawsportMatcher(facts.pawsport.holders) : null;
  const links = facts?.links ?? [];
  return (k: PersonKeys): PersonFacts => {
    const persons = expand(k);
    const log = facts?.log ?? null;
    const read = {legacy: log?.legacy ?? false};
    const states = persons.map((p) => contactStatus(p, log?.rows ?? null, links, read));
    // Replied beats contacted beats not contacted; "not contacted" only when every key says so (any unknown key keeps it unknown).
    const best = states.reduce((a, b) => (RANK[b.state] > RANK[a.state] ? b : a));
    // Unread Same person links: a contact logged under a linked key could be missed, so "not contacted" cannot be told (unknown);
    // contacted / replied stay, they were seen.
    const unsure = states.some((s) => s.state === 'unknown') || (facts !== null && facts.links === null);
    const state: ContactState = best.state === 'not_contacted' && unsure ? 'unknown' : best.state;
    const lastAt = states.map((s) => s.lastAt).filter((x): x is string => x !== null).sort().pop() ?? null;
    let contacts: CustomerContact[] | null = null;
    if (state !== 'unknown' && log) {
      const seen = new Map<string, CustomerContact>();
      for (const p of persons) for (const c of contactsOf(p, log.rows, links, read) ?? []) seen.set(c.id, c);
      contacts = [...seen.values()];
    }
    if (!facts || !match) return {state, lastAt, contacts, pawsport: 'unknown', badge: null};
    const badge = persons.map((p, i) => match({...p, shopifyCustomerId: i === 0 ? (k.shopifyCustomerId ?? null) : null})).find((b) => b !== null) ?? null;
    return {state, lastAt, contacts, pawsport: YES_NO[pawsportState(badge, facts.pawsport)], badge};
  };
}

/** The filter: unknown matches only "unknown" (never "not contacted" or "no"); contacted_since needs a logged contact on or after that PH day (a replied one with contact_status replied). */
export function keepFacts(f: PersonFacts, filter: FactFilter): boolean {
  // With a contact day, "contacted" includes those who replied (a reply implies a contact); without one it is "contacted, no reply yet".
  const okState = f.state === filter.contact_status || (filter.contacted_since !== '' && filter.contact_status === 'contacted' && f.state === 'replied');
  if (filter.contact_status !== 'all' && !okState) return false;
  if (filter.has_pawsport !== 'all' && f.pawsport !== filter.has_pawsport) return false;
  if (filter.contacted_since) {
    const since = filter.contacted_since;
    return (f.contacts ?? []).some((c) => Number.isFinite(Date.parse(c.contactedAt)) && manilaDayKey(c.contactedAt) >= since && (filter.contact_status !== 'replied' || c.replied));
  }
  return true;
}

/** Reads the three filter keys from an already-defaulted input object. */
export function readFactFilter(o: Record<string, unknown>): FactFilter | {error: string} {
  const cs = o.contact_status ?? 'all';
  const hp = o.has_pawsport ?? 'all';
  const since = o.contacted_since ?? '';
  if (!(CONTACT_STATUSES as readonly unknown[]).includes(cs)) return {error: `contact_status must be one of: ${CONTACT_STATUSES.join(', ')}.`};
  if (!(HAS_PAWSPORT as readonly unknown[]).includes(hp)) return {error: `has_pawsport must be one of: ${HAS_PAWSPORT.join(', ')}.`};
  if (typeof since !== 'string' || (since !== '' && !realDay(since))) return {error: 'contacted_since must be a real PH day YYYY-MM-DD, or "" for no filter.'};
  if (since !== '' && (cs === 'not_contacted' || cs === 'unknown')) return {error: `contacted_since keeps people with a contact logged on or after that day, so it cannot go with contact_status ${cs}. For "not contacted since <day>" use not_contacted_days (list_crm_customers) or drop contacted_since.`};
  return {contact_status: cs as FactFilter['contact_status'], has_pawsport: hp as FactFilter['has_pawsport'], contacted_since: since};
}

const realDay = (d: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/** The filter in words, for a result title or headline: says "replied included" where the filter includes them. */
export function factFilterText(f: FactFilter): string {
  const status = f.contact_status === 'all' ? null : f.contact_status === 'contacted' && f.contacted_since ? 'contacted (replied included)' : f.contact_status.replace('_', ' ');
  return [f.has_pawsport !== 'all' ? `PawSport ${f.has_pawsport}` : null, status, f.contacted_since ? `contacted by the team since ${f.contacted_since}` : null].filter(Boolean).join(', ');
}

/** A PawSport read with its own time budget (chat only): past it, PawSport reads unknown with a note, and the rest of the answer goes on. */
export const PAWSPORT_BUDGET_MS = 12_000;
export const PAWSPORT_SLOW = `PawSport took longer than ${PAWSPORT_BUDGET_MS / 1000} s to read from Shopify, so it is unknown in this answer. Ask again in a minute (the read keeps warming its cache).`;
export function pawsportWithin(read: Promise<PawsportRead>, ms: number = PAWSPORT_BUDGET_MS): Promise<PawsportRead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<PawsportRead>((resolve) => {
    timer = setTimeout(() => resolve({status: 'unavailable', holders: [], warnings: [PAWSPORT_SLOW]}), ms);
  });
  return Promise.race([read.catch((): PawsportRead => ({status: 'unavailable', holders: [], warnings: []})), late]).finally(() => clearTimeout(timer));
}

const col = (key: string, label: string, unit: ResultColumn['unit'] = 'text', role: ResultColumn['role'] = 'category'): ResultColumn => ({key, label, unit, role});
/** The columns every person row gains; pawsport_detail only for an allowlisted viewer (D3). */
export const factColumns = (identity: boolean): ResultColumn[] => [
  col('contact_status', 'Status (team)'),
  col('team_last_contacted', 'Last contacted by the team (PH day)', 'date', 'time'),
  col('replied', 'Replied'),
  col('pawsport', 'PawSport'),
  ...(identity ? [col('pawsport_detail', 'PawSport details')] : []),
];
/** Customer-typed pet text stays one plain line. */
const plain = (s: string): string => s.replace(/[<>{}]/g, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
export function factRow(f: PersonFacts, identity: boolean): MetricRow {
  return {
    contact_status: f.state,
    team_last_contacted: f.lastAt && Number.isFinite(Date.parse(f.lastAt)) ? manilaDayKey(f.lastAt) : null,
    replied: f.state === 'unknown' ? null : f.state === 'replied' ? 'yes' : 'no',
    pawsport: f.pawsport,
    ...(identity ? {pawsport_detail: f.badge ? plain(pawsportLine(f.badge)) : null} : {}),
  };
}

export type FactCounts = Record<`status_${ContactState}` | `pawsport_${PawsportYesNo}`, number>;
export function factCounts(all: readonly PersonFacts[]): FactCounts {
  const c: FactCounts = {status_not_contacted: 0, status_contacted: 0, status_replied: 0, status_unknown: 0, pawsport_yes: 0, pawsport_no: 0, pawsport_unknown: 0};
  for (const f of all) {
    c[`status_${f.state}`] += 1;
    c[`pawsport_${f.pawsport}`] += 1;
  }
  return c;
}

/** The rules said once (tool result notes; the skill topic says them too). */
export const STATUS_RULE =
  'contact_status is the team\'s own log in Coop (a DM, SMS, call, email by hand or other contact a team member logged): not_contacted, contacted, replied (the person answered a logged contact) or unknown. Automated emails (cart reminder, win-back, Leave a review email, birthday voucher, membership email) never count as contacted. unknown means it could not be told: never say "not contacted" or "never" for it. The log keeps no reply time: "replied this week" = a replied contact logged this week (contacted_since).';
export const PAWSPORT_RULE = 'PawSport = Zoomy\'s pet passport (a ZMY26-… number on the Shopify customer, also the raffle entry). pawsport yes / no / unknown: unknown = Shopify could not be read (or the list was cut off) for this person, never "no".';

/** Notes about what could not be read, and the open count of holders (D3: counts are for everyone). */
export function factNotes(facts: PeopleFacts | null): string[] {
  if (!facts) return ['The contact log and PawSport were not read for this chat: contact_status and pawsport are unknown for everyone. Say so; never read unknown as "not contacted" or "no".', STATUS_RULE, PAWSPORT_RULE];
  const out: string[] = [];
  if (!facts.log) out.push('The team\'s contact log could not be read (or is not set up here), so contact_status is unknown for everyone. Say so; never call anyone "not contacted".');
  else if (facts.log.legacy) out.push('The contact log is read without its Instagram / mobile / replied columns (not applied yet): people without an email read unknown, and nobody reads replied.');
  if (facts.log && facts.links === null) out.push('The Same person links could not be read, so nobody can be told "not contacted" (they read unknown); contacted and replied are still shown.');
  if (facts.pawsport.status !== 'ok') out.push(`Shopify could not be read for PawSport, so pawsport is unknown for everyone. Say so; never say someone has none.${facts.pawsport.warnings.includes(PAWSPORT_SLOW) ? ` ${PAWSPORT_SLOW}` : ''}`);
  else {
    out.push(`Shopify has ${facts.pawsport.holders.length} PawSport holders in all${facts.pawsport.incomplete ? ' found so far (the list was cut off, so there may be more: people without a match read unknown)' : ''}.`);
  }
  out.push(STATUS_RULE, PAWSPORT_RULE);
  return out;
}

/** Only what could not be read (no rules, no total): for a "nobody matches" answer, so an empty result is never read as "none". */
export const factCaveats = (facts: PeopleFacts | null): string[] => factNotes(facts).filter((n) => n !== STATUS_RULE && n !== PAWSPORT_RULE && !n.startsWith('Shopify has '));
