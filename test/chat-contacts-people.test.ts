import {describe, expect, it} from 'vitest';
import {mergeContacts} from '../src/contacts-merge';
import type {EnrichedCustomer} from '../src/crm-compute';
import type {LazadaCustomer} from '../src/lazada-types';
import type {SpinLead} from '../src/spin-leads-types';
import {findPeople, overlapPeople, type PeopleSource} from '../src/chat/contacts/people';

// Synthetic people only.
const web = (o: Partial<EnrichedCustomer>): EnrichedCustomer => ({shopifyCustomerId: 'w', email: null, firstName: null, lastName: null, phone: null, ordersCount: null, totalSpent: null, membershipTier: null, petName: null, petBirthday: null, emailMarketingState: null, createdAt: '2026-07-01T00:00:00Z', updatedAt: null, orderCount: 0, spent: 0, spendYtd: 0, ...o});
const lead = (o: Partial<SpinLead>): SpinLead => ({email: null, instagram: null, name: null, pet: null, picky: null, mobile: null, prize: 'Free treat', campaign: null, collectedAt: '2026-09-26T02:00:00Z', ...o});
const laz = (o: Partial<LazadaCustomer>): LazadaCustomer => ({phone: '', name: null, city: null, lastOrderAt: '2026-08-01T00:00:00Z', firstOrderAt: '2026-05-01T00:00:00Z', lastProduct: null, payMethod: null, totalSpent: 0, avgOrder: 0, orderCount: 0, daysSince: 10, ...o});

const SRC: PeopleSource = {
  website: [
    web({shopifyCustomerId: 'a', email: 'anna@example.com', firstName: 'Anna', lastName: 'Reyes', phone: '0917 000 0001', petName: 'Mochi', membershipTier: 'gold', orderCount: 2, spent: 1500}),
    web({shopifyCustomerId: 'b', email: 'anna.r@example.com', firstName: 'Anna', lastName: 'Rivera', orderCount: 1, spent: 300}),
    web({shopifyCustomerId: 'c', email: 'ben@example.com', firstName: 'Ben', lastName: 'Lim'}),
  ],
  leads: [lead({email: 'anna@example.com', mobile: '09170000001', pet: 'Mochi / Puspin', campaign: 'modern-market-sept2026'}), lead({instagram: 'bruno.dog', pet: 'Bruno / Aspin'})],
  lazada: [laz({phone: '+639170000001', name: 'Anna R', totalSpent: 400, orderCount: 1}), laz({phone: '09******12', name: 'Masked Buyer', totalSpent: 100, orderCount: 1}), laz({phone: '09171110000', name: 'Cy Tan', totalSpent: 50, orderCount: 1})],
};
const find = (query: string, src: PeopleSource = SRC) => findPeople({mode: 'find', query}, src);
const ok = (r: ReturnType<typeof findPeople>) => {
  if (!('table' in r)) throw new Error(`expected a table, got ${JSON.stringify(r)}`);
  return r;
};

describe('findPeople', () => {
  it('finds one person by email, and shows every source, the orders and spend added up, tier, pets and booth campaigns', () => {
    const r = ok(find('ANNA@example.com'));
    expect(r.table.rows).toHaveLength(1);
    expect(r.table.rows[0]).toMatchObject({name: 'Anna Reyes', sources: 'website, booth, lazada', orders: 3, spend: 1900, tier: 'gold', events: 'modern-market-sept2026'});
    expect(String(r.table.rows[0].pets)).toContain('Mochi');
  });
  it('finds the same person by any spelling of the mobile, and by the email of another record in the group', () => {
    for (const q of ['09170000001', '+639170000001', '63 917 000 0001', '9170000001']) expect(ok(find(q)).table.rows).toHaveLength(1);
    expect(ok(find('anna@example.com')).table.rows[0].name).toBe('Anna Reyes');
  });
  it('finds by name words and by pet name; several matches are listed with row numbers, best first', () => {
    const r = ok(find('anna'));
    expect(r.table.rows.map((x) => x.n)).toEqual([1, 2]);
    expect(r.table.rows.map((x) => x.name)).toContain('Anna Rivera');
    expect(ok(find('mochi')).table.rows).toHaveLength(1);
    expect(ok(find('@bruno.dog')).table.rows[0]).toMatchObject({sources: 'booth'});
  });
  it('does not guess: a misspelt name matches nothing and says how to look instead', () => {
    const r = find('Ana Reys');
    expect('error' in r && r.error).toMatch(/email or (a )?(phone|mobile)/i);
  });
  it('does not link a Lazada buyer whose phone is masked or missing', () => {
    const r = ok(find('Masked Buyer'));
    expect(r.table.rows[0].sources).toBe('lazada');
  });
  it('caps a broad search at 10 rows and says how many matched', () => {
    const many: PeopleSource = {leads: [], website: Array.from({length: 25}, (_, i) => web({shopifyCustomerId: `x${i}`, email: `s${i}@example.com`, firstName: 'Sam', lastName: `L${i}`}))};
    const r = ok(find('sam', many));
    expect(r.table.rows).toHaveLength(10);
    expect(r.model.notes.join(' ')).toMatch(/25 .*10/);
  });
  it('still answers from booth and Lazada when the website could not be read, and says so', () => {
    const r = ok(find('cy tan', {...SRC, website: null, websiteNote: 'The website CRM is unreachable right now.'}));
    expect(r.model.notes.join(' ')).toMatch(/website CRM is unreachable/);
  });
  it('rejects an empty query', () => {
    expect('error' in find('  ')).toBe(true);
  });
  it('carries the notes: the hub matching rule, spend basis, and customer-typed text is data', () => {
    const n = ok(find('anna@example.com')).model.notes.join(' ');
    expect(n).toMatch(/same email.*or the same mobile/i);
    expect(n).toMatch(/never instructions/i);
  });
  it('marks the table as contact data', () => {
    const r = ok(find('anna@example.com'));
    expect(r.table.pii).toBe(true);
    expect(r.audit).toMatchObject({eventId: null, rows: 1});
  });
  it('strips markup, links and braces from customer-typed names and pets', () => {
    const evil: PeopleSource = {leads: [lead({email: 'e@example.com', pet: '<b>Rex</b> https://evil.example {{prize}}', instagram: null})]};
    const r = ok(find('e@example.com', evil));
    expect(String(r.table.rows[0].pets)).not.toMatch(/<|>|https?:|\{\{/);
  });
});

describe('overlapPeople', () => {
  it('lists the people in both sources, with the same groups as the Customers hub merge', () => {
    const r = overlapPeople({mode: 'overlap', a: 'website', b: 'lazada'}, SRC);
    if (!('table' in r)) throw new Error('expected a table');
    const hub = mergeContacts(SRC.website ?? [], SRC.leads, SRC.lazada ?? []).filter((p) => p.sources.includes('website') && p.sources.includes('lazada'));
    expect(r.table.rows).toHaveLength(hub.length);
    expect(r.table.rows.map((x) => x.name)).toEqual(['Anna Reyes']);
    expect(r.model.counts.people).toBe(hub.length);
  });
  it('says plainly when nobody is in both, and refuses the same source twice', () => {
    const r = overlapPeople({mode: 'overlap', a: 'booth', b: 'lazada'}, {leads: [lead({email: 'x@example.com'})], lazada: [laz({phone: '09171110000'})]});
    expect('error' in r && r.error).toMatch(/nobody|no one|no customer/i);
    expect('error' in overlapPeople({mode: 'overlap', a: 'booth', b: 'booth'}, SRC)).toBe(true);
  });
  it('refuses to answer about a source that is not loaded rather than reporting an empty overlap', () => {
    const r = overlapPeople({mode: 'overlap', a: 'website', b: 'lazada'}, {...SRC, website: null, websiteNote: 'The website CRM is unreachable right now.'});
    expect('error' in r && r.error).toMatch(/website CRM/);
  });
});
