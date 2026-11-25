/**
 * "Same person" links (RET-15 Slice B, table customer_links, DDL supabase/customer_links.sql): an owner-approved link between a
 * website customer and a booth lead that adds Instagram and Booth metadata beside the customer on the Website CRM table. It is
 * NOT a merge: the customer keeps their own name, email, orders, spend and vouchers, so no count, cohort or repeat rate moves.
 * Pure: the session, insert and delete are injected, so the rules are unit-tested (test/customer-links.test.ts) and the server
 * action (src/customer-links-actions.ts) and read seam (src/customer-links-data.ts) only wire them.
 *
 * Two ways a lead shows beside a customer: 'exact' (same email, or same mobile by its last 10 digits; no link needed) and
 * 'linked' (a saved link). Exact wins over linked.
 */
import {emailKey, phoneKey} from './contacts-merge';
import {fetchAllRows, type MakePage} from './pos-fetch-paginate';
import type {SpinLead} from './spin-leads-types';
import {isMissingTable, type DbError} from './supabase-errors';

/** One saved link as the page reads it. */
export type CustomerLink = {
  id: string;
  customerEmail: string;
  leadEmail: string | null;
  leadMobile: string | null;
  leadInstagram: string | null;
  leadCampaign: string | null;
  createdBy: string;
};

export type BoothInfo = {campaign: string | null; prize: string | null; pet: string | null};
export type CustomerBooth = {
  instagram: string | null;
  booth: BoothInfo[];
  source: 'exact' | 'linked';
  /** Saved links behind a 'linked' source (empty for 'exact'); the UI offers Unlink on one the viewer created. */
  links: {id: string; createdBy: string}[];
  linkId?: string;
};

/** An Instagram handle as stored and compared: no "@", lower-case. */
export function igHandle(raw: string | null | undefined): string | null {
  return String(raw ?? '').trim().replace(/^@/, '').toLowerCase() || null;
}

const keep = (s: string | null | undefined): string | null => (s ?? '').trim() || null;

/**
 * The extra metadata per website customer (keyed by lower-cased email). `customers` need an email and may carry a phone.
 * A customer with no exact lead and no link is absent from the map; the caller shows "—" for them only when both inputs were
 * read, and "unknown" otherwise (see {@link boothCell}).
 */
export function customerBoothMap(
  customers: readonly {email: string | null; phone?: string | null}[],
  leads: readonly SpinLead[],
  links: readonly CustomerLink[],
): Map<string, CustomerBooth> {
  const byEmail = new Map<string, SpinLead[]>();
  const byPhone = new Map<string, SpinLead[]>();
  const byIg = new Map<string, SpinLead[]>();
  const push = (m: Map<string, SpinLead[]>, k: string | null, l: SpinLead) => k && m.set(k, [...(m.get(k) ?? []), l]);
  for (const l of leads) {
    push(byEmail, emailKey(l.email), l);
    push(byPhone, phoneKey(l.mobile), l);
    push(byIg, igHandle(l.instagram), l);
  }
  const linksByCustomer = new Map<string, CustomerLink[]>();
  for (const k of links) linksByCustomer.set(k.customerEmail, [...(linksByCustomer.get(k.customerEmail) ?? []), k]);

  const out = new Map<string, CustomerBooth>();
  for (const c of customers) {
    const email = emailKey(c.email);
    if (!email || out.has(email)) continue;
    const exact = new Set<SpinLead>([...(byEmail.get(email) ?? []), ...(byPhone.get(phoneKey(c.phone) ?? '') ?? [])]);
    const mine = linksByCustomer.get(email) ?? [];
    let found: Set<SpinLead> = exact;
    let source: CustomerBooth['source'] = 'exact';
    if (exact.size === 0) {
      found = new Set();
      for (const k of mine) {
        for (const l of [...(byEmail.get(emailKey(k.leadEmail) ?? '') ?? []), ...(byPhone.get(phoneKey(k.leadMobile) ?? '') ?? []), ...(byIg.get(igHandle(k.leadInstagram) ?? '') ?? [])]) found.add(l);
      }
      source = 'linked';
    }
    if (found.size === 0) continue;
    const list = [...found];
    out.set(email, {
      instagram: list.map((l) => igHandle(l.instagram)).find((h) => h !== null) ?? null,
      booth: list.map((l) => ({campaign: keep(l.campaign), prize: keep(l.prize), pet: keep(l.pet)})),
      source,
      links: source === 'linked' ? mine.map((k) => ({id: k.id, createdBy: k.createdBy})) : [],
      ...(source === 'linked' && mine[0] ? {linkId: mine[0].id} : {}),
    });
  }
  return out;
}

/** One chip's text: "campaign · prize · pet", leaving out what the lead did not give. */
export const boothText = (b: BoothInfo): string => [b.campaign, b.prize, b.pet].filter(Boolean).join(' · ');

/**
 * What the Instagram / Booth cell of one customer says. Unknown is never "never": when the leads or the links could not be
 * read, a customer with nothing found reads "unknown", not "—". (Exact matches need only the leads, so they still show.)
 */
export function boothCell(found: CustomerBooth | undefined, read: {leads: boolean; links: boolean}): 'unknown' | 'none' | CustomerBooth {
  if (found) return found;
  return read.leads && read.links ? 'none' : 'unknown';
}

export type LinkResult = {ok: true} | {ok: false; error: string};
export type NewLinkRow = {customer_email: string; lead_email: string | null; lead_mobile: string | null; lead_instagram: string | null; lead_campaign: string | null; created_by: string};

export interface LinkDeps {
  /** The signed-in user's lower-cased email, or null with no session. Never taken from the input. */
  actor: () => Promise<string | null>;
  insert: (row: NewLinkRow) => Promise<DbError | null>;
  /** Deletes the row with this id ONLY when created_by is `by`; returns how many rows went. */
  deleteOwn: (id: string, by: string) => Promise<{error: DbError | null; deleted: number}>;
}

const NOT_SET_UP = 'Same-person links are not set up yet in this environment (supabase/customer_links.sql has not been applied). Nothing was saved.';
const SIGN_IN = 'Sign in again to link people.';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HANDLE = /^[a-z0-9._]{1,30}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (error: string): LinkResult => ({ok: false, error});

/** The input of "Same person", checked in code: a real customer email and at least one lead identity (email, mobile or Instagram). */
export function readLinkInput(input: unknown): Omit<NewLinkRow, 'created_by'> | {error: string} {
  const o = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const customer = str(o.customerEmail).toLowerCase();
  if (!EMAIL.test(customer) || customer.length > 254) return {error: 'This customer has no valid email address to link against.'};
  const leadEmailRaw = str(o.leadEmail);
  const leadEmail = leadEmailRaw ? emailKey(leadEmailRaw) : null;
  if (leadEmailRaw && (!leadEmail || !EMAIL.test(leadEmail) || leadEmail.length > 254)) return {error: 'The lead email is not valid.'};
  const mobileRaw = str(o.leadMobile);
  const leadMobile = mobileRaw ? phoneKey(mobileRaw) : null;
  if (mobileRaw && !leadMobile) return {error: 'The lead mobile is not valid.'};
  const igRaw = str(o.leadInstagram);
  const leadInstagram = igRaw ? igHandle(igRaw) : null;
  if (igRaw && (!leadInstagram || !HANDLE.test(leadInstagram))) return {error: 'The lead Instagram handle is not valid.'};
  if (!leadEmail && !leadMobile && !leadInstagram) return {error: 'The lead has no email, mobile or Instagram to link by.'};
  const campaign = str(o.leadCampaign).slice(0, 120);
  return {customer_email: customer, lead_email: leadEmail, lead_mobile: leadMobile, lead_instagram: leadInstagram, lead_campaign: campaign || null};
}

export async function linkPeopleWith(deps: LinkDeps, input: unknown): Promise<LinkResult> {
  const v = readLinkInput(input);
  if ('error' in v) return fail(v.error);
  const by = await deps.actor();
  if (!by) return fail(SIGN_IN);
  const error = await deps.insert({...v, created_by: by});
  if (!error) return {ok: true};
  if (isMissingTable(error)) return fail(NOT_SET_UP);
  if (error.code === '23505') return {ok: true}; // already linked: the same pair twice is a no-op
  console.warn(`customer_links insert failed: ${error.code ?? ''} ${error.message}`);
  return fail('Saving the link failed. Nothing was saved; try again.');
}

/** Delete-own: filtered by id AND the caller's email, so another person's link matches nothing and stays. */
export async function unlinkPeopleWith(deps: LinkDeps, id: unknown): Promise<LinkResult> {
  if (typeof id !== 'string' || !UUID.test(id)) return fail('That link could not be found.');
  const by = await deps.actor();
  if (!by) return fail(SIGN_IN);
  const {error, deleted} = await deps.deleteOwn(id, by);
  if (error) {
    if (isMissingTable(error)) return fail(NOT_SET_UP.replace('Nothing was saved.', 'Nothing was removed.'));
    console.warn(`customer_links delete failed: ${error.code ?? ''} ${error.message}`);
    return fail('Removing the link failed; try again.');
  }
  return deleted > 0 ? {ok: true} : fail('You can only unlink a link you made (or it is already gone).');
}

/** Every saved link, paged. Null when the table is not applied or the read failed: the page then says "unknown", never "—". */
export async function loadLinkRows(makePage: MakePage): Promise<CustomerLink[] | null> {
  let lastError: DbError | null = null;
  try {
    const rows = await fetchAllRows('customer_links', async (from, to) => {
      const r = await makePage(from, to);
      if (r.error) lastError = r.error;
      return r;
    });
    return rows.map((r) => ({
      id: String(r.id),
      customerEmail: String(r.customer_email ?? '').trim().toLowerCase(),
      leadEmail: (r.lead_email as string | null) ?? null,
      leadMobile: (r.lead_mobile as string | null) ?? null,
      leadInstagram: (r.lead_instagram as string | null) ?? null,
      leadCampaign: (r.lead_campaign as string | null) ?? null,
      createdBy: String(r.created_by),
    }));
  } catch (e) {
    if (!isMissingTable(lastError)) console.warn(`customer_links read failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** The Ask Coop matches table's row fields (src/chat/contacts/match.ts: a_/b_ source, email, mobile, instagram, event). */
type MatchRow = Record<string, string | number | null | undefined>;
export type SamePersonInput = {customerEmail: string; leadEmail: string | null; leadMobile: string | null; leadInstagram: string | null; leadCampaign: string | null};

/**
 * What a matches-table row offers: null when it is not a website-CRM / event-lead pair (no button), 'exact' when the pair already
 * shares an email or mobile (shown automatically, "Already matched"), else the link to save for "Same person". Judged on the
 * row's own fields, not its tier: a name plus Instagram can be "confirmed" without any shared email or mobile.
 */
export function samePersonOffer(row: MatchRow): 'exact' | {link: SamePersonInput} | null {
  const src = (p: 'a' | 'b') => String(row[`${p}_source`] ?? '');
  const [w, l] = src('a') === 'website CRM' && src('b') === 'event leads' ? (['a', 'b'] as const) : src('b') === 'website CRM' && src('a') === 'event leads' ? (['b', 'a'] as const) : [null, null];
  if (!w || !l) return null;
  const str = (k: string): string | null => (typeof row[k] === 'string' && (row[k] as string).trim() ? (row[k] as string).trim() : null);
  const customerEmail = emailKey(str(`${w}_email`));
  if (!customerEmail) return null;
  const leadEmail = emailKey(str(`${l}_email`));
  const leadMobile = phoneKey(str(`${l}_mobile`));
  const leadInstagram = igHandle(str(`${l}_instagram`));
  if (!leadEmail && !leadMobile && !leadInstagram) return null;
  const wPhone = phoneKey(str(`${w}_mobile`));
  if (customerEmail === leadEmail || (wPhone !== null && wPhone === leadMobile)) return 'exact';
  return {link: {customerEmail, leadEmail, leadMobile, leadInstagram, leadCampaign: str(`${l}_event`)}};
}
