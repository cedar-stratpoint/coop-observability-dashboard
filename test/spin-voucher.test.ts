import {describe, expect, it} from 'vitest';
import {toCsv} from '../src/csv';
import {isVoucherPrize} from '../src/spin-leads-sync';
import {spinVoucherCsv, spinVoucherOrderAt, spinVoucherState} from '../src/spin-voucher';
import type {SpinLead} from '../src/spin-leads-types';

const SPUN = '2026-10-10T10:00:00+08:00';
const lead = (o: Partial<SpinLead> = {}): SpinLead => ({email: 'a@x.com', instagram: null, name: 'Ana', pet: null, picky: null, mobile: '0917', prize: '35% Off', campaign: 'ev', collectedAt: SPUN, ...o});
const order = (o: Record<string, unknown> = {}) => ({email: 'a@x.com', createdAt: '2026-10-12T10:00:00+08:00', test: false, ...o});

describe('spinVoucherState', () => {
  it('voucher + no order -> not_used', () => expect(spinVoucherState(lead(), [])).toBe('not_used'));
  it('order 1 minute after the spin -> ordered, with its date', () => {
    const o = order({createdAt: '2026-10-10T10:01:00+08:00'});
    expect(spinVoucherState(lead(), [o])).toBe('ordered');
    expect(spinVoucherOrderAt(lead(), [order(), o])).toBe(o.createdAt);
  });
  it('order before the spin -> not_used', () => expect(spinVoucherState(lead(), [order({createdAt: '2026-10-09T10:00:00+08:00'})])).toBe('not_used'));
  it('a test order never counts', () => expect(spinVoucherState(lead(), [order({test: true})])).toBe('not_used'));
  it('email case and spaces match', () => expect(spinVoucherState(lead({email: ' A@X.com '}), [order({email: 'a@x.COM'})])).toBe('ordered'));
  it('an item prize is not a voucher', () => expect(spinVoucherState(lead({prize: 'Poop Bag'}), [])).toBe('not_voucher'));
  it('an unknown raw prize id is not a voucher', () => expect(spinVoucherState(lead({prize: 'mystery-box'}), [])).toBe('not_voucher'));
  it('Instagram-only -> no_email, never not_used', () => expect(spinVoucherState(lead({email: null, instagram: 'kyl'}), [])).toBe('no_email'));
  it('orders unread -> null (unknown)', () => expect(spinVoucherState(lead(), null)).toBeNull());
  it('the four voucher labels', () => {
    for (const p of ['₱300 Off', '30% Off', '35% Off', 'Free Shipping']) expect(isVoucherPrize(p)).toBe(true);
    expect(isVoucherPrize('Free Zoomy! Item')).toBe(false);
  });
});

describe('spinVoucherCsv', () => {
  it('has no voucher code and no recovery link', () => {
    const text = toCsv(spinVoucherCsv([{lead: lead(), state: 'not_used', orderAt: null, lastContactAt: null}], '2026-11-23T00:00:00Z'));
    expect(text).toContain('a@x.com');
    expect(text).toContain('35% Off');
    expect(text).not.toMatch(/GRAND|BDAY-|recover|https?:/i);
  });
});
