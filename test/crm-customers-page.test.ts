// RET-04 (Stage 4, plan 2026-11-10-customer-page-stage4): the Website CRM page's Customers tab shows what Ask Coop answers.
// One fixture goes through the page compute (src/crm-compute.ts, the same functions the page calls) and through list_crm_customers;
// the counts, repeat rate, chart groups and audience lists must be identical. Answers are written by hand first.
import {describe, expect, it} from 'vitest';
import {createCrmExecutors} from '../src/chat/crm/executors';
import {AUDIENCE_RULES as CHAT_RULES, REPEAT_TARGET_PCT as CHAT_TARGET, repeatRateCheck} from '../src/chat/crm/tools';
import {
  AUDIENCE_RULES,
  REPEAT_TARGET_PCT,
  audienceRows,
  buyersByOrders,
  contactTally,
  customerRows,
  enrichCustomers,
  inAudience,
  membershipWindowStart,
  newBuyersByMonth,
  ordersBucket,
  phDaysSince,
  repeatRate,
} from '../src/crm-compute';
import {projectBirthdayVoucher, projectCheckoutSafe, projectCustomer, projectOrder} from '../src/crm-project';
import {fakeCrmClient} from './support/crm-fixtures';

const NOW = new Date('2026-11-10T04:00:00Z'); // PH 2026-11-10 12:00. 30 PH days back = 2026-10-11, 60 = 2026-09-11.

const cust = (id: string, emailMarketingState: string | null = null) => ({
  shopifyCustomerId: id, email: `${id}@example.com`, firstName: `F${id}`, lastName: null, phone: null, ordersCount: null, totalSpent: null,
  membershipTier: null, petName: null, petBirthday: null, emailMarketingState, createdAt: '2026-05-01T10:00:00+08:00', updatedAt: null,
});
let n = 500;
const ord = (cid: string, createdAt: string, o: {test?: boolean; review?: string | null} = {}) => {
  n += 1;
  return {
    shopifyOrderId: String(n), shopifyCustomerId: cid, orderNumber: `#${n}`, email: `${cid}@example.com`, totalPrice: '100.00', currency: 'PHP', financialStatus: 'paid',
    fulfillmentStatus: null, lineItems: null, createdAt, fulfilledAt: null, reviewRequestSentAt: o.review ?? null, reviewSubmittedAt: null, raw: JSON.stringify({test: o.test === true}),
  };
};

const CUSTOMERS = [
  cust('p30', 'unsubscribed'), // 1 order 30 PH days ago: repeat_promo
  cust('p29'), // 1 order 29 PH days ago: none
  cust('w60', 'subscribed'), // 2 orders, last 60 PH days ago: win_back
  cust('w59'), // 2 orders, last 59 PH days ago: none
  cust('tst'), // only a test order: no orders at all
  cust('t1x'), // 1 real + 1 test order: 1 counted order, repeat_promo
  cust('non'), // no orders
  cust('w4x'), // 4 orders, last 2026-08-01: win_back, bucket 4+
];
const ORDERS = [
  ord('p30', '2026-10-11T23:30:00+08:00', {review: '2026-10-15T10:00:00Z'}),
  ord('p29', '2026-10-12T00:10:00+08:00'),
  ord('w60', '2026-07-01T10:00:00+08:00'),
  ord('w60', '2026-09-11T23:30:00+08:00'),
  ord('w59', '2026-08-01T10:00:00+08:00'),
  ord('w59', '2026-09-12T00:10:00+08:00'),
  ord('tst', '2026-08-12T10:00:00+08:00', {test: true, review: '2026-08-15T10:00:00Z'}),
  ord('t1x', '2026-08-02T10:00:00+08:00'),
  ord('t1x', '2026-08-02T11:00:00+08:00', {test: true}),
  ord('w4x', '2026-05-01T10:00:00+08:00'),
  ord('w4x', '2026-06-01T10:00:00+08:00'),
  ord('w4x', '2026-07-01T10:00:00+08:00'),
  ord('w4x', '2026-08-01T10:00:00+08:00'),
];
const CHECKOUTS = [
  {shopifyCheckoutId: 'k1', email: 'P30@Example.com', totalPrice: '100', currency: 'PHP', createdAt: '2026-10-01T10:00:00Z', updatedAt: null, convertedAt: null, remindersSent: 2, lastReminderAt: null, reachedPaymentAt: null, winbackSentAt: '2026-10-05T10:00:00Z', raw: '{}'},
];
const VOUCHERS = [{id: 1, email: 'p30@example.com', year: 2026, tier: 'gold', code: 'SECRET-VOUCHER', amount: '100', expiresAt: null, sentAt: '2026-06-01T10:00:00Z'}];
const MEMBERSHIP = {platinumThreshold: 2000, programStart: '2026-07-01'};
const BODIES = {customers: {customers: CUSTOMERS}, orders: {orders: ORDERS}, membership: MEMBERSHIP, checkouts: {checkouts: CHECKOUTS}, birthdayVouchers: {birthdayVouchers: VOUCHERS}};

// ---------- ANSWERS, by hand ----------
const ANSWER = {
  buyers: 6, // p30 p29 w60 w59 t1x w4x (tst has only a test order)
  repeat: 3, // w60 w59 w4x
  ratePct: 50,
  repeat_promo: ['t1x', 'p30'], // last order 08-02, then 10-11
  win_back: ['w4x', 'w60'], // 08-01, then 09-11
  buckets: [{group: '1', customers: 3}, {group: '2', customers: 2}, {group: '4+', customers: 1}],
  months: [{group: '2026-05', customers: 1}, {group: '2026-07', customers: 1}, {group: '2026-08', customers: 2}, {group: '2026-10', customers: 2}],
  p30: {orders: 1, days: 30, emailsSent: 5, consent: 'unsubscribed'}, // 2 reminders + 1 winback + 1 review + 1 voucher
};

/** The page: the same projections crm-data.ts applies, then the shared compute. */
function pageCompute(withTally = true) {
  const enriched = enrichCustomers(CUSTOMERS.map(projectCustomer), ORDERS.map(projectOrder), membershipWindowStart(NOW, MEMBERSHIP.programStart));
  const tally = withTally
    ? contactTally({checkouts: CHECKOUTS.map(projectCheckoutSafe), orders: ORDERS.map(projectOrder), birthdayVouchers: VOUCHERS.map(projectBirthdayVoucher)})
    : null;
  return customerRows(enriched, tally, NOW);
}
type Row = Record<string, unknown>;
type R = {rows: Row[]; meta: {checks: {code: string; values?: Record<string, unknown>}[]}};
async function chat(input: Record<string, unknown>): Promise<R> {
  const f = fakeCrmClient(BODIES as never);
  const ex = createCrmExecutors({client: f.client, now: NOW, user: 'test@example.com', keep: (r) => r, maxCalls: 99, sink: {info: () => undefined, warn: () => undefined, error: () => undefined} as never});
  return (await ex.list_crm_customers({joined_from: '', joined_to: '', tier: 'all', buyers: 'all', group_by: 'none', sort: 'newest', limit: 100, offset: 0, ...input})) as R;
}
const id = (email: unknown): string => String(email).slice(0, 3);

describe('S4.0 shared rules: one implementation, page and chat', () => {
  it('the chat re-exports the same rule and target objects', () => {
    expect(CHAT_RULES).toBe(AUDIENCE_RULES);
    expect(CHAT_TARGET).toBe(REPEAT_TARGET_PCT);
    expect(REPEAT_TARGET_PCT).toBe(25);
  });
  it('the audience presets are Stage 3 rules exactly, at the PH-day boundaries', () => {
    expect(AUDIENCE_RULES).toEqual({repeat_promo: {minOrders: 1, maxOrders: 1, minDays: 30}, win_back: {minOrders: 2, maxOrders: null, minDays: 60}});
    const c = (orderCount: number, lastOrderAt: string | null) => ({orderCount, lastOrderAt});
    expect(inAudience(c(1, '2026-10-11T23:30:00+08:00'), 'repeat_promo', NOW)).toBe(true);
    expect(inAudience(c(1, '2026-10-12T00:10:00+08:00'), 'repeat_promo', NOW)).toBe(false);
    expect(inAudience(c(2, '2026-10-11T23:30:00+08:00'), 'repeat_promo', NOW)).toBe(false);
    expect(inAudience(c(2, '2026-09-11T23:30:00+08:00'), 'win_back', NOW)).toBe(true);
    expect(inAudience(c(2, '2026-09-12T00:10:00+08:00'), 'win_back', NOW)).toBe(false);
    expect(inAudience(c(1, '2026-01-01T10:00:00+08:00'), 'win_back', NOW)).toBe(false);
    expect(inAudience(c(0, null), 'repeat_promo', NOW)).toBe(false);
    expect(inAudience(c(0, null), 'all', NOW)).toBe(true);
  });
  it('days since and buckets', () => {
    expect(phDaysSince('2026-10-11T23:30:00+08:00', NOW)).toBe(30);
    expect(phDaysSince(null, NOW)).toBeNull();
    expect(['0', '1', '2', '3', '4+', '4+'].map((b, i) => ordersBucket([0, 1, 2, 3, 4, 9][i]) === b)).toEqual(Array(6).fill(true));
  });
  it('repeat rate: buyers with 2+ / buyers with 1+, null with no buyers; the chat check reads the same numbers', () => {
    expect(repeatRate([0, 1, 2, 3])).toEqual({repeat: 2, buyers: 3, ratePct: 66.7});
    expect(repeatRate([0, 0])).toEqual({repeat: 0, buyers: 0, ratePct: null});
    expect(repeatRateCheck([0, 1, 2, 3]).values).toMatchObject({repeat: 2, buyers: 3, rate_pct: 66.7, target_pct: 25});
  });
});

describe('S4.0 parity: the page compute equals list_crm_customers on one fixture', () => {
  const rows = pageCompute();

  it('repeat rate', async () => {
    const page = repeatRate(rows.map((r) => r.orderCount));
    expect(page).toEqual({repeat: ANSWER.repeat, buyers: ANSWER.buyers, ratePct: ANSWER.ratePct});
    const check = (await chat({group_by: 'orders_bucket'})).meta.checks.find((c) => c.code === 'repeat_rate');
    expect(check?.values).toMatchObject({repeat: page.repeat, buyers: page.buyers, rate_pct: page.ratePct});
  });

  it('buyers by orders (1 / 2 / 3 / 4+), non-buyers left out', async () => {
    expect(buyersByOrders(rows)).toEqual(ANSWER.buckets);
    const chatRows = (await chat({group_by: 'orders_bucket'})).rows.filter((r) => r.group !== '0').map((r) => ({group: r.group, customers: r.customers}));
    expect(chatRows).toEqual(ANSWER.buckets);
  });

  it('new buyers per first-order PH month', async () => {
    expect(newBuyersByMonth(rows)).toEqual(ANSWER.months);
    const chatRows = (await chat({group_by: 'first_order_month'})).rows.filter((r) => r.group !== 'no orders').map((r) => ({group: r.group, customers: r.customers}));
    expect(chatRows).toEqual(ANSWER.months);
  });

  for (const audience of ['repeat_promo', 'win_back'] as const) {
    it(`${audience}: same people, same order, same per-customer numbers`, async () => {
      const page = audienceRows(rows, audience, NOW);
      expect(page.map((r) => id(r.email))).toEqual(ANSWER[audience]);
      const c = await chat({audience});
      expect(c.rows.map((r) => id(r.email))).toEqual(ANSWER[audience]);
      expect(page.map((r) => ({orders: r.orderCount, days: r.daysSinceLastOrder, emails: r.emailsSent, consent: r.consent}))).toEqual(
        c.rows.map((r) => ({orders: r.orders, days: r.days_since_last_order, emails: r.emails_sent, consent: r.email_marketing})),
      );
    });
  }

  it('the per-customer columns: orders (test excluded), days since, emails sent, consent "unknown" when unset', () => {
    const p30 = rows.find((r) => r.shopifyCustomerId === 'p30')!;
    expect({orders: p30.orderCount, days: p30.daysSinceLastOrder, emailsSent: p30.emailsSent, consent: p30.consent}).toEqual(ANSWER.p30);
    const t1x = rows.find((r) => r.shopifyCustomerId === 't1x')!;
    expect(t1x.orderCount).toBe(1);
    expect(t1x.consent).toBe('unknown');
    expect(rows.find((r) => r.shopifyCustomerId === 'tst')!.orderCount).toBe(0);
    expect(t1x.emailsSent).toBe(0);
  });

  it('an unreadable tally source leaves emails sent unknown (null), never 0', () => {
    expect(pageCompute(false).every((r) => r.emailsSent === null)).toBe(true);
  });

  it('audience "all" keeps every row in its given order', () => {
    expect(audienceRows(rows, 'all', NOW)).toEqual(rows);
  });
});
