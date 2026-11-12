// RET-07 slice 7C (plan knowledge/tasks/2026-11-11-customer-last-contacted-stage7.md): CRM membership emails count as customer
// contacts. The CRM route GET /api/membership-events is new, so the rollout rule is pinned here: a 404 (route not deployed yet) =
// membership emails NOT COUNTED YET (excluded, with a note; the other sources stay known), any other failure = unknown (R3).
import {describe, expect, it} from 'vitest';
import {CrmError, type CrmClient} from '../src/chat/crm/client';
import {createCrmExecutors} from '../src/chat/crm/executors';
import {CRM_TOOLS} from '../src/chat/tool-defs';
import {CONTACT_KIND_LABEL, contactTally, customerRows, customerTimeline, enrichCustomers} from '../src/crm-compute';
import {MEMBERSHIP_EVENTS_NOT_LIVE, projectMembershipEvent, readMembershipEvents} from '../src/crm-project';
import type {CrmCustomer} from '../src/crm-types';
import {fakeCrmClient} from './support/crm-fixtures';

const NOW = new Date('2026-11-12T04:00:00Z');
const RAW_EVENT = {id: 7, email: 'ana@example.com', shopifyCustomerId: 'c1', tier: 'gold', event: 'tier_upgrade', sentAt: '2026-10-30T02:00:00Z'};

describe('7C projectMembershipEvent + readMembershipEvents', () => {
  it('keeps email, tier, event and sentAt only', () => {
    expect(projectMembershipEvent(RAW_EVENT)).toEqual({email: 'ana@example.com', tier: 'gold', event: 'tier_upgrade', sentAt: '2026-10-30T02:00:00Z'});
  });
  it('a list -> live, projected', async () => {
    expect(await readMembershipEvents(async () => ({membershipEvents: [RAW_EVENT]}))).toEqual({live: true, events: [projectMembershipEvent(RAW_EVENT)]});
  });
  it('404 (the route is not deployed yet) -> not live: excluded, not unknown', async () => {
    expect(await readMembershipEvents(async () => Promise.reject(new CrmError('upstream_error', 404)))).toEqual({live: false, events: []});
    expect(await readMembershipEvents(async () => Promise.reject(Object.assign(new Error('CRM 404'), {status: 404})))).toEqual({live: false, events: []});
  });
  it.each([
    ['a 500', () => Promise.reject(new CrmError('upstream_error', 500))],
    ['a 401', () => Promise.reject(new CrmError('upstream_error', 401))],
    ['a network failure', () => Promise.reject(new CrmError('unreachable'))],
    ['a timeout', () => Promise.reject(new CrmError('timeout'))],
    ['a body with no list', async () => ({error: 'nope'})],
  ])('%s -> null = unknown (R3)', async (_what, get) => {
    expect(await readMembershipEvents(get as () => Promise<unknown>)).toBeNull();
  });
});

describe('7C contactTally + customerRows', () => {
  const base = {checkouts: [], orders: [], birthdayVouchers: []};
  it('1 per membership email, in emails_sent (automated) and total, newest dates last contacted', () => {
    const t = contactTally({
      ...base,
      birthdayVouchers: [{email: 'a@x.com', sentAt: '2026-10-01T00:00:00Z'}],
      membershipEvents: [{email: 'A@x.com ', sentAt: '2026-10-09T00:00:00Z'}, {email: 'a@x.com', sentAt: '2026-09-01T00:00:00Z'}],
    });
    expect(t.get('a@x.com')).toMatchObject({membership: 2, birthdayVouchers: 1, automated: 3, total: 3, lastAt: '2026-10-09T00:00:00Z', lastKind: 'membership'});
  });
  it('labelled "Membership email"', () => {
    expect(CONTACT_KIND_LABEL.membership).toBe('Membership email');
  });
  it('acceptance 5: a newer membership email beats an older win-back', () => {
    const t = contactTally({...base, checkouts: [{email: 'a@x.com', remindersSent: 0, winbackSentAt: '2026-10-01T00:00:00Z'}], membershipEvents: [{email: 'a@x.com', sentAt: '2026-10-05T00:00:00Z'}]});
    expect(t.get('a@x.com')).toMatchObject({lastKind: 'membership', lastAt: '2026-10-05T00:00:00Z', winback: 1, membership: 1, automated: 2});
  });

  const cust = (email: string): CrmCustomer => ({
    shopifyCustomerId: email, email, firstName: null, lastName: null, phone: null, ordersCount: null, totalSpent: null, membershipTier: null,
    petName: null, petBirthday: null, emailMarketingState: null, createdAt: null, updatedAt: null,
  });
  it('not live (404): the row stays known, emails_sent excludes membership', () => {
    const enriched = enrichCustomers([cust('a@x.com')], [], '2026-01-01');
    const tally = contactTally({...base, birthdayVouchers: [{email: 'a@x.com', sentAt: '2026-10-01T00:00:00Z'}], membershipEvents: []});
    const [r] = customerRows(enriched, tally, NOW, {automated: true, manual: true});
    expect([r.emailsSent, r.lastContactKind, r.lastContactKnown]).toEqual([1, 'birthday_voucher', true]);
  });
});

describe('7C customerTimeline', () => {
  const C = {shopifyCustomerId: 'c1', email: 'Ana@Example.com', createdAt: null};
  const MEMBER = [{email: 'ana@example.com', tier: 'gold', event: 'tier_upgrade', sentAt: '2026-10-30T02:00:00Z'}, {email: 'ben@example.com', tier: 'silver', event: 'welcome', sentAt: '2026-10-31T02:00:00Z'}];
  const SRC = {orders: [], checkouts: [], birthdayVouchers: [{email: 'ana@example.com', year: 2026, sentAt: '2026-05-01T00:00:00Z'}], manualContacts: [], membershipEvents: MEMBER};
  it('a membership email is an Emails event with its tier and event; only this customer', () => {
    const e = customerTimeline(C, SRC);
    expect(e[0]).toMatchObject({kind: 'membership', group: 'emails', at: '2026-10-30T02:00:00Z', tier: 'gold', membershipEvent: 'tier_upgrade', contact: true, count: 1});
    expect(e.filter((x) => x.kind === 'membership')).toHaveLength(1);
  });
  it('agrees with 7A: newest contact event is last contacted, and the counts sum to times contacted', () => {
    const enriched = enrichCustomers([{...C, firstName: null, lastName: null, phone: null, ordersCount: null, totalSpent: null, membershipTier: null, petName: null, petBirthday: null, emailMarketingState: null, updatedAt: null}], [], '2026-01-01');
    const [row] = customerRows(enriched, contactTally(SRC), NOW, {automated: true, manual: true});
    const contacts = customerTimeline(C, SRC).filter((x) => x.contact);
    expect([contacts[0].at, contacts[0].kind]).toEqual([row.lastContactedAt, row.lastContactKind]);
    expect(contacts.reduce((s, x) => s + x.count, 0)).toBe(row.timesContacted);
  });
});

// ---------- Ask Coop: list_crm_customers ----------
const CUSTOMERS = ['aaa', 'bbb'].map((id) => ({shopifyCustomerId: id, email: `${id}@example.com`, firstName: id, lastName: null, phone: null, membershipTier: null, petName: null, petBirthday: null, emailMarketingState: null, createdAt: '2026-05-01T10:00:00+08:00', updatedAt: null}));
const ORDERS = [{shopifyOrderId: 1, shopifyCustomerId: 'aaa', email: 'aaa@example.com', totalPrice: '500', currency: 'PHP', financialStatus: 'paid', createdAt: '2026-06-01T10:00:00+08:00', lineItems: null}];
const BODIES = {
  customers: {customers: CUSTOMERS},
  orders: {orders: ORDERS},
  membership: {platinumThreshold: 2000, programStart: '2026-07-01'},
  checkouts: {checkouts: []},
  birthdayVouchers: {birthdayVouchers: [{email: 'aaa@example.com', year: 2026, tier: 'gold', code: 'SECRET', sentAt: '2026-05-01T00:00:00Z'}]},
  membershipEvents: {membershipEvents: [{...RAW_EVENT, email: 'aaa@example.com'}]},
};
type Row = Record<string, unknown>;
type R = {rows: Row[]; columns: {key: string}[]; meta: {checks: {status: string; text: string}[]; measures: {key: string; method: string}[]}};

async function run(input: Record<string, unknown>, membershipFail?: CrmError) {
  const f = fakeCrmClient(BODIES as never);
  const client: CrmClient = membershipFail ? {...f.client, get: (id, q, o) => (id === 'membershipEvents' ? Promise.reject(membershipFail) : f.client.get(id, q, o))} : f.client;
  const ex = createCrmExecutors({client, now: NOW, user: 'test@example.com', keep: (r) => r, maxCalls: 99, manualContacts: async () => [], sink: {info: () => undefined, warn: () => undefined, error: () => undefined} as never});
  const r = (await ex.list_crm_customers({joined_from: '', joined_to: '', tier: 'all', buyers: 'all', group_by: 'none', sort: 'newest', limit: 100, offset: 0, ...input})) as R;
  return {r, gets: f.gets, row: (id: string) => r.rows.find((x) => String(x.email).startsWith(id)) as Row};
}

describe('7C Ask Coop', () => {
  it('emails_sent counts membership emails, last contact kind names it, one GET of /api/membership-events', async () => {
    const {row, gets} = await run({});
    expect([row('aaa').emails_sent, row('aaa').last_contact_kind, row('aaa').last_contacted]).toEqual([2, 'Membership email', '2026-10-30']);
    expect(row('bbb').emails_sent).toBe(0);
    expect(gets.filter((g) => g === 'membershipEvents')).toHaveLength(1);
  });
  it('an outreach audience carries the membership_emails column', async () => {
    const {r, row} = await run({audience: 'repeat_promo', buyers: 'buyers', min_orders: 1});
    expect(r.columns.map((c) => c.key)).toContain('membership_emails');
    expect(r.meta.measures.map((m) => m.key)).toContain('membership_emails');
    expect([row('aaa').membership_emails, row('aaa').birthday_vouchers]).toEqual([1, 1]);
  });
  it('an outreach audience while the route is not live: membership_emails is blank (not 0), the other sources stay', async () => {
    const {row} = await run({audience: 'repeat_promo', buyers: 'buyers', min_orders: 1}, new CrmError('upstream_error', 404));
    expect([row('aaa').membership_emails, row('aaa').birthday_vouchers, row('aaa').emails_sent]).toEqual([null, 1, 1]);
  });
  it('the emails_sent method lists the 5 kinds, membership emails included', async () => {
    const {r} = await run({});
    expect(r.meta.measures.find((m) => m.key === 'emails_sent')?.method).toMatch(/reminders \+ winback \+ review_requests \+ birthday_vouchers \+ membership_emails/);
    expect(CRM_TOOLS.find((t) => t.name === 'list_crm_customers')?.description).toMatch(/membership email/);
  });
  it('404 (route not live): emails_sent stays known without membership, with the not-counted-yet note', async () => {
    const {r, row} = await run({}, new CrmError('upstream_error', 404));
    expect([row('aaa').emails_sent, row('aaa').last_contact_kind]).toEqual([1, 'Birthday voucher']);
    expect(r.meta.checks.some((c) => c.text.includes(MEMBERSHIP_EVENTS_NOT_LIVE))).toBe(true);
    expect(r.meta.checks.some((c) => /last_contacted is unknown/.test(c.text))).toBe(false);
  });
  it.each([500, undefined])('any other failure (%s): emails_sent and last contacted are unknown (R3)', async (status) => {
    const {r, row} = await run({}, status ? new CrmError('upstream_error', status) : new CrmError('unreachable'));
    expect([row('aaa').emails_sent, row('aaa').last_contact_kind, row('bbb').emails_sent]).toEqual([null, 'unknown', null]);
    expect(r.meta.checks.some((c) => c.status === 'warn' && /membership emails could not be read/.test(c.text))).toBe(true);
  });
});
