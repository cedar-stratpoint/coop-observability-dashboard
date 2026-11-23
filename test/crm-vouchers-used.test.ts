// RET-11 (Stage 8D, plan knowledge/tasks/2026-11-23-customer-vouchers-used-8d.md): the discount codes a customer redeemed. projectOrder
// keeps the amount off per code; customerVouchers lists every code on a counted order, newest first; a BDAY- code never shows (it names
// one person); orders not read = null ("unknown", never 0). The Customers table sorts by uses (most first) and the CSV lists the codes.
import {describe, expect, it} from 'vitest';
import {customerVouchers, voucherLabels, voucherUseText, type CustomerRow} from '../src/crm-compute';
import {projectOrder} from '../src/crm-project';
import {CUSTOMER_SORT, customerCsv, nextSort, sortRows} from '../src/crm-table';
import type {CrmOrder} from '../src/crm-types';

const order = (id: string, over: Partial<CrmOrder> = {}): CrmOrder => ({
  shopifyOrderId: id, shopifyCustomerId: 'c1', orderNumber: `#${id}`, email: 'rico@example.com', totalPrice: '500.00', currency: 'PHP',
  financialStatus: 'paid', fulfillmentStatus: null, createdAt: '2026-11-01T00:00:00Z', fulfilledAt: null, reviewRequestSentAt: null,
  reviewSubmittedAt: null, test: false, discountCodes: [], discountAmounts: [], lineItems: null, ...over,
});
const rico = {shopifyCustomerId: 'c1', email: 'rico@example.com'};
const row = (id: string, over: Partial<CustomerRow> = {}): CustomerRow => ({
  shopifyCustomerId: id, email: `${id}@example.com`, firstName: id, lastName: null, phone: null, ordersCount: null, totalSpent: null,
  membershipTier: 'gold', petName: null, petBirthday: null, emailMarketingState: null, createdAt: '2026-07-02T00:00:00Z', updatedAt: null,
  orderCount: 0, spent: 0, spendYtd: 0, firstOrderAt: null, lastOrderAt: null, firstOrderCode: null, codesUsed: null, daysSinceLastOrder: null,
  emailsSent: 0, manualContacts: 0, timesContacted: 0, lastContactedAt: null, lastContactKind: null, lastContactKnown: true, daysSinceLastContact: null,
  consent: 'unknown', ...over,
});

describe('projectOrder keeps the amount per code', () => {
  it('amounts sit index for index with the codes; a junk entry drops from both', () => {
    const o = projectOrder({
      shopifyOrderId: 1,
      raw: JSON.stringify({discount_codes: [{code: ' return30 ', amount: '30.00', type: 'fixed_amount'}, {code: ''}, {code: 'WEB50'}, {code: 'X', amount: 'n/a'}]}),
    });
    expect(o.discountCodes).toEqual(['RETURN30', 'WEB50', 'X']);
    expect(o.discountAmounts).toEqual([30, null, null]);
  });

  it('a BDAY- code is still cut to its prefix; its amount is kept, the full code is nowhere', () => {
    const o = projectOrder({shopifyOrderId: 1, raw: {discount_codes: [{code: 'BDAY-KIKO-26', amount: '100.00'}]}});
    expect(o.discountCodes).toEqual(['BDAY-']);
    expect(o.discountAmounts).toEqual([100]);
    expect(JSON.stringify(o)).not.toContain('KIKO');
  });

  it('no discount_codes = no codes, no amounts', () => {
    expect(projectOrder({shopifyOrderId: 1, raw: {}}).discountAmounts).toEqual([]);
  });
});

describe('customerVouchers', () => {
  const orders = [
    order('1031', {createdAt: '2026-02-12T02:00:00Z', discountCodes: ['WELCOME10'], discountAmounts: [50]}),
    order('1122', {createdAt: '2026-06-15T02:00:00Z', discountCodes: ['BDAY-'], discountAmounts: [100]}),
    order('1140', {createdAt: '2026-07-19T02:00:00Z', discountCodes: ['RETURN30', 'FREESHIP'], discountAmounts: [30, null]}),
    order('1150', {createdAt: '2026-08-01T02:00:00Z', discountCodes: ['TESTCODE'], discountAmounts: [10], test: true}),
    order('1201', {createdAt: '2026-09-28T02:00:00Z'}),
    order('9999', {shopifyCustomerId: 'other', email: 'jen@example.com', discountCodes: ['RETURN30'], discountAmounts: [30]}),
  ];

  it('newest first, one entry per code; several codes on one order keep their order; the test order and no-code orders are left out', () => {
    const got = customerVouchers(rico, orders);
    expect(got?.map((v) => [v.label, v.orderNumber])).toEqual([
      ['RETURN30', '#1140'],
      ['FREESHIP', '#1140'],
      ['Birthday voucher', '#1122'],
      ['WELCOME10', '#1031'],
    ]);
    expect(got?.[0]).toEqual({label: 'RETURN30', orderNumber: '#1140', orderId: '1140', at: '2026-07-19T02:00:00Z', amount: 30});
    expect(got?.[1].amount).toBeNull();
  });

  it('a BDAY- code reads "Birthday voucher" and no BDAY code appears anywhere in the output', () => {
    const got = customerVouchers(rico, orders);
    expect(JSON.stringify(got)).not.toMatch(/BDAY/i);
    expect(got?.map(voucherUseText).join(' ')).not.toMatch(/BDAY/i);
  });

  it('no codes on any order = [] (known, none); orders not read = null (unknown, never 0)', () => {
    expect(customerVouchers(rico, [order('1', {discountCodes: []}), order('2', {discountCodes: undefined})])).toEqual([]);
    expect(customerVouchers(rico, [])).toEqual([]);
    expect(customerVouchers(rico, null)).toBeNull();
  });

  it('orders matched by email when the order carries no customer id (customerOrders)', () => {
    const got = customerVouchers({shopifyCustomerId: 'nope', email: 'Rico@Example.com'}, [order('7', {shopifyCustomerId: null, discountCodes: ['WEB50'], discountAmounts: [50]})]);
    expect(got?.map((v) => v.label)).toEqual(['WEB50']);
  });

  it('one line per use: code · order · PH date · amount saved (no amount when unknown)', () => {
    const [a, b] = customerVouchers(rico, orders) ?? [];
    expect(voucherUseText(a)).toBe('RETURN30 · order #1140 · Jul 19, 2026 · ₱30.00 saved');
    expect(voucherUseText(b)).toBe('FREESHIP · order #1140 · Jul 19, 2026');
    expect(voucherUseText({...a, orderNumber: '1140'})).toContain('order #1140');
  });

  it('labels deduplicated, most used first, each with its uses', () => {
    const uses = customerVouchers(rico, [
      order('1', {createdAt: '2026-03-01T00:00:00Z', discountCodes: ['RETURN30'], discountAmounts: [30]}),
      order('2', {createdAt: '2026-04-01T00:00:00Z', discountCodes: ['WELCOME10'], discountAmounts: [50]}),
      order('3', {createdAt: '2026-05-01T00:00:00Z', discountCodes: ['RETURN30'], discountAmounts: [30]}),
    ]) ?? [];
    expect(voucherLabels(uses).map((v) => [v.label, v.uses.length])).toEqual([['RETURN30', 2], ['WELCOME10', 1]]);
  });
});

describe('Customers table: Vouchers used sort and CSV', () => {
  const use = (label: string) => ({label, orderNumber: '#1', orderId: '1', at: null, amount: null});
  const people = [
    row('one', {vouchers: [use('A')]}),
    row('unknown', {vouchers: null}),
    row('none', {vouchers: []}),
    row('three', {vouchers: [use('A'), use('B'), use('A')]}),
  ];

  it('first click = most uses first; unknown sorts last both ways', () => {
    const first = nextSort(null, 'vouchers');
    expect(first).toEqual({key: 'vouchers', dir: 'desc'});
    expect(sortRows(people, first, CUSTOMER_SORT).map((r) => r.shopifyCustomerId)).toEqual(['three', 'one', 'none', 'unknown']);
    expect(sortRows(people, nextSort(first, 'vouchers'), CUSTOMER_SORT).map((r) => r.shopifyCustomerId)).toEqual(['none', 'one', 'three', 'unknown']);
  });

  it('CSV "Vouchers used" right after Orders: labels joined with "; ", blank when none, "unknown" when not read', () => {
    const csv = customerCsv(people, 'now', 'none', 2000, 'crm-customers');
    const header = csv[9];
    const at = header.indexOf('Vouchers used');
    expect(header[at - 1]).toBe('Orders');
    expect(csv.slice(10).map((r) => r[at])).toEqual(['A', 'unknown', '', 'A; B']);
    // Tier, To Platinum and Spend (year) stay in the CSV (hidden on the table only).
    expect(header).toEqual(expect.arrayContaining(['Tier', 'To Platinum', 'Spend this membership year']));
  });
});
