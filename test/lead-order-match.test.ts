import {describe, expect, it} from 'vitest';
import type {PosOrder} from '../src/pos-sales-types';
import type {SpinLead} from '../src/spin-leads-types';
import {addDays, followUpMessage, leadKey, matchLeadsToOrders, petName, treatPhrase} from '../src/lead-order-match';

const lead = (over: Partial<SpinLead> = {}): SpinLead => ({
  email: null, instagram: 'buddy.riley.bailey', pet: 'Bailey / Malshipoo', name: null, picky: null, mobile: null,
  prize: 'Zoomy! Bandana', campaign: null, collectedAt: '2026-09-24T20:45:00+08:00', ...over,
});
const order = (over: Partial<PosOrder> = {}): PosOrder => ({
  id: 'o1', client_uuid: 'u1', subtotal: 200, discount: null, total: 200, oversold: false, device_id: null,
  payment_method: 'cash', customer_handle: null, status: 'completed', remarks: null,
  created_at: '2026-09-24T20:43:18+08:00', edited_at: null, event_id: 'e1', pet_type: 'dog',
  items: [{product_id: 'YOG', name: 'Freeze-Dried Yoghurt Cubes', qty: 1, unit_price: 200, line_total: 200}], ...over,
});

describe('lead ↔ order match', () => {
  it('links a lone order a couple of minutes off, confidently', () => {
    const l = lead();
    const m = matchLeadsToOrders([l], [order()], new Set())[leadKey(l)];
    expect(m).toMatchObject({orderId: 'o1', products: ['Yoghurt Cubes'], minutes: 1.7, confidence: 'confident'});
  });

  it('ignores orders outside the window, on another day, or voided', () => {
    const l = lead();
    const far = order({created_at: '2026-09-24T20:30:00+08:00'});
    const voided = order({status: 'voided'});
    const otherDay = order({created_at: '2026-09-23T20:45:00+08:00'});
    expect(matchLeadsToOrders([l], [far, voided, otherDay], new Set())).toEqual({});
  });

  // The real Sep 27 9:33/9:34 PM case: a cat owner and a Spitz owner spin a
  // minute apart; species sends each to their own order.
  it('breaks a near-tie on species', () => {
    const cat = lead({instagram: 'chaes', pet: 'chris / cat', collectedAt: '2026-09-27T21:34:00+08:00'});
    const dog = lead({instagram: 'debby', pet: 'Phoebe / Japanese Spitz', collectedAt: '2026-09-27T21:35:00+08:00'});
    const catOrder = order({id: 'cat', client_uuid: 'c', pet_type: 'cat', created_at: '2026-09-27T21:34:40+08:00'});
    const dogOrder = order({id: 'dog', client_uuid: 'd', pet_type: 'dog', created_at: '2026-09-27T21:33:10+08:00'});
    const m = matchLeadsToOrders([cat, dog], [catOrder, dogOrder], new Set());
    expect(m[leadKey(cat)].orderId).toBe('cat');
    expect(m[leadKey(dog)].orderId).toBe('dog');
  });

  it('sends a prize order to the lead who won that prize', () => {
    const winner = lead({instagram: 'w', prize: 'Free Zoomy! Item', collectedAt: '2026-09-24T19:39:00+08:00'});
    const other = lead({instagram: 'x', prize: '35% Off', collectedAt: '2026-09-24T19:39:00+08:00'});
    const prize = order({id: 'p', client_uuid: 'pu', created_at: '2026-09-24T19:38:43+08:00'});
    const plain = order({id: 'q', client_uuid: 'qu', created_at: '2026-09-24T19:37:31+08:00'});
    const m = matchLeadsToOrders([other, winner], [prize, plain], new Set(['pu']));
    expect(m[leadKey(winner)].orderId).toBe('p');
    expect(m[leadKey(other)].orderId).toBe('q');
  });

  it('calls it unsure when a rival order is about as close', () => {
    const l = lead();
    const a = order({id: 'a', client_uuid: 'a', created_at: '2026-09-24T20:44:40+08:00'});
    const b = order({id: 'b', client_uuid: 'b', created_at: '2026-09-24T20:44:10+08:00'});
    expect(matchLeadsToOrders([l], [a, b], new Set())[leadKey(l)].confidence).toBe('unsure');
  });
});

describe('follow-up copy', () => {
  it('fills pet and treats, with no gendered pronoun', () => {
    const l = lead();
    const m = matchLeadsToOrders([l], [order()], new Set())[leadKey(l)];
    expect(followUpMessage('thanks', l, m)).toBe('Hi! This is Syl and Andrei, hope Bailey enjoyed the Yoghurt Cubes!!');
    expect(followUpMessage('promo', l, m)).toContain('Bailey might have finished the Yoghurt Cubes');
  });

  it('phrases names and dates', () => {
    expect(petName(lead({pet: 'mimi / Puspin'}))).toBe('Mimi');
    expect(petName(lead({pet: null}))).toBe('your furbaby');
    expect(treatPhrase(['A', 'B'])).toBe('A and B');
    expect(treatPhrase(['A', 'B', 'C', 'D'])).toBe('A, B, C and D');
    expect(addDays('2026-09-27', 5)).toBe('2026-10-02');
  });
});
