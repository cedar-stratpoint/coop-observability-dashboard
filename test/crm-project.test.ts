import {describe, expect, it} from 'vitest';
import {envelope, MEMBERSHIP_FALLBACK, projectCheckoutSafe, projectCustomer, projectMembership, projectMetrics, projectOrder} from '../src/crm-project';

describe('CRM field contract (spec 4.4): an allowlist, so hidden and future fields never pass', () => {
  it('envelope reads {key: [...]}, {data: [...]} and a bare array; anything else is null', () => {
    expect(envelope({orders: [{a: 1}]}, 'orders')).toEqual([{a: 1}]);
    expect(envelope({data: [{a: 1}]}, 'orders')).toEqual([{a: 1}]);
    expect(envelope([{a: 1}, null, 3, [1]], 'orders')).toEqual([{a: 1}]);
    expect(envelope({orders: 'x'}, 'orders')).toBeNull();
    expect(envelope('nope', 'orders')).toBeNull();
  });

  it('a checkout loses abandonedCheckoutUrl, raw and unknown fields; raw is reduced to the stage first', () => {
    const c = projectCheckoutSafe({
      shopifyCheckoutId: 7, email: 'dee@example.com', abandonedCheckoutUrl: 'https://zoomy.example/checkouts/SECRET-RECOVERY',
      totalPrice: '850', currency: 'PHP', createdAt: '2026-09-29T04:00:00Z', updatedAt: null, convertedAt: null, remindersSent: '2',
      lastReminderAt: null, reachedPaymentAt: null, winbackSentAt: null, recoveryUrl: 'https://x/SECRET-FUTURE',
      raw: JSON.stringify({shipping_address: {address1: 'SECRET-RAW-ADDRESS'}}),
    });
    expect(c).toEqual({
      shopifyCheckoutId: '7', email: 'dee@example.com', totalPrice: '850', currency: 'PHP', createdAt: '2026-09-29T04:00:00Z', updatedAt: null,
      convertedAt: null, remindersSent: 2, lastReminderAt: null, reachedPaymentAt: null, winbackSentAt: null, stage: 'Shipping',
    });
    expect(JSON.stringify(c)).not.toMatch(/SECRET/);
  });

  it('a customer keeps contacts (owner decision) and drops unknown fields; non-strings become null', () => {
    const c = projectCustomer({shopifyCustomerId: 'c1', email: 'ana@example.com', firstName: 'Ana', lastName: 42, phone: '+639170000001', ordersCount: '3', totalSpent: '99.5', membershipTier: 'gold', petName: 'Mochi', petBirthday: '2020-05-01', emailMarketingState: 'subscribed', createdAt: '2026-07-02T02:00:00Z', updatedAt: null, apiKey: 'sk-SECRET'});
    expect(c).toEqual({shopifyCustomerId: 'c1', email: 'ana@example.com', firstName: 'Ana', lastName: '42', phone: '+639170000001', ordersCount: 3, totalSpent: '99.5', membershipTier: 'gold', petName: 'Mochi', petBirthday: '2020-05-01', emailMarketingState: 'subscribed', createdAt: '2026-07-02T02:00:00Z', updatedAt: null});
  });

  it('an order keeps line items as a string (an array is serialised) and drops unknown fields', () => {
    const o = projectOrder({shopifyOrderId: 1, orderNumber: '#1001', email: 'a@b.c', totalPrice: '1000.00', financialStatus: 'paid', createdAt: '2026-09-30T15:59:00Z', lineItems: [{title: 'A', quantity: 2}], discountCode: 'SECRET-CODE'});
    expect(o.lineItems).toBe('[{"title":"A","quantity":2}]');
    expect(o.shopifyOrderId).toBe('1');
    expect(JSON.stringify(o)).not.toMatch(/SECRET/);
  });

  it('an order keeps /api/orders lines=1 line items as price and quantity only (no titles, SKUs or buyer data); string prices are read', () => {
    const o = projectOrder({shopifyOrderId: 2, createdAt: '2026-09-30T15:59:00Z', lines: [{sku: 'SKU-SECRET', title: 'Treats', price: '250.00', quantity: 2, discount: 10}, {price: null, quantity: 0}, 'junk']});
    expect(o.lines).toEqual([{price: 250, quantity: 2}, {price: null, quantity: 0}, {price: null, quantity: null}]);
    expect(JSON.stringify(o)).not.toMatch(/SECRET|Treats/);
  });
  it('an order without a lines array has no lines key (a legacy Worker, or a read that did not ask)', () => {
    expect(projectOrder({shopifyOrderId: 3}).lines).toBeUndefined();
    expect(projectOrder({shopifyOrderId: 3, lines: 'x'}).lines).toBeUndefined();
  });

  it('metrics: ten numbers, junk is 0, extra keys dropped; membership falls back field by field', () => {
    const m = projectMetrics({customers: '3', orders: 3, totalRevenue: 'x', ordersLast7Days: 1, revenueLast7Days: 700.5, abandonedActive: 2, recovered: 1, reminded: 3, revenueRecovered: 400, recoveryRate: 33.3, token: 'SECRET'});
    expect(m).toEqual({customers: 3, orders: 3, totalRevenue: 0, ordersLast7Days: 1, revenueLast7Days: 700.5, abandonedActive: 2, recovered: 1, reminded: 3, revenueRecovered: 400, recoveryRate: 33.3});
    expect(projectMembership({platinumThreshold: null, programStart: '2026-08-01'})).toEqual({platinumThreshold: MEMBERSHIP_FALLBACK.platinumThreshold, programStart: '2026-08-01'});
    expect(projectMembership('junk')).toEqual(MEMBERSHIP_FALLBACK);
  });

  it('RET-09: metrics keep the CRM schedule settings when sent, typed strictly; absent or junk = no key (the page hides the line)', () => {
    const m = projectMetrics({reminderStepCount: '1', reminderSteps: [60, '1440', 'x', -5], remindersEnabled: false, reviewAfterMinutes: 10080, reviewEmailsEnabled: true, birthdayCodes: ['SECRET']});
    expect(m).toMatchObject({reminderStepCount: 1, reminderSteps: [60, 1440], remindersEnabled: false, reviewAfterMinutes: 10080, reviewEmailsEnabled: true});
    expect(JSON.stringify(m)).not.toMatch(/SECRET/);
    const none = projectMetrics({reminderStepCount: 'x', reminderSteps: 'x', remindersEnabled: 'no', reviewAfterMinutes: null});
    for (const k of ['reminderStepCount', 'reminderSteps', 'remindersEnabled', 'reviewAfterMinutes', 'reviewEmailsEnabled']) expect(k in none).toBe(false);
  });

  it('RET-09: a checkout keeps how many line items it has (a count only, Vince\'s Items column); no list = no key', () => {
    const c = projectCheckoutSafe({shopifyCheckoutId: 1, lineItems: JSON.stringify([{title: 'SECRET-TITLE', quantity: 2}, {title: 'B', quantity: 1}])});
    expect(c.items).toBe(2);
    expect(JSON.stringify(c)).not.toMatch(/SECRET/);
    expect(projectCheckoutSafe({shopifyCheckoutId: 1, lineItems: [{a: 1}]}).items).toBe(1);
    expect('items' in projectCheckoutSafe({shopifyCheckoutId: 1})).toBe(false);
    expect('items' in projectCheckoutSafe({shopifyCheckoutId: 1, lineItems: 'junk'})).toBe(false);
  });
});
