// RET-03 (Stage 3, plan 2026-11-10-customer-outreach-stage3): outreach lists in Ask Coop. list_crm_customers takes a closed `audience`
// (repeat_promo, win_back) and each listed customer carries the automated CRM emails already sent, from one shared per-email tally.
// Every answer below is written by hand first. Owner rules: repeat promo = exactly 1 counted order, last order 30+ PH days ago;
// win-back = 2+ counted orders, last order 60+ PH days ago; a test order counts nowhere; consent is shown, never a filter; nothing sends.
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {createCrmExecutors} from '../src/chat/crm/executors';
import {CRM_ENDPOINTS, CRM_LIMITS, SHOPIFY_POST_PATH, createCrmClient} from '../src/chat/crm/client';
import {AUDIENCE_RULES, CUSTOMER_AUDIENCES} from '../src/chat/crm/tools';
import {CRM_TOOLS} from '../src/chat/tool-defs';
import {contactTally} from '../src/crm-compute';
import {projectBirthdayVoucher} from '../src/crm-project';
import {fakeCrmClient} from './support/crm-fixtures';

const NOW = new Date('2026-11-10T04:00:00Z'); // PH 2026-11-10 12:00. 30 PH days back = 2026-10-11, 60 = 2026-09-11.

const cust = (id: string, emailMarketingState: string | null = null) => ({
  shopifyCustomerId: id, email: `${id}@example.com`, firstName: `F${id}`, lastName: null, phone: null, ordersCount: null, totalSpent: null,
  membershipTier: null, petName: null, petBirthday: null, emailMarketingState, createdAt: '2026-05-01T10:00:00+08:00', updatedAt: null,
});
let n = 100;
const ord = (cid: string, createdAt: string, o: {test?: boolean; review?: string | null; email?: string} = {}) => {
  n += 1;
  return {
    shopifyOrderId: String(n), shopifyCustomerId: cid, orderNumber: `#${n}`, email: o.email ?? `${cid}@example.com`, totalPrice: '100.00', currency: 'PHP', financialStatus: 'paid',
    fulfillmentStatus: null, lineItems: null, createdAt, fulfilledAt: null, reviewRequestSentAt: o.review ?? null, reviewSubmittedAt: null, raw: JSON.stringify({test: o.test === true}),
  };
};

const CUSTOMERS = [
  cust('p30', 'unsubscribed'), // 1 order, last 2026-10-11 23:30 PH = 30 PH days: repeat_promo. Consent "unsubscribed" is shown, never filters.
  cust('p29'), // 1 order, 2026-10-12 00:10 PH (still 10-11 in UTC) = 29 PH days: excluded
  cust('w60'), // 2 orders, last 2026-09-11 23:30 PH = 60 PH days: win_back
  cust('w59'), // 2 orders, last 2026-09-12 00:10 PH = 59 PH days: excluded
  cust('tst'), // only a test order, 90 days ago: on no list
  cust('t1x'), // 1 real order 100 days ago + 1 TEST order 100 days ago: 1 counted order, so repeat_promo, never win_back
  cust('tnw'), // 1 real order 40 days ago + 1 TEST order yesterday: the test order does not move the last order, so repeat_promo
  cust('non'), // no orders: on no list
  cust('w2x'), // 3 orders, last 2026-08-01: win_back, oldest last order
];
const ORDERS = [
  ord('p30', '2026-10-11T23:30:00+08:00', {review: '2026-10-15T10:00:00Z'}),
  ord('p29', '2026-10-12T00:10:00+08:00'),
  ord('w60', '2026-08-01T10:00:00+08:00', {review: '2026-08-05T10:00:00Z'}),
  ord('w60', '2026-09-11T23:30:00+08:00', {review: '2026-09-15T10:00:00Z'}),
  ord('w59', '2026-08-01T10:00:00+08:00'),
  ord('w59', '2026-09-12T00:10:00+08:00'),
  ord('tst', '2026-08-12T10:00:00+08:00', {test: true, review: '2026-08-15T10:00:00Z'}),
  ord('t1x', '2026-08-02T10:00:00+08:00'),
  ord('t1x', '2026-08-02T11:00:00+08:00', {test: true, review: '2026-08-05T10:00:00Z'}), // a TEST order's review request is not counted
  ord('tnw', '2026-10-01T10:00:00+08:00'),
  ord('tnw', '2026-11-09T10:00:00+08:00', {test: true}),
  ord('w2x', '2026-06-01T10:00:00+08:00'),
  ord('w2x', '2026-07-01T10:00:00+08:00'),
  ord('w2x', '2026-08-01T10:00:00+08:00'),
];
const CHECKOUTS = [
  {shopifyCheckoutId: 'k1', email: 'P30@Example.com', abandonedCheckoutUrl: 'https://x.example/SECRET-RECOVERY', totalPrice: '100', currency: 'PHP', createdAt: '2026-10-01T10:00:00Z', updatedAt: null, convertedAt: null, remindersSent: 2, lastReminderAt: null, reachedPaymentAt: null, winbackSentAt: '2026-10-05T10:00:00Z', raw: '{}'},
  {shopifyCheckoutId: 'k2', email: 'p30@example.com', totalPrice: '100', currency: 'PHP', createdAt: '2026-10-02T10:00:00Z', updatedAt: null, convertedAt: null, remindersSent: 1, lastReminderAt: null, reachedPaymentAt: null, winbackSentAt: null, raw: '{}'},
  {shopifyCheckoutId: 'k3', email: 'w60@example.com', totalPrice: '100', currency: 'PHP', createdAt: '2026-09-20T10:00:00Z', updatedAt: null, convertedAt: null, remindersSent: 0, lastReminderAt: null, reachedPaymentAt: null, winbackSentAt: '2026-09-25T10:00:00Z', raw: '{}'},
];
const VOUCHERS = [
  {id: 1, email: ' p30@EXAMPLE.com', shopifyCustomerId: 'p30', year: 2026, tier: 'gold', code: 'SECRET-VOUCHER-2026', amount: '100', discountNodeId: 'gid://SECRET-NODE', expiresAt: '2026-12-01', sentAt: '2026-06-01T10:00:00Z'},
  {id: 2, email: 'p30@example.com', shopifyCustomerId: 'p30', year: 2025, tier: 'gold', code: 'SECRET-VOUCHER-2025', amount: '100', discountNodeId: null, expiresAt: null, sentAt: '2025-06-01T10:00:00Z'},
];

// ---------- ANSWERS, by hand ----------
const ANSWER = {
  repeat_promo: ['t1x', 'tnw', 'p30'], // sorted by last order, oldest first: 08-02, 10-01, 10-11
  win_back: ['w2x', 'w60'], // 08-01, 09-11
  p30: {reminders: 3, winback: 1, review_requests: 1, birthday_vouchers: 2, emails_sent: 7},
  w60: {reminders: 0, winback: 1, review_requests: 2, birthday_vouchers: 0, emails_sent: 3},
  t1x: {reminders: 0, winback: 0, review_requests: 0, birthday_vouchers: 0, emails_sent: 0},
};

type Row = Record<string, unknown>;
type R = {rows: Row[]; columns: {key: string}[]; meta: {checks: {code: string; status: string; text: string}[]}; error?: string};
const BASE = {joined_from: '', joined_to: '', tier: 'all', buyers: 'all', group_by: 'none', sort: 'newest', limit: 100, offset: 0};
const BODIES = {customers: {customers: CUSTOMERS}, orders: {orders: ORDERS}, membership: {platinumThreshold: 2000, programStart: '2026-07-01'}, checkouts: {checkouts: CHECKOUTS}, birthdayVouchers: {birthdayVouchers: VOUCHERS}};

async function run(input: Record<string, unknown>, bodies: Record<string, unknown> = BODIES) {
  const f = fakeCrmClient(bodies as never);
  const ex = createCrmExecutors({client: f.client, now: NOW, user: 'test@example.com', keep: (r) => r, maxCalls: 99, sink: {info: () => undefined, warn: () => undefined, error: () => undefined} as never});
  return {r: (await ex.list_crm_customers({...BASE, ...input})) as R, gets: f.gets};
}
const id = (r: Row): string => String(r.email).slice(0, 3);
const byId = (r: R): Record<string, Row> => Object.fromEntries(r.rows.map((x) => [id(x), x]));
const tallyOf = (row: Row) => ({reminders: row.reminders, winback: row.winback, review_requests: row.review_requests, birthday_vouchers: row.birthday_vouchers, emails_sent: row.emails_sent});

describe('S3.1 audience: the owner rules, fixed in code, at the PH-day boundaries', () => {
  it('the rules are one constant each, and the enum is closed', () => {
    expect(CUSTOMER_AUDIENCES).toEqual(['all', 'repeat_promo', 'win_back']);
    expect(AUDIENCE_RULES).toEqual({repeat_promo: {minOrders: 1, maxOrders: 1, minDays: 30}, win_back: {minOrders: 2, maxOrders: null, minDays: 60}});
  });
  it('repeat_promo: exactly 1 counted order, 30+ PH days; 30 in, 29 out; sorted by last order, oldest first', async () => {
    const {r} = await run({audience: 'repeat_promo'});
    expect(r.rows.map(id)).toEqual(ANSWER.repeat_promo);
    expect(byId(r).p30.days_since_last_order).toBe(30);
    expect(r.rows.map(id)).not.toContain('p29');
  });
  it('win_back: 2+ counted orders, 60+ PH days; 60 in, 59 out', async () => {
    const {r} = await run({audience: 'win_back'});
    expect(r.rows.map(id)).toEqual(ANSWER.win_back);
    expect(byId(r).w60.days_since_last_order).toBe(60);
    expect(r.rows.map(id)).not.toContain('w59');
  });
  it('the audience sorts by last order oldest first, whatever sort was sent', async () => {
    expect((await run({audience: 'repeat_promo', sort: 'spend_desc'})).r.rows.map(id)).toEqual(ANSWER.repeat_promo);
  });
  it('the result states the rule and the count', async () => {
    const {r} = await run({audience: 'win_back'});
    const text = r.meta.checks.map((c) => c.text).join('\n');
    expect(text).toMatch(/2 or more counted orders/);
    expect(text).toMatch(/60 or more Philippine days/);
    expect(r.meta.checks.find((c) => c.code === 'reconciles')?.text).toMatch(/^2 website customers match/);
  });
  it('audience all (the default): every customer, the contact columns (RET-07) but not the per-source breakdown; five reads', async () => {
    const {r, gets} = await run({});
    expect(r.rows).toHaveLength(CUSTOMERS.length);
    expect(r.columns.map((c) => c.key)).toEqual(expect.arrayContaining(['emails_sent', 'times_contacted', 'last_contacted']));
    expect(r.columns.map((c) => c.key)).not.toContain('reminders');
    expect([...gets].sort()).toEqual(['birthdayVouchers', 'checkouts', 'customers', 'membership', 'orders']);
  });
  it('anything else is refused before any read', async () => {
    for (const audience of ['everyone', 'winback', 'REPEAT_PROMO', 1, null]) {
      const {r, gets} = await run({audience});
      expect(r.error).toBeTypeOf('string');
      expect(gets).toHaveLength(0);
    }
  });
});

describe('S3.2 emails sent: one per-email tally, each source counted', () => {
  it('cart reminders summed, win-back 1 per cart, review requests 1 per order, birthday vouchers 1 per row; matched by lower-cased email', async () => {
    const rows = byId((await run({audience: 'repeat_promo'})).r);
    expect(tallyOf(rows.p30)).toEqual(ANSWER.p30);
    expect(tallyOf(rows.t1x)).toEqual(ANSWER.t1x); // its test order's review request is not counted
    expect(tallyOf(byId((await run({audience: 'win_back'})).r).w60)).toEqual(ANSWER.w60);
  });
  it('contactTally is pure and shared (Stage 4 and 5 reuse it); test orders are skipped', () => {
    const t = contactTally({
      checkouts: [{email: 'A@x.com', remindersSent: 2, winbackSentAt: 'x'}, {email: null, remindersSent: 5, winbackSentAt: 'x'}],
      orders: [{email: 'a@x.com', reviewRequestSentAt: 'x', test: false}, {email: 'a@x.com', reviewRequestSentAt: 'x', test: true}, {email: 'a@x.com', reviewRequestSentAt: null, test: false}],
      birthdayVouchers: [{email: 'a@X.com '}],
    });
    expect(t.get('a@x.com')).toEqual({reminders: 2, winback: 1, reviewRequests: 1, birthdayVouchers: 1, automated: 5, manual: 0, total: 5, lastAt: null, lastKind: null}); // Stage 5 added automated + manual; RET-07 lastAt ('x' does not parse, so no date)
    expect(t.size).toBe(1);
  });
  it('consent is shown as is ("unknown" when never set) and never filters anyone out', async () => {
    const rows = byId((await run({audience: 'repeat_promo'})).r);
    expect(rows.p30.email_marketing).toBe('unsubscribed');
    expect(rows.t1x.email_marketing).toBe('unknown');
    expect((await run({audience: 'repeat_promo'})).r.meta.checks.map((c) => c.text).join('\n')).toMatch(/never a filter/);
  });
  it('a source that cannot be read leaves emails_sent unknown and says so; it never reads as zero', async () => {
    const {birthdayVouchers: _v, ...noVouchers} = BODIES;
    const {r} = await run({audience: 'repeat_promo'}, noVouchers);
    expect(r.error).toBeUndefined();
    const p30 = byId(r).p30;
    expect([p30.emails_sent, p30.birthday_vouchers]).toEqual([null, null]);
    expect(p30.reminders).toBe(3);
    expect(r.meta.checks.some((c) => c.status === 'warn' && /birthday vouchers could not be read/.test(c.text))).toBe(true);
  });
});

describe('negative cases: test orders, voucher codes, no send path, the GET cap', () => {
  it('a test order never puts anyone on a list', async () => {
    const promo = (await run({audience: 'repeat_promo'})).r.rows.map(id);
    const back = (await run({audience: 'win_back'})).r.rows.map(id);
    expect([...promo, ...back]).not.toContain('tst');
    expect(back).not.toContain('t1x');
  });
  it('the voucher code (and its discount node) is never projected or returned', async () => {
    expect(Object.keys(projectBirthdayVoucher(VOUCHERS[0])).sort()).toEqual(['email', 'sentAt', 'tier', 'year']);
    const all = JSON.stringify((await run({audience: 'repeat_promo'})).r) + JSON.stringify((await run({audience: 'win_back'})).r);
    expect(all).not.toMatch(/SECRET/);
  });
  it('the birthday vouchers entry is a GET with no query parameters; the one POST is still only the Shopify door', () => {
    expect(CRM_ENDPOINTS.birthdayVouchers).toEqual({path: '/api/birthday-vouchers', query: {}});
    expect(SHOPIFY_POST_PATH).toBe('/api/shopify/query');
    const client = readFileSync('src/chat/crm/client.ts', 'utf8');
    expect(client.match(/['"]POST['"]/g)).toHaveLength(1);
    expect(readFileSync('src/chat/crm/tools.ts', 'utf8')).not.toMatch(/['"](POST|PUT|PATCH|DELETE)['"]|\/admin|send_?email/i);
  });
  it('an audience call makes 5 distinct reads through the real client, within the per-turn GET cap', async () => {
    const PATHS: Record<string, string> = {'/api/customers': 'customers', '/api/orders': 'orders', '/api/membership-config': 'membership', '/api/checkouts': 'checkouts', '/api/birthday-vouchers': 'birthdayVouchers'};
    const sent: {url: string; method?: string}[] = [];
    const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      sent.push({url: String(input), method: init.method});
      return new Response(JSON.stringify((BODIES as Record<string, unknown>)[PATHS[new URL(String(input)).pathname]]));
    }) as typeof globalThis.fetch;
    const client = createCrmClient({baseUrl: 'https://crm.example', token: 't', fetch});
    const ex = createCrmExecutors({client, now: NOW, user: 'test@example.com', keep: (r) => r, maxCalls: 99, sink: {info: () => undefined, warn: () => undefined, error: () => undefined} as never});
    const r = (await ex.list_crm_customers({...BASE, audience: 'win_back'})) as R;
    expect(r.rows.map(id)).toEqual(ANSWER.win_back);
    expect(sent).toHaveLength(5);
    expect(sent.every((s) => s.method === 'GET')).toBe(true);
    expect(sent.length).toBeLessThanOrEqual(CRM_LIMITS.maxGetsPerTurn);
  });
  it('the tool schema carries the closed audience enum', () => {
    const t = CRM_TOOLS.find((x) => x.name === 'list_crm_customers');
    const props = (t?.input_schema as {properties: Record<string, {enum?: unknown[]}>}).properties;
    expect(props.audience.enum).toEqual(['all', 'repeat_promo', 'win_back']);
    expect(t?.description).toMatch(/repeat_promo/);
    expect(t?.description).toMatch(/win_back/);
  });
});

// RET-05 (Stage 5): the manual contact log in the audience lists. emails_sent stays automated-only; manual_contacts and
// times_contacted (automated + manual) are added. The manual counts come from the route's server seam (deps.manualContacts);
// absent or failing, both columns are null with a note, never 0.
describe('S5.3 Ask Coop: manual_contacts and times_contacted', () => {
  async function runManual(input: Record<string, unknown>, manualContacts?: () => Promise<readonly {email: string | null}[] | null>, bodies: Record<string, unknown> = BODIES) {
    const f = fakeCrmClient(bodies as never);
    const ex = createCrmExecutors({client: f.client, now: NOW, user: 'test@example.com', keep: (r) => r, maxCalls: 99, manualContacts, sink: {info: () => undefined, warn: () => undefined, error: () => undefined} as never});
    return {r: (await ex.list_crm_customers({...BASE, ...input})) as R, gets: f.gets};
  }
  const LOG = async () => [{email: 'P30@example.com'}, {email: 'p30@example.com'}, {email: 'w60@example.com'}];
  it('p30: 7 automated emails + 2 logged contacts = 9 times contacted; emails_sent stays 7', async () => {
    const rows = byId((await runManual({audience: 'repeat_promo'}, LOG)).r);
    expect([rows.p30.emails_sent, rows.p30.manual_contacts, rows.p30.times_contacted]).toEqual([7, 2, 9]);
    expect([rows.t1x.emails_sent, rows.t1x.manual_contacts, rows.t1x.times_contacted]).toEqual([0, 0, 0]);
    const w60 = byId((await runManual({audience: 'win_back'}, LOG)).r).w60;
    expect([w60.emails_sent, w60.manual_contacts, w60.times_contacted]).toEqual([3, 1, 4]);
  });
  it('the columns and their methods are declared; the manual read is no CRM GET', async () => {
    const {r, gets} = await runManual({audience: 'repeat_promo'}, LOG);
    const keys = r.columns.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['emails_sent', 'manual_contacts', 'times_contacted']));
    expect(keys.indexOf('manual_contacts')).toBe(keys.indexOf('emails_sent') + 1);
    expect([...gets].sort()).toEqual(['birthdayVouchers', 'checkouts', 'customers', 'membership', 'orders']);
  });
  it('the log not applied (null) or not wired: manual_contacts and times_contacted are null with a warning, emails_sent still shows', async () => {
    for (const manual of [async () => null, undefined, async () => { throw new Error('boom'); }]) {
      const {r} = await runManual({audience: 'repeat_promo'}, manual);
      const p30 = byId(r).p30;
      expect([p30.emails_sent, p30.manual_contacts, p30.times_contacted]).toEqual([7, null, null]);
      expect(r.meta.checks.some((c) => c.status === 'warn' && /manual contact log/i.test(c.text) && /not.*zero/i.test(c.text))).toBe(true);
    }
  });
  it('audience all reads the log once too (RET-07: contact columns on every list); group counts never read it', async () => {
    let reads = 0;
    const {r} = await runManual({}, async () => { reads += 1; return []; });
    expect(reads).toBe(1);
    expect(r.columns.map((c) => c.key)).toContain('manual_contacts');
    await runManual({group_by: 'tier'}, async () => { reads += 1; return []; });
    expect(reads).toBe(1);
  });
});

describe('An audience list is never cut short by a small page (staging test 2026-11-11: 25 of 30)', () => {
  it('30 lapsed one-time buyers, limit 10: all 30 are listed', async () => {
    const ids = Array.from({length: 30}, (_, i) => `l${String(i).padStart(2, '0')}`);
    const bodies = {...BODIES, customers: {customers: ids.map((c) => cust(c))}, orders: {orders: ids.map((c) => ord(c, '2026-08-01T10:00:00+08:00'))}};
    expect((await run({audience: 'repeat_promo', limit: 10}, bodies)).r.rows).toHaveLength(30);
  });
});
