// RET-08 slice 8C (plan knowledge/tasks/2026-11-12-customer-profile-stage8.md): one customer's communication timeline, built
// client-side from the lists the Website CRM page already reads. Owner rules: newest first; a test order is shown (tagged) but its
// review request is never a counted contact; cart reminders are ONE event "×N" dated by the last reminder (the CRM keeps only that
// date); the timeline's contact events use 7A's ContactKind names, so the newest one IS customerRows' last contacted.
import {describe, expect, it} from 'vitest';
import {
  contactTally,
  customerOrders,
  customerRows,
  customerTimeline,
  enrichCustomers,
  petBirthdayStatus,
  toPlatinum,
  type TimelineEvent,
} from '../src/crm-compute';
import type {CrmCheckout, CrmCustomer, CrmOrder} from '../src/crm-types';
import type {CustomerContact} from '../src/customer-contacts';

const NOW = new Date('2026-11-12T04:00:00Z');

const CUSTOMER: CrmCustomer = {
  shopifyCustomerId: 'c1', email: 'Ana@Example.com', firstName: 'Ana', lastName: 'Cruz', phone: null, ordersCount: null, totalSpent: null,
  membershipTier: 'gold', petName: 'Mochi', petBirthday: '2020-05-01', emailMarketingState: 'subscribed', createdAt: '2026-07-02T02:00:00Z', updatedAt: null,
};
const order = (id: string, over: Partial<CrmOrder> = {}): CrmOrder => ({
  shopifyOrderId: id, shopifyCustomerId: 'c1', orderNumber: `#${id}`, email: 'ana@example.com', totalPrice: '500.00', currency: 'PHP',
  financialStatus: 'paid', fulfillmentStatus: null, createdAt: null, fulfilledAt: null, reviewRequestSentAt: null, reviewSubmittedAt: null,
  test: false, discountCodes: [], lineItems: null, ...over,
});
const checkout = (id: string, over: Partial<CrmCheckout> = {}): CrmCheckout => ({
  shopifyCheckoutId: id, email: 'ana@example.com', abandonedCheckoutUrl: 'https://shop.example/recover', totalPrice: '899.00', currency: 'PHP',
  createdAt: null, updatedAt: null, convertedAt: null, remindersSent: 0, lastReminderAt: null, reachedPaymentAt: null, winbackSentAt: null,
  stage: 'Shipping', ...over,
});

const ORDERS: CrmOrder[] = [
  order('1001', {
    createdAt: '2026-08-01T02:00:00Z', fulfilledAt: '2026-08-02T03:00:00Z', reviewRequestSentAt: '2026-08-09T02:00:00Z',
    reviewSubmittedAt: '2026-08-10T02:00:00Z', discountCodes: ['WELCOME10'],
    lineItems: JSON.stringify([{title: 'Salmon treats', quantity: 2, price: '250.00'}]),
  }),
  // A Shopify test order: shown, tagged, its review request is not a contact.
  order('1002', {createdAt: '2026-09-01T02:00:00Z', reviewRequestSentAt: '2026-09-08T02:00:00Z', test: true}),
  // Somebody else's order never appears.
  order('2001', {shopifyCustomerId: 'c2', email: 'ben@example.com', createdAt: '2026-10-01T02:00:00Z'}),
];
const CHECKOUTS: CrmCheckout[] = [
  checkout('k1', {createdAt: '2026-09-20T02:00:00Z', remindersSent: 2, lastReminderAt: '2026-09-22T02:00:00Z', winbackSentAt: '2026-09-25T02:00:00Z'}),
  checkout('k2', {createdAt: '2026-10-05T02:00:00Z', convertedAt: '2026-10-06T02:00:00Z', stage: 'Payment'}),
  checkout('k3', {email: 'ben@example.com', createdAt: '2026-10-05T02:00:00Z', remindersSent: 1, lastReminderAt: '2026-10-06T02:00:00Z'}),
];
const VOUCHERS = [{email: 'ana@example.com', year: 2026, tier: 'gold', sentAt: '2026-05-01T00:00:00Z'}];
const MANUAL: CustomerContact[] = [
  {id: 'm1', email: 'ana@example.com', channel: 'sms', note: 'asked about salmon', contactedAt: '2026-10-20T02:00:00Z', createdBy: 'team@example.com'},
  {id: 'm2', email: 'ben@example.com', channel: 'call', note: null, contactedAt: '2026-10-21T02:00:00Z', createdBy: 'team@example.com'},
];
const SRC = {orders: ORDERS, checkouts: CHECKOUTS, birthdayVouchers: VOUCHERS, manualContacts: MANUAL};
const tl = (src: Partial<typeof SRC> = {}): TimelineEvent[] => customerTimeline(CUSTOMER, {...SRC, ...src});

describe('8C customerTimeline', () => {
  it('lists every event kind for this customer only, newest first', () => {
    expect(tl().map((e) => [e.kind, e.at])).toEqual([
      ['sms', '2026-10-20T02:00:00Z'],
      ['checkout_abandoned', '2026-10-05T02:00:00Z'],
      ['winback', '2026-09-25T02:00:00Z'],
      ['reminder', '2026-09-22T02:00:00Z'],
      ['checkout_abandoned', '2026-09-20T02:00:00Z'],
      ['review_request', '2026-09-08T02:00:00Z'],
      ['order_placed', '2026-09-01T02:00:00Z'],
      ['review_submitted', '2026-08-10T02:00:00Z'],
      ['review_request', '2026-08-09T02:00:00Z'],
      ['order_fulfilled', '2026-08-02T03:00:00Z'],
      ['order_placed', '2026-08-01T02:00:00Z'],
      ['account_created', '2026-07-02T02:00:00Z'],
      ['birthday_voucher', '2026-05-01T00:00:00Z'],
    ]);
  });

  it('an order carries its number, total, items and codes; fulfilment carries the turnaround', () => {
    const placed = tl().find((e) => e.kind === 'order_placed' && e.orderId === '1001');
    expect(placed).toMatchObject({group: 'orders', orderNumber: '#1001', total: '500.00', codes: ['WELCOME10'], test: false, contact: false});
    expect(placed?.items).toEqual([{title: 'Salmon treats', quantity: 2, unitPrice: 250}]);
    expect(tl().find((e) => e.kind === 'order_fulfilled')).toMatchObject({orderId: '1001', turnaround: '1d 1h 0m'});
  });

  it("a test order is shown and tagged, and its review request is not a counted contact", () => {
    const testEvents = tl().filter((e) => e.orderId === '1002');
    expect(testEvents.map((e) => e.kind)).toEqual(['review_request', 'order_placed']);
    expect(testEvents.every((e) => e.test && !e.contact && e.count === 0)).toBe(true);
    const real = tl().find((e) => e.kind === 'review_request' && e.orderId === '1001');
    expect(real).toMatchObject({contact: true, count: 1, group: 'emails', test: false});
  });

  it('cart reminders are ONE event ×N dated by the last reminder, flagged as last-date-only', () => {
    const r = tl().filter((e) => e.kind === 'reminder');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({count: 2, at: '2026-09-22T02:00:00Z', checkoutId: 'k1', lastDateOnly: true, contact: true, group: 'emails'});
  });

  it('an abandoned checkout carries value, stage and status; only an open one carries the recovery link', () => {
    const [k2, k1] = tl().filter((e) => e.kind === 'checkout_abandoned');
    expect(k1).toMatchObject({group: 'checkouts', checkoutId: 'k1', total: '899.00', stage: 'Shipping', status: 'Active', recoveryUrl: 'https://shop.example/recover'});
    expect(k2).toMatchObject({checkoutId: 'k2', stage: 'Payment', status: 'Converted', recoveryUrl: null});
  });

  it('a manual contact carries channel, note and who logged it', () => {
    expect(tl()[0]).toMatchObject({kind: 'sms', group: 'manual', note: 'asked about salmon', by: 'team@example.com', contact: true, count: 1});
  });

  it('undated events stay listed, after the dated ones', () => {
    const e = customerTimeline(CUSTOMER, {orders: [], checkouts: [checkout('k9', {remindersSent: 1})], birthdayVouchers: [], manualContacts: []});
    expect(e.map((x) => [x.kind, x.at])).toEqual([['account_created', '2026-07-02T02:00:00Z'], ['checkout_abandoned', null], ['reminder', null]]);
  });

  it('agrees with 7A: the newest contact event is last contacted, and the contact counts sum to times contacted', () => {
    const enriched = enrichCustomers([CUSTOMER], ORDERS, '2026-01-01');
    const tally = contactTally({checkouts: CHECKOUTS, orders: ORDERS, birthdayVouchers: VOUCHERS, manualContacts: MANUAL});
    const [row] = customerRows(enriched, tally, NOW, {automated: true, manual: true});
    const contacts = tl().filter((e) => e.contact);
    expect([contacts[0].at, contacts[0].kind]).toEqual([row.lastContactedAt, row.lastContactKind]);
    expect(contacts.reduce((s, e) => s + e.count, 0)).toBe(row.timesContacted);
  });

  it('a logged contact appears at the top', () => {
    const logged: CustomerContact = {id: 'm3', email: 'ana@example.com', channel: 'dm', note: null, contactedAt: '2026-11-12T01:00:00Z', createdBy: 'me@example.com'};
    expect(tl({manualContacts: [logged, ...MANUAL]})[0]).toMatchObject({kind: 'dm', id: 'manual:m3'});
  });
});

describe('8B helpers', () => {
  it('customerOrders: matched by customer id, else by email (as enrichCustomers), newest first, test orders kept', () => {
    expect(customerOrders(CUSTOMER, ORDERS).map((o) => o.shopifyOrderId)).toEqual(['1002', '1001']);
    const guest = {...CUSTOMER, shopifyCustomerId: 'g9', email: 'ben@example.com'};
    expect(customerOrders(guest, [order('3001', {shopifyCustomerId: null, email: 'BEN@example.com'})]).map((o) => o.shopifyOrderId)).toEqual(['3001']);
  });

  it('toPlatinum: share of the threshold and what is left, capped at 100%', () => {
    expect(toPlatinum(500, 2000)).toEqual({pct: 25, left: 1500});
    expect(toPlatinum(2500, 2000)).toEqual({pct: 100, left: 0});
    expect(toPlatinum(100, 0)).toEqual({pct: 100, left: 0});
  });

  it("petBirthdayStatus: this year's voucher Sent, else Upcoming / Passed by the PH day; null without a birthday", () => {
    expect(petBirthdayStatus(CUSTOMER, VOUCHERS, NOW)).toBe('Sent');
    expect(petBirthdayStatus(CUSTOMER, [], NOW)).toBe('Passed');
    expect(petBirthdayStatus({...CUSTOMER, petBirthday: '2021-12-24'}, [], NOW)).toBe('Upcoming');
    expect(petBirthdayStatus({...CUSTOMER, petBirthday: '2021-11-12'}, [], NOW)).toBe('Upcoming');
    expect(petBirthdayStatus({...CUSTOMER, petBirthday: null}, [], NOW)).toBeNull();
    expect(petBirthdayStatus(CUSTOMER, [{email: 'ana@example.com', year: 2025}], NOW)).toBe('Passed');
  });
});
