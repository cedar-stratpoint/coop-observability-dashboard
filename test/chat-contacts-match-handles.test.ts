// Owner 2026-11-25: match by name, email and IG patterns ("Karla Sy" / karlasy60@ / @karla.sy), and scope matches to a voucher.
import {describe, expect, it} from 'vitest';
import type {EnrichedCustomer} from '../src/crm-compute';
import type {SpinLead} from '../src/spin-leads-types';
import {readContactsInput} from '../src/chat/contacts/leads';
import {matchPeople} from '../src/chat/contacts/match';
import type {PeopleSource} from '../src/chat/contacts/people';

const web = (o: Partial<EnrichedCustomer>): EnrichedCustomer => ({shopifyCustomerId: 'w', email: null, firstName: null, lastName: null, phone: null, ordersCount: null, totalSpent: null, membershipTier: null, petName: null, petBirthday: null, emailMarketingState: null, createdAt: '2026-05-01T00:00:00Z', updatedAt: null, orderCount: 1, spent: 0, spendYtd: 0, firstOrderAt: null, lastOrderAt: null, firstOrderCode: null, codesUsed: [], ...o}) as EnrichedCustomer;
const lead = (o: Partial<SpinLead>): SpinLead => ({email: null, instagram: null, name: null, pet: null, picky: null, mobile: null, prize: 'Free treat', campaign: 'modern-market-sept2026', collectedAt: '2026-09-26T02:00:00Z', ...o});
const run = (src: PeopleSource, extra: Record<string, unknown> = {}) => {
  const req = readContactsInput({mode: 'matches', scope: 'sources', a: 'website', b: 'booth', min_tier: 'weak', limit: 50, ...extra});
  if ('error' in req) throw new Error(req.error);
  return matchPeople(req as never, src);
};
const rows = (r: ReturnType<typeof matchPeople>) => {
  if (!('table' in r)) throw new Error(JSON.stringify(r));
  return r.table.rows;
};

describe('matches: name, email and IG patterns', () => {
  it('the same letters in an email and an IG handle link two records (40)', () => {
    const r = rows(run({website: [web({shopifyCustomerId: 'k', email: 'karlasy60@gmail.com'})], leads: [lead({instagram: '@karla.sy'})], lazada: []}));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({score: 40, tier: 'possible'});
    expect(String(r[0].why ?? JSON.stringify(r[0]))).toMatch(/karlasy/);
  });
  it('a name written inside the other email or handle links them (30); booth names count too', () => {
    const r = rows(run({website: [web({shopifyCustomerId: 'k', email: 'karlasy60@gmail.com'})], leads: [lead({name: 'Karla Sy', email: 'other@example.com'})], lazada: []}));
    expect(r[0]).toMatchObject({score: 30, tier: 'possible'});
  });
  it('same email is not counted twice as a handle', () => {
    const r = rows(run({website: [web({shopifyCustomerId: 'k', email: 'karlasy60@gmail.com'})], leads: [lead({email: 'karlasy60@gmail.com'})], lazada: []}));
    expect(r[0]).toMatchObject({score: 100, tier: 'confirmed'});
  });
  it('short or one-word names never match a handle', () => {
    const r = run({website: [web({shopifyCustomerId: 'k', email: 'annalee@gmail.com', firstName: 'Ann'})], leads: [lead({name: 'Ann', instagram: 'bobby.dog'})], lazada: []});
    expect(r).toEqual({error: expect.stringMatching(/No .*match/)});
  });
  it('voucher keeps only the website customers who used the code', () => {
    expect(readContactsInput({mode: 'matches', scope: 'sources', a: 'booth', b: 'lazada', voucher: 'GRAND300'})).toEqual({error: expect.stringMatching(/one of a or b must be website/)});
    expect(readContactsInput({mode: 'matches', scope: 'sources', a: 'website', b: 'booth', voucher: 'grand300'})).toMatchObject({voucher: 'GRAND300'});
  });
});
