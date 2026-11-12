// RET-07 slice 7A (plan knowledge/tasks/2026-11-11-customer-last-contacted-stage7.md): last contacted per customer, on the
// Customers tab and in Ask Coop, from ONE code path (contactTally -> customerRows). Every answer below is written by hand first.
// Owner rules: R1 last contacted = the newest of every contact timestamp + its kind; R2 known and none = "never"; R3 a source
// unread = unknown, never "never"; R4 test-order review requests never count; R5 "haven't talked to longest" = never first, then oldest.
import {describe, expect, it} from 'vitest';
import {createCrmExecutors} from '../src/chat/crm/executors';
import {CUSTOMER_SORTS, readCustomersInput} from '../src/chat/crm/tools';
import {CRM_TOOLS} from '../src/chat/tool-defs';
import {CONTACT_KIND_LABEL, compareLastContacted, compareTimesContacted, contactTally, customerRows, lastContactLabel, type EnrichedCustomer} from '../src/crm-compute';
import {fakeCrmClient} from './support/crm-fixtures';

const NOW = new Date('2026-11-10T04:00:00Z');

describe('7A contactTally: lastAt + lastKind, newest wins across every kind', () => {
  const base = {checkouts: [], orders: [], birthdayVouchers: []};
  it('newest wins across all kinds (reminder, win-back, review request, birthday voucher, manual) and the manual channel is the kind', () => {
    const t = contactTally({
      checkouts: [{email: 'a@x.com', remindersSent: 1, lastReminderAt: '2026-10-01T10:00:00Z', winbackSentAt: '2026-10-02T10:00:00Z'}],
      orders: [{email: 'a@x.com', reviewRequestSentAt: '2026-10-03T10:00:00Z', test: false}],
      birthdayVouchers: [{email: 'a@x.com', sentAt: '2026-10-04T10:00:00Z'}],
      manualContacts: [{email: 'A@x.com ', channel: 'sms', contactedAt: '2026-10-05T10:00:00Z'}, {email: 'a@x.com', channel: 'call', contactedAt: '2026-09-01T10:00:00Z'}],
    });
    expect(t.get('a@x.com')).toMatchObject({lastAt: '2026-10-05T10:00:00Z', lastKind: 'sms', total: 6});
  });
  it.each([
    ['reminder', {checkouts: [{email: 'a@x.com', remindersSent: 2, lastReminderAt: '2026-10-09T00:00:00Z', winbackSentAt: '2026-10-01T00:00:00Z'}]}],
    ['winback', {checkouts: [{email: 'a@x.com', remindersSent: 2, lastReminderAt: '2026-10-01T00:00:00Z', winbackSentAt: '2026-10-09T00:00:00Z'}]}],
    ['review_request', {orders: [{email: 'a@x.com', reviewRequestSentAt: '2026-10-09T00:00:00Z', test: false}]}],
    ['birthday_voucher', {birthdayVouchers: [{email: 'a@x.com', sentAt: '2026-10-09T00:00:00Z'}]}],
  ])('the kind of the newest contact is %s', (kind, part) => {
    expect(contactTally({...base, ...part}).get('a@x.com')).toMatchObject({lastAt: '2026-10-09T00:00:00Z', lastKind: kind});
  });
  it('acceptance 1: a win-back on day 1 and a manual contact on day 5 -> day 5 and the manual channel', () => {
    const t = contactTally({...base, checkouts: [{email: 'a@x.com', remindersSent: 0, winbackSentAt: '2026-10-01T10:00:00Z'}], manualContacts: [{email: 'a@x.com', channel: 'dm', contactedAt: '2026-10-05T10:00:00Z'}]});
    expect(t.get('a@x.com')).toMatchObject({lastAt: '2026-10-05T10:00:00Z', lastKind: 'dm'});
  });
  it('no contact -> no entry (never)', () => {
    expect(contactTally(base).get('a@x.com')).toBeUndefined();
  });
  it('a test-order review request is ignored for the date too (R4)', () => {
    const t = contactTally({...base, orders: [{email: 'a@x.com', reviewRequestSentAt: '2026-10-09T00:00:00Z', test: true}], birthdayVouchers: [{email: 'a@x.com', sentAt: '2026-10-01T00:00:00Z'}]});
    expect(t.get('a@x.com')).toMatchObject({lastAt: '2026-10-01T00:00:00Z', lastKind: 'birthday_voucher', reviewRequests: 0});
  });
  it('an unparseable or missing date is ignored for the date but still counted', () => {
    const t = contactTally({...base, birthdayVouchers: [{email: 'a@x.com', sentAt: 'not a date'}, {email: 'a@x.com', sentAt: ''}], manualContacts: [{email: 'a@x.com', channel: 'call', contactedAt: null}]});
    expect(t.get('a@x.com')).toMatchObject({birthdayVouchers: 2, manual: 1, lastAt: null, lastKind: null});
  });
  it('a reminder timestamp without a sent reminder does not count as a contact', () => {
    const t = contactTally({...base, checkouts: [{email: 'a@x.com', remindersSent: 0, lastReminderAt: '2026-10-09T00:00:00Z', winbackSentAt: null}]});
    expect(t.get('a@x.com')).toBeUndefined();
  });
  it('an unknown manual channel reads as "other", never as an invented kind', () => {
    const t = contactTally({...base, manualContacts: [{email: 'a@x.com', channel: 'tiktok', contactedAt: '2026-10-09T00:00:00Z'}]});
    expect(t.get('a@x.com')?.lastKind).toBe('other');
  });
  it('every kind has a label', () => {
    expect(CONTACT_KIND_LABEL).toMatchObject({reminder: 'Cart reminder', winback: 'Win-back email', review_request: 'Review request', birthday_voucher: 'Birthday voucher', sms: 'SMS'});
  });
});

describe('7A customerRows: last contacted, never vs unknown (R2, R3)', () => {
  const c = (email: string): EnrichedCustomer => ({
    shopifyCustomerId: email, email, firstName: null, lastName: null, phone: null, ordersCount: null, totalSpent: null, membershipTier: null,
    petName: null, petBirthday: null, emailMarketingState: null, createdAt: null, updatedAt: null,
    orderCount: 1, spent: 0, spendYtd: 0, firstOrderAt: null, lastOrderAt: null, firstOrderCode: null,
  });
  const tally = contactTally({checkouts: [], orders: [], birthdayVouchers: [{email: 'mia@x.com', sentAt: '2026-10-04T10:00:00Z'}]});
  it('known: the newest contact and its kind; nobody contacted reads never (null + known)', () => {
    const [mia, noa] = customerRows([c('mia@x.com'), c('noa@x.com')], tally, NOW, {automated: true, manual: true});
    expect([mia.lastContactedAt, mia.lastContactKind, mia.lastContactKnown]).toEqual(['2026-10-04T10:00:00Z', 'birthday_voucher', true]);
    expect([noa.lastContactedAt, noa.lastContactKind, noa.lastContactKnown]).toEqual([null, null, true]);
    expect(lastContactLabel(mia)).toBe('Oct 4, 2026');
    expect(lastContactLabel(noa)).toBe('never');
  });
  it.each([
    ['the contact log', {automated: true, manual: false}],
    ['a CRM list', {automated: false, manual: true}],
  ])('%s unread: unknown for every row, never "never"', (_what, known) => {
    const [mia, noa] = customerRows([c('mia@x.com'), c('noa@x.com')], tally, NOW, known);
    for (const r of [mia, noa]) {
      expect([r.lastContactedAt, r.lastContactKind, r.lastContactKnown]).toEqual([null, null, false]);
      expect(lastContactLabel(r)).toBe('unknown');
    }
  });

  const row = (id: string, at: string | null, known = true, times: number | null = 1) => ({id, lastContactedAt: at, lastContactKnown: known, timesContacted: times});
  it('R5 sort: never first, then the oldest contact, unknown last', () => {
    const rows = [row('new', '2026-10-09T00:00:00Z'), row('unk', null, false), row('nev', null), row('old', '2026-09-01T00:00:00Z')];
    expect([...rows].sort(compareLastContacted).map((r) => r.id)).toEqual(['nev', 'old', 'new', 'unk']);
  });
  it('most contacted first, unknown last', () => {
    const rows = [row('one', null, true, 1), row('unk', null, false, null), row('six', null, true, 6), row('zero', null, true, 0)];
    expect([...rows].sort(compareTimesContacted).map((r) => r.id)).toEqual(['six', 'one', 'zero', 'unk']);
  });
});

// ---------- Ask Coop: list_crm_customers ----------
const cust = (id: string) => ({
  shopifyCustomerId: id, email: `${id}@example.com`, firstName: `F${id}`, lastName: null, phone: null, ordersCount: null, totalSpent: null,
  membershipTier: null, petName: null, petBirthday: null, emailMarketingState: null, createdAt: '2026-05-01T10:00:00+08:00', updatedAt: null,
});
const CUSTOMERS = [cust('aaa'), cust('bbb'), cust('ccc'), cust('ddd')];
// aaa: reminder 2026-10-01 (2 reminders) + a manual SMS 2026-10-20 -> last 10-20 SMS, 3 times. bbb: never. ccc: win-back 2026-09-01 -> oldest, 1 time.
// ddd: a birthday voucher 2026-10-10 -> 1 time.
const CHECKOUTS = [
  {shopifyCheckoutId: 'k1', email: 'aaa@example.com', totalPrice: '1', currency: 'PHP', createdAt: '2026-09-28T10:00:00Z', updatedAt: null, convertedAt: null, remindersSent: 2, lastReminderAt: '2026-10-01T10:00:00Z', reachedPaymentAt: null, winbackSentAt: null, raw: '{}'},
  {shopifyCheckoutId: 'k2', email: 'ccc@example.com', totalPrice: '1', currency: 'PHP', createdAt: '2026-08-28T10:00:00Z', updatedAt: null, convertedAt: null, remindersSent: 0, lastReminderAt: null, reachedPaymentAt: null, winbackSentAt: '2026-09-01T10:00:00Z', raw: '{}'},
];
const VOUCHERS = [{id: 1, email: 'ddd@example.com', shopifyCustomerId: 'ddd', year: 2026, tier: 'gold', code: 'SECRET', amount: '100', discountNodeId: null, expiresAt: null, sentAt: '2026-10-10T10:00:00Z'}];
const BODIES = {customers: {customers: CUSTOMERS}, orders: {orders: []}, membership: {platinumThreshold: 2000, programStart: '2026-07-01'}, checkouts: {checkouts: CHECKOUTS}, birthdayVouchers: {birthdayVouchers: VOUCHERS}, membershipEvents: {membershipEvents: []}};
const LOG = async () => [{email: 'aaa@example.com', channel: 'sms', contactedAt: '2026-10-20T10:00:00Z'}];
const BASE = {joined_from: '', joined_to: '', tier: 'all', buyers: 'all', group_by: 'none', sort: 'newest', limit: 100, offset: 0};
type Row = Record<string, unknown>;
type R = {rows: Row[]; columns: {key: string}[]; meta: {checks: {code: string; status: string; text: string}[]; measures: {key: string; method: string}[]}; error?: string};

async function run(input: Record<string, unknown>, manualContacts: (() => Promise<readonly {email: string | null; channel?: string | null; contactedAt?: string | null}[] | null>) | undefined = LOG, bodies: Record<string, unknown> = BODIES) {
  const f = fakeCrmClient(bodies as never);
  const ex = createCrmExecutors({client: f.client, now: NOW, user: 'test@example.com', keep: (r) => r, maxCalls: 99, manualContacts, sink: {info: () => undefined, warn: () => undefined, error: () => undefined} as never});
  return (await ex.list_crm_customers({...BASE, ...input})) as R;
}
const ids = (r: R): string[] => r.rows.map((x) => String(x.email).slice(0, 3));
const byId = (r: R): Record<string, Row> => Object.fromEntries(r.rows.map((x) => [String(x.email).slice(0, 3), x]));

describe('7A Ask Coop: contact columns on every list, the two new sorts', () => {
  it('a plain list (no audience) carries emails_sent, manual_contacts, times_contacted, last_contacted, last_contact_kind', async () => {
    const r = await run({});
    expect(r.columns.map((c) => c.key)).toEqual(expect.arrayContaining(['emails_sent', 'manual_contacts', 'times_contacted', 'last_contacted', 'last_contact_kind']));
    const rows = byId(r);
    expect([rows.aaa.times_contacted, rows.aaa.last_contacted, rows.aaa.last_contact_kind]).toEqual([3, '2026-10-20', 'SMS']);
    expect([rows.bbb.times_contacted, rows.bbb.last_contacted, rows.bbb.last_contact_kind]).toEqual([0, null, 'never']);
    expect([rows.ccc.last_contacted, rows.ccc.last_contact_kind]).toEqual(['2026-09-01', 'Win-back email']);
    expect(r.meta.measures.map((m) => m.key)).toEqual(expect.arrayContaining(['emails_sent', 'manual_contacts', 'times_contacted']));
  });
  it('last_contacted_asc (R5): never contacted first, then the oldest contact', async () => {
    expect(ids(await run({sort: 'last_contacted_asc'}))).toEqual(['bbb', 'ccc', 'ddd', 'aaa']);
  });
  it('contacted_desc: most contacted first (times_contacted desc)', async () => {
    const r = await run({sort: 'contacted_desc'});
    expect(ids(r)[0]).toBe('aaa');
    expect(r.rows.map((x) => x.times_contacted)).toEqual([3, 1, 1, 0]);
  });
  it('the log unread (R3): last contacted is unknown for every row, never "never", and the result says so', async () => {
    const r = await run({sort: 'last_contacted_asc'}, async () => null);
    for (const row of r.rows) expect([row.last_contacted, row.last_contact_kind]).toEqual([null, 'unknown']);
    expect(r.meta.checks.some((c) => c.status === 'warn' && /last_contacted/.test(c.text) && /unknown/i.test(c.text))).toBe(true);
  });
  it('a CRM list unread: unknown too', async () => {
    const {checkouts: _c, ...noCheckouts} = BODIES;
    const r = await run({}, LOG, noCheckouts);
    expect(r.error).toBeUndefined();
    expect(byId(r).aaa.last_contact_kind).toBe('unknown');
  });
  it('an audience keeps its forced order (last order, oldest first) whatever contact sort was sent', () => {
    const req = readCustomersInput({...BASE, audience: 'win_back', sort: 'last_contacted_asc'});
    expect('error' in req ? req.error : req.sort).toBe('last_order_asc');
  });
  it('the sort enum and the tool description name the new sorts and columns', () => {
    expect(CUSTOMER_SORTS).toEqual(expect.arrayContaining(['contacted_desc', 'last_contacted_asc']));
    const t = CRM_TOOLS.find((x) => x.name === 'list_crm_customers');
    const props = (t?.input_schema as {properties: Record<string, {enum?: unknown[]}>}).properties;
    expect(props.sort.enum).toEqual([...CUSTOMER_SORTS]);
    expect(t?.description).toMatch(/last_contacted_asc/);
    expect(t?.description).toMatch(/contacted_desc/);
    expect(t?.description).toMatch(/times_contacted/);
  });
});
