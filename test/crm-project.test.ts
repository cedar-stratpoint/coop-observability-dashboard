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

  it('metrics: ten numbers, junk is 0, extra keys dropped; membership falls back field by field', () => {
    const m = projectMetrics({customers: '3', orders: 3, totalRevenue: 'x', ordersLast7Days: 1, revenueLast7Days: 700.5, abandonedActive: 2, recovered: 1, reminded: 3, revenueRecovered: 400, recoveryRate: 33.3, token: 'SECRET'});
    expect(m).toEqual({customers: 3, orders: 3, totalRevenue: 0, ordersLast7Days: 1, revenueLast7Days: 700.5, abandonedActive: 2, recovered: 1, reminded: 3, revenueRecovered: 400, recoveryRate: 33.3});
    expect(projectMembership({platinumThreshold: null, programStart: '2026-08-01'})).toEqual({platinumThreshold: MEMBERSHIP_FALLBACK.platinumThreshold, programStart: '2026-08-01'});
    expect(projectMembership('junk')).toEqual(MEMBERSHIP_FALLBACK);
  });
});
