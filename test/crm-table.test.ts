// RET-09 (Stage 8A, plan knowledge/tasks/2026-11-12-customer-profile-stage8.md): Vince parity on the Website CRM page. The pure parts:
// header sorting (nulls last both ways), the reminder / review schedule lines read from /api/metrics (absent → no line, never invented),
// "n of N" reminders, the Pet birthdays rows, and each table's CSV with Vince's summary header. Recovery links never reach a CSV.
import {describe, expect, it} from 'vitest';
import {compareLastContacted, compareTimesContacted, daysToPetBirthday, type CustomerRow} from '../src/crm-compute';
import {
  CART_SORT,
  CUSTOMER_SORT,
  ORDER_SORT,
  PET_SORT,
  cartCsv,
  cartSummary,
  csvSummary,
  customerCsv,
  filterNote,
  fmtMinutes,
  nextSort,
  orderCsv,
  petCsv,
  petRows,
  remindersOf,
  reminderSchedule,
  reviewSchedule,
  sortRows,
} from '../src/crm-table';
import type {CrmCheckout, CrmMetrics, CrmOrder} from '../src/crm-types';

const NOW = new Date('2026-11-12T04:00:00Z');

const cart = (id: string, over: Partial<CrmCheckout> = {}): CrmCheckout => ({
  shopifyCheckoutId: id, email: `${id}@example.com`, abandonedCheckoutUrl: `https://shop.example/checkouts/${id}/recover?key=SECRET`, totalPrice: '100.00',
  currency: 'PHP', createdAt: '2026-11-01T00:00:00Z', updatedAt: null, convertedAt: null, remindersSent: 0, lastReminderAt: null,
  reachedPaymentAt: null, winbackSentAt: null, stage: 'Email', ...over,
});
const order = (id: string, over: Partial<CrmOrder> = {}): CrmOrder => ({
  shopifyOrderId: id, shopifyCustomerId: null, orderNumber: `#${id}`, email: `${id}@example.com`, totalPrice: '500.00', currency: 'PHP',
  financialStatus: 'paid', fulfillmentStatus: null, createdAt: '2026-11-01T00:00:00Z', fulfilledAt: null, reviewRequestSentAt: null,
  reviewSubmittedAt: null, test: false, discountCodes: [], lineItems: null, ...over,
});
const row = (id: string, over: Partial<CustomerRow> = {}): CustomerRow => ({
  shopifyCustomerId: id, email: `${id}@example.com`, firstName: id, lastName: null, phone: null, ordersCount: null, totalSpent: null,
  membershipTier: 'gold', petName: null, petBirthday: null, emailMarketingState: null, createdAt: '2026-07-02T00:00:00Z', updatedAt: null,
  orderCount: 0, spent: 0, spendYtd: 0, firstOrderAt: null, lastOrderAt: null, firstOrderCode: null, daysSinceLastOrder: null,
  emailsSent: 0, manualContacts: 0, timesContacted: 0, lastContactedAt: null, lastContactKind: null, lastContactKnown: true,
  consent: 'unknown', ...over,
});
const ids = <T extends {shopifyCheckoutId?: string; shopifyOrderId?: string; shopifyCustomerId?: string | null}>(rows: T[]) =>
  rows.map((r) => r.shopifyCheckoutId ?? r.shopifyOrderId ?? r.shopifyCustomerId);

describe('header sorting', () => {
  it('sorts numbers both ways with nulls last either way, and keeps ties in their order', () => {
    const rows = [cart('a', {items: 2}), cart('b'), cart('c', {items: 5}), cart('d', {items: 2})];
    expect(ids(sortRows(rows, {key: 'items', dir: 'asc'}, CART_SORT))).toEqual(['a', 'd', 'c', 'b']);
    expect(ids(sortRows(rows, {key: 'items', dir: 'desc'}, CART_SORT))).toEqual(['c', 'a', 'd', 'b']);
    expect(ids(sortRows(rows, null, CART_SORT))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('dates sort by instant, a missing or junk date is null (last); text is case-insensitive', () => {
    const rows = [order('1', {fulfilledAt: '2026-11-03T00:00:00Z'}), order('2', {fulfilledAt: 'junk'}), order('3', {fulfilledAt: '2026-11-02T00:00:00Z'})];
    expect(ids(sortRows(rows, {key: 'fulfilled', dir: 'desc'}, ORDER_SORT))).toEqual(['1', '3', '2']);
    expect(ids(sortRows(rows, {key: 'fulfilled', dir: 'asc'}, ORDER_SORT))).toEqual(['3', '1', '2']);
    const people = [row('b', {email: 'Zed@x.com'}), row('a', {email: null}), row('c', {email: 'amy@x.com'})];
    expect(ids(sortRows(people, {key: 'email', dir: 'asc'}, CUSTOMER_SORT))).toEqual(['c', 'b', 'a']);
  });

  it('order numbers sort numerically; turnaround is null until fulfilled; Abandoned uses created, else updated', () => {
    expect(ids(sortRows([order('10'), order('9'), order('100')], {key: 'order', dir: 'asc'}, ORDER_SORT))).toEqual(['9', '10', '100']);
    const t = [order('a', {fulfilledAt: '2026-11-04T00:00:00Z'}), order('b'), order('c', {fulfilledAt: '2026-11-02T00:00:00Z'})];
    expect(ids(sortRows(t, {key: 'turnaround', dir: 'asc'}, ORDER_SORT))).toEqual(['c', 'a', 'b']);
    const carts = [cart('a', {createdAt: null, updatedAt: '2026-11-05T00:00:00Z'}), cart('b')];
    expect(ids(sortRows(carts, {key: 'abandoned', dir: 'desc'}, CART_SORT))).toEqual(['a', 'b']);
  });

  it("the Sort select's two orders are header sorts that match 7A's comparators exactly", () => {
    const people = [
      row('known-old', {lastContactedAt: '2026-01-01T00:00:00Z', timesContacted: 1}),
      row('unknown', {lastContactKnown: false, timesContacted: null}),
      row('never', {timesContacted: 0}),
      row('known-new', {lastContactedAt: '2026-10-01T00:00:00Z', timesContacted: 4}),
    ];
    expect(ids(sortRows(people, {key: 'lastContacted', dir: 'asc'}, CUSTOMER_SORT))).toEqual(ids([...people].sort(compareLastContacted)));
    expect(ids(sortRows(people, {key: 'timesContacted', dir: 'desc'}, CUSTOMER_SORT))).toEqual(ids([...people].sort(compareTimesContacted)));
    // Newest first still keeps unknown last (never claimed as never).
    expect(ids(sortRows(people, {key: 'lastContacted', dir: 'desc'}, CUSTOMER_SORT))).toEqual(['known-new', 'known-old', 'never', 'unknown']);
  });

  it('tier ranks Platinum over Gold over Guest; To Platinum has nothing for a guest', () => {
    const people = [row('g', {membershipTier: null}), row('p', {membershipTier: 'platinum', spendYtd: 3000}), row('o', {membershipTier: 'gold', spendYtd: 900})];
    expect(ids(sortRows(people, {key: 'tier', dir: 'desc'}, CUSTOMER_SORT))).toEqual(['p', 'o', 'g']);
    expect(ids(sortRows(people, {key: 'toPlatinum', dir: 'asc'}, CUSTOMER_SORT))).toEqual(['o', 'p', 'g']);
  });

  it('nextSort: a new column starts at its natural direction, the same column flips', () => {
    expect(nextSort({key: 'email', dir: 'asc'}, 'abandoned')).toEqual({key: 'abandoned', dir: 'desc'});
    expect(nextSort({key: 'email', dir: 'asc'}, 'email')).toEqual({key: 'email', dir: 'desc'});
    expect(nextSort(null, 'email')).toEqual({key: 'email', dir: 'asc'});
    expect(nextSort({key: 'total', dir: 'desc'}, 'total')).toEqual({key: 'total', dir: 'asc'});
  });
});

describe('schedule lines from /api/metrics', () => {
  const base: CrmMetrics = {customers: 0, orders: 0, totalRevenue: 0, ordersLast7Days: 0, revenueLast7Days: 0, abandonedActive: 0, recovered: 0, reminded: 0, revenueRecovered: 0, recoveryRate: 0};

  it("fmtMinutes is Vince's: minutes, hours, days", () => {
    expect(fmtMinutes(1)).toBe('1 minute');
    expect(fmtMinutes(30)).toBe('30 minutes');
    expect(fmtMinutes(60)).toBe('1 hour');
    expect(fmtMinutes(180)).toBe('3 hours');
    expect(fmtMinutes(1440)).toBe('1 day');
    expect(fmtMinutes(10080)).toBe('7 days');
  });

  it('reads the CRM steps and paused flag; no steps = no line', () => {
    expect(reminderSchedule({...base, reminderSteps: [60]})).toBe('Reminder: sent 1 hour after abandonment');
    expect(reminderSchedule({...base, reminderSteps: [60, 1440], remindersEnabled: false})).toBe('Reminder: sent 1 hour, then 1 day after abandonment · paused');
    expect(reminderSchedule({...base, reminderSteps: []})).toBeNull();
    expect(reminderSchedule(base)).toBeNull();
    expect(reminderSchedule(null)).toBeNull();
  });

  it('review line: N after fulfillment, paused when the CRM says so; absent = no line', () => {
    expect(reviewSchedule({...base, reviewAfterMinutes: 10080})).toBe('Review email: sent 7 days after fulfillment');
    expect(reviewSchedule({...base, reviewAfterMinutes: 4320, reviewEmailsEnabled: false})).toBe('Review email: sent 3 days after fulfillment · paused');
    expect(reviewSchedule(base)).toBeNull();
  });

  it('"n of N" only when the CRM gave N; never a made-up total', () => {
    expect(remindersOf(1, 1)).toBe('1 of 1');
    expect(remindersOf(0, 3)).toBe('0 of 3');
    expect(remindersOf(2, undefined)).toBe('2');
  });
});

describe('Pet birthdays rows', () => {
  const vouchers = [{email: 'SENT@example.com', year: 2026, tier: 'gold', sentAt: '2026-03-01T00:00:00Z'}];

  it('one row per customer with a pet; next birthday in PH days; this year voucher status and when it was sent', () => {
    const rows = petRows(
      [
        row('sent', {petName: 'Mochi', petBirthday: '2020-03-04', email: 'sent@example.com'}),
        row('soon', {petName: 'Bao', petBirthday: '2021-11-20'}),
        row('gone', {petName: null, petBirthday: '2019-01-05'}),
        row('nopet'),
      ],
      vouchers,
      NOW,
    );
    expect(rows.map((r) => [r.shopifyCustomerId, r.petName, r.nextDays, r.status, r.sentAt])).toEqual([
      ['sent', 'Mochi', daysToPetBirthday('2020-03-04', NOW), 'Sent', '2026-03-01T00:00:00Z'],
      ['soon', 'Bao', 8, 'Upcoming', null],
      ['gone', null, daysToPetBirthday('2019-01-05', NOW), 'Passed', null],
    ]);
  });

  it('voucher ledger unread → status unknown (null), never "Passed"', () => {
    expect(petRows([row('a', {petBirthday: '2019-01-05'})], null, NOW)[0].status).toBeNull();
  });

  it('daysToPetBirthday: today is 0, a passed day rolls to next year, junk is null', () => {
    expect(daysToPetBirthday('2020-11-12', NOW)).toBe(0);
    expect(daysToPetBirthday('2020-11-11', NOW)).toBe(364);
    expect(daysToPetBirthday('soon', NOW)).toBeNull();
  });

  it('sorts by next birthday, soonest first, no birthday last', () => {
    const rows = petRows([row('a', {petBirthday: '2020-12-01'}), row('b', {petName: 'x'}), row('c', {petBirthday: '2020-11-13'})], [], NOW);
    expect(sortRows(rows, {key: 'next', dir: 'asc'}, PET_SORT).map((r) => r.shopifyCustomerId)).toEqual(['c', 'a', 'b']);
  });
});

describe("CSV exports with Vince's summary header", () => {
  it('csvSummary: title with the as-of stamp, the filters note, the counts, then a blank line', () => {
    expect(csvSummary('orders', 'Nov 12, 2026, 12:00 PM', 'Payment=paid', [['Rows in export', 2]])).toEqual([
      ['orders (as of Nov 12, 2026, 12:00 PM)'],
      ['Note: the summary and rows below reflect the current filters (Payment=paid), not the whole store.'],
      ['Rows in export', '2'],
      [],
    ]);
  });

  it('filterNote names each narrowed filter and the search; none when nothing is narrowed', () => {
    expect(filterNote([['Progress', 'Email'], ['Status', 'all']], ' ana ')).toBe('Progress=Email; Search=ana');
    expect(filterNote([['Status', 'all']], '')).toBe('none');
  });

  it('cart summary counts what was exported; the recovery link is never in the file', () => {
    const rows = [
      cart('a'),
      cart('b', {convertedAt: '2026-11-02T00:00:00Z', remindersSent: 1, totalPrice: '250.50'}),
      cart('c', {convertedAt: '2026-11-02T00:00:00Z'}),
      cart('d', {remindersSent: 1}),
    ];
    expect(cartSummary(rows)).toEqual([
      ['Rows in export', 4],
      ['Abandoned (active)', 2],
      ['Recovered (via reminder)', 1],
      ['Reminded', 2],
      ['Recovery rate', '50%'],
      ['Revenue recovered', '250.50'],
    ]);
    const csv = cartCsv(rows, 'now', 'none', 1);
    expect(JSON.stringify(csv)).not.toMatch(/SECRET|recover\?key|https?:/);
    expect(csv[9]).toEqual(['Email', 'Cart value', 'Items', 'Progress', 'Status', 'Reminders sent', 'Last reminder (PH time)', 'Reminder (RETURN30)', 'Abandoned (PH time)']);
    expect(csv[10][5]).toBe('0 of 1');
  });

  it('order summary: paid revenue leaves Shopify test orders out and says how many are in the export', () => {
    const csv = orderCsv([order('1'), order('2', {test: true}), order('3', {financialStatus: 'pending'})], 'now', 'none');
    expect(csv.slice(2, 5)).toEqual([['Rows in export', '3'], ['Paid revenue (test orders excluded)', '500.00'], ['Shopify test orders in export', '1']]);
    expect(csv[6]).toContain('Review sent (PH time)');
  });

  it('customer summary: tiers and the threshold; To Platinum is the pesos left for Gold, Qualified for Platinum', () => {
    const csv = customerCsv([row('p', {membershipTier: 'platinum'}), row('g', {spendYtd: 500}), row('x', {membershipTier: null})], 'now', 'none', 2000, 'crm-customers');
    expect(csv.slice(2, 7)).toEqual([['Rows in export', '3'], ['Platinum threshold (PHP/year)', '2000.00'], ['Platinum', '1'], ['Gold', '1'], ['Guest', '1']]);
    const header = csv[9];
    const at = header.indexOf('To Platinum');
    expect([csv[10][at], csv[11][at], csv[12][at]]).toEqual(['Qualified', '1500.00', '']);
    expect(header).toContain('Member since (PH)');
  });

  it('pet summary counts each status; no voucher code column', () => {
    const rows = petRows([row('a', {petBirthday: '2020-12-01'}), row('b', {petBirthday: '2020-01-01'})], [], NOW);
    const csv = petCsv(rows, 'now', 'none', 2026);
    expect(csv.slice(2, 6)).toEqual([['Rows in export', '2'], ['Sent this year', '0'], ['Upcoming', '1'], ['Passed', '1']]);
    expect(csv[7].join(',')).not.toMatch(/code/i);
  });
});
