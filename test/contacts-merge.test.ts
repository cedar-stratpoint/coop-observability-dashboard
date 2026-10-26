import {describe, it, expect} from 'vitest';
import {
  contactTotals,
  emailKey,
  filterContacts,
  mergeContacts,
  phoneKey,
  EMPTY_CONTACT_FILTER,
} from '../src/contacts-merge';
import type {EnrichedCustomer} from '../src/crm-compute';
import type {LazadaCustomer} from '../src/lazada-types';
import type {SpinLead} from '../src/spin-leads-types';

const crm = (over: Partial<EnrichedCustomer> = {}): EnrichedCustomer => ({
  shopifyCustomerId: '1', email: 'buyer@x.com', firstName: 'Ana', lastName: 'Cruz', phone: null,
  ordersCount: null, totalSpent: null, membershipTier: 'gold', petName: null, petBirthday: null,
  emailMarketingState: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
  orderCount: 2, spent: 1000, spendYtd: 1000, ...over,
});
const lead = (over: Partial<SpinLead> = {}): SpinLead => ({
  email: 'buyer@x.com', instagram: null, pet: null, name: null, picky: null, mobile: '09171234567', prize: '35% Off', campaign: 'modern-market-sept2026',
  collectedAt: '2026-09-20T05:00:00Z', ...over,
});
const laz = (over: Partial<LazadaCustomer> = {}): LazadaCustomer => ({
  phone: '+639171234567', name: 'Ana C', city: 'Makati', lastOrderAt: '2026-07-01T00:00:00Z',
  firstOrderAt: '2026-05-01T00:00:00Z', lastProduct: null, payMethod: 'COD', totalSpent: 500,
  avgOrder: 500, orderCount: 1, daysSince: 30, ...over,
});

describe('identity keys', () => {
  // The same PH mobile reaches us in four shapes depending on the system.
  it('collapses every spelling of a mobile onto the last 10 digits', () => {
    for (const v of ['09171234567', '+639171234567', '639171234567', '9171234567', '0917 123 4567']) {
      expect(phoneKey(v)).toBe('9171234567');
    }
  });

  it('is not fooled by short or absent values', () => {
    for (const v of ['', null, undefined, '123', 'n/a']) expect(phoneKey(v)).toBeNull();
    for (const v of ['', null, undefined, 'not-an-email']) expect(emailKey(v)).toBeNull();
  });

  it('lowercases and trims emails', () => {
    expect(emailKey('  Buyer@X.com ')).toBe('buyer@x.com');
  });
});

describe('mergeContacts', () => {
  it('joins one person across all three lists', () => {
    const merged = mergeContacts([crm()], [lead()], [laz()]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      name: 'Ana Cruz', // website name wins over the marketplace's
      email: 'buyer@x.com',
      city: 'Makati', // only Lazada knows a city
      tier: 'gold',
      prize: '35% Off',
      sources: ['website', 'booth', 'lazada'],
      orders: 3, // 2 website + 1 Lazada
      spend: 1500,
    });
    // Most recent evidence anywhere — the booth signup, not the older orders.
    expect(merged[0].lastSeen).toBe('2026-09-20T05:00:00Z');
  });

  // The reason this is a union-find: the lead bridges a website record (email
  // only) and a Lazada record (phone only), which share no key with each other.
  it('bridges two records that share no key of their own', () => {
    const merged = mergeContacts([crm({phone: null})], [lead()], [laz()]);
    expect(merged).toHaveLength(1);
    expect(merged[0].sources).toEqual(['website', 'booth', 'lazada']);
  });

  it('keeps unrelated people apart', () => {
    const merged = mergeContacts(
      [crm({email: 'a@x.com'})],
      [lead({email: 'b@x.com', mobile: '09998887777'})],
      [laz({phone: '09112223333'})],
    );
    expect(merged).toHaveLength(3);
    expect(merged.every((c) => c.sources.length === 1)).toBe(true);
  });

  // A Lazada buyer has no email at all, which is why phone must be an identity.
  it('matches a marketplace buyer to a website account by phone alone', () => {
    const merged = mergeContacts([crm({email: 'a@x.com', phone: '0917 123 4567'})], [], [laz()]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({email: 'a@x.com', sources: ['website', 'lazada'], orders: 3});
  });

  it('is newest-first', () => {
    const merged = mergeContacts(
      [crm({email: 'old@x.com', phone: null, updatedAt: '2026-01-02T00:00:00Z'})],
      [lead({email: 'new@x.com', mobile: null, collectedAt: '2026-09-01T00:00:00Z'})],
      [],
    );
    expect(merged.map((c) => c.email)).toEqual(['new@x.com', 'old@x.com']);
  });

  it('survives records with no identity at all', () => {
    const merged = mergeContacts([crm({email: null, phone: null})], [], []);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({email: null, mobile: null, sources: ['website']});
  });

  it('returns nothing for three empty lists', () => {
    expect(mergeContacts()).toEqual([]);
  });
});

describe('contactTotals', () => {
  it('counts reachability and cross-channel overlap', () => {
    const merged = mergeContacts(
      [crm(), crm({shopifyCustomerId: '2', email: 'solo@x.com', phone: null})],
      [lead()],
      [laz({phone: '09998887777', name: 'Only Lazada'})],
    );
    const totals = contactTotals(merged);
    expect(totals).toMatchObject({
      contacts: 3,
      withEmail: 2, // the Lazada-only buyer has none
      multiSource: 1,
      // The Lazada buyer's phone matches nobody here, so it stands alone.
      bySource: {website: 2, booth: 1, lazada: 1},
    });
  });
});

describe('filterContacts', () => {
  const merged = mergeContacts(
    [crm(), crm({shopifyCustomerId: '2', email: 'solo@x.com', phone: null})],
    [lead()],
    [laz({phone: '09998887777', name: 'Only Lazada'})],
  );

  it('filters by source, including "in more than one list"', () => {
    expect(filterContacts(merged, {...EMPTY_CONTACT_FILTER, source: 'lazada'}, '')).toHaveLength(1);
    expect(filterContacts(merged, {...EMPTY_CONTACT_FILTER, source: 'website'}, '')).toHaveLength(2);
    expect(filterContacts(merged, {...EMPTY_CONTACT_FILTER, source: 'multi'}, '')).toHaveLength(1);
  });

  it('filters by how the person can actually be reached', () => {
    expect(filterContacts(merged, {...EMPTY_CONTACT_FILTER, reachable: 'email'}, '')).toHaveLength(2);
    expect(filterContacts(merged, {...EMPTY_CONTACT_FILTER, reachable: 'both'}, '')).toHaveLength(1);
  });

  it('searches name, email, mobile, city and event', () => {
    expect(filterContacts(merged, EMPTY_CONTACT_FILTER, 'makati')).toHaveLength(1);
    expect(filterContacts(merged, EMPTY_CONTACT_FILTER, 'modern-market')).toHaveLength(1);
    expect(filterContacts(merged, EMPTY_CONTACT_FILTER, 'nobody')).toHaveLength(0);
  });
});

describe('pets and campaigns of a merged person (additive, for Ask Coop)', () => {
  it('collects the distinct pet names and booth campaigns from every record of the person', () => {
    const [p] = mergeContacts(
      [crm({petName: 'Mochi'})],
      [lead({pet: 'Mochi / Puspin'}), lead({pet: 'Bruno / Aspin', campaign: 'pet-expo-oct2026'})],
      [laz()],
    );
    expect(p.pets).toEqual(['Mochi', 'Mochi / Puspin', 'Bruno / Aspin']);
    expect(p.campaigns).toEqual(['modern-market-sept2026', 'pet-expo-oct2026']);
  });
  it('is empty lists, never null, for a person with none', () => {
    const [p] = mergeContacts([crm()], [], []);
    expect(p.pets).toEqual([]);
    expect(p.campaigns).toEqual([]);
  });
});

describe('every identity of a merged person (additive, so a person can be found by any of them)', () => {
  it('keeps each distinct name, email and mobile of the group', () => {
    const [p] = mergeContacts([crm({phone: null})], [lead({mobile: '09171234567'}), lead({email: 'other@x.com', mobile: '09171234567'})], [laz({name: 'Ana C'})]);
    expect(p.emails).toEqual(['buyer@x.com', 'other@x.com']);
    expect(p.mobiles).toEqual(['09171234567', '+639171234567']);
    expect(p.names).toEqual(['Ana Cruz', 'Ana C']);
  });
});
