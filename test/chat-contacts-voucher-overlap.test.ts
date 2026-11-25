// RET-14: "GRAND300 buyers who are also booth leads, and their IG": contacts overlap scoped to a code, with the booth Instagram handle.
import {describe, expect, it} from 'vitest';
import type {EnrichedCustomer} from '../src/crm-compute';
import {voucherMatch} from '../src/crm-compute';
import type {SpinLead} from '../src/spin-leads-types';
import {readContactsInput} from '../src/chat/contacts/leads';
import {overlapPeople, type PeopleSource} from '../src/chat/contacts/people';

const web = (o: Partial<EnrichedCustomer>): EnrichedCustomer => ({shopifyCustomerId: 'w', email: null, firstName: null, lastName: null, phone: null, ordersCount: null, totalSpent: null, membershipTier: null, petName: null, petBirthday: null, emailMarketingState: null, createdAt: '2026-05-01T00:00:00Z', updatedAt: null, orderCount: 1, spent: 0, spendYtd: 0, firstOrderAt: '2026-11-05T00:00:00Z', lastOrderAt: '2026-11-05T00:00:00Z', firstOrderCode: null, codesUsed: [], ...o}) as EnrichedCustomer;
const lead = (o: Partial<SpinLead>): SpinLead => ({email: null, instagram: null, name: null, pet: null, picky: null, mobile: null, prize: '₱300 Off', campaign: 'modern-market-sept2026', collectedAt: '2026-09-26T02:00:00Z', ...o});

const SRC: PeopleSource = {
  website: [
    web({shopifyCustomerId: 'a', email: 'ana@example.com', firstName: 'Ana', codesUsed: ['GRAND300']}),
    web({shopifyCustomerId: 'b', email: 'ben@example.com', firstName: 'Ben', codesUsed: ['FAM40']}),
  ],
  leads: [lead({email: 'ana@example.com', instagram: '@ana.pets'}), lead({email: 'ben@example.com', instagram: 'ben.dog'})],
  lazada: [],
};
const scoped = (code: string): PeopleSource => ({...SRC, website: SRC.website!.filter((c) => voucherMatch(c, code))});

describe('contacts overlap with voucher (RET-14)', () => {
  it('reads voucher upper-cased and needs website on one side', () => {
    expect(readContactsInput({mode: 'overlap', a: 'website', b: 'booth', voucher: ' grand300 '})).toEqual({mode: 'overlap', a: 'website', b: 'booth', voucher: 'GRAND300'});
    expect(readContactsInput({mode: 'overlap', a: 'booth', b: 'lazada', voucher: 'GRAND300'})).toEqual({error: expect.stringMatching(/one of a or b must be website/)});
  });
  it('lists only the code users who are also booth leads, with the handle they typed', () => {
    const r = overlapPeople({mode: 'overlap', a: 'website', b: 'booth', voucher: 'GRAND300'}, scoped('GRAND300'));
    if (!('table' in r)) throw new Error(JSON.stringify(r));
    expect(r.table.rows.map((x) => [x.email, x.instagram])).toEqual([['ana@example.com', '@ana.pets']]);
    expect(r.table.title).toMatch(/used GRAND300/);
  });
  it('says so when no code user is a booth lead', () => {
    const r = overlapPeople({mode: 'overlap', a: 'website', b: 'booth', voucher: 'ZOOMY300'}, scoped('ZOOMY300'));
    expect(r).toEqual({error: expect.stringMatching(/Nobody among the website customers who used ZOOMY300/)});
  });
});
