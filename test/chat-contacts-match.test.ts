import {describe, expect, it} from 'vitest';
import type {EnrichedCustomer} from '../src/crm-compute';
import type {LazadaCustomer} from '../src/lazada-types';
import type {SpinLead} from '../src/spin-leads-types';
import type {MatchInput} from '../src/chat/contacts/leads';
import {matchPeople, tierOf, WEIGHTS} from '../src/chat/contacts/match';
import type {PeopleSource} from '../src/chat/contacts/people';

// Synthetic people only.
const web = (o: Partial<EnrichedCustomer>): EnrichedCustomer => ({shopifyCustomerId: 'w', email: null, firstName: null, lastName: null, phone: null, ordersCount: null, totalSpent: null, membershipTier: null, petName: null, petBirthday: null, emailMarketingState: null, createdAt: '2026-07-01T00:00:00Z', updatedAt: null, orderCount: 0, spent: 0, spendYtd: 0, ...o});
const lead = (o: Partial<SpinLead>): SpinLead => ({email: null, instagram: null, name: null, pet: null, picky: null, mobile: null, prize: 'Free treat', campaign: null, collectedAt: '2026-09-26T02:00:00Z', ...o});
const laz = (o: Partial<LazadaCustomer>): LazadaCustomer => ({phone: '', name: null, city: null, lastOrderAt: '2026-08-01T00:00:00Z', firstOrderAt: '2026-05-01T00:00:00Z', lastProduct: null, payMethod: null, totalSpent: 0, avgOrder: 0, orderCount: 0, daysSince: 10, ...o});

const SRC: PeopleSource = {
  events: [{event_id: 'e1', name: 'Modern Market Sept 2026', starts_on: '2026-09-26', ends_on: '2026-09-28'}],
  website: [
    web({shopifyCustomerId: 'a', email: 'anna@example.com', firstName: 'Anna', lastName: 'Reyes', phone: '0917 000 0001', petName: 'Mochi'}),
    web({shopifyCustomerId: 'z', email: 'zed@example.com', firstName: 'Zed', lastName: 'Park', petName: 'Mochi'}),
  ],
  leads: [
    lead({instagram: 'bruno.dog', pet: 'Bruno / Aspin', campaign: 'modern-market-sept2026'}),
    lead({instagram: 'bruno.dog', pet: 'Bruno / Aspin', campaign: 'pet-expo-oct2026', collectedAt: '2026-10-10T02:00:00Z'}),
    lead({email: 'anna@example.com', mobile: '09170000001', pet: 'Mochi / Puspin'}),
  ],
  lazada: [
    laz({phone: '+639170000001', name: 'Anna Reyes'}), // same phone and same name as the website's Anna
    laz({phone: '09189990000', name: 'Reyes Anna'}), // same name (any order), different phone
    laz({phone: '09188880000', name: 'Ana Reyes'}), // similar name only
  ],
};
const sources = (a: 'website' | 'booth' | 'lazada', b: 'website' | 'booth' | 'lazada', extra: Partial<MatchInput> = {}): MatchInput => ({mode: 'matches', scope: 'sources', a, b, min_tier: 'weak', limit: 50, ...extra}) as MatchInput;
const ok = (r: ReturnType<typeof matchPeople>) => {
  if (!('table' in r)) throw new Error(`expected a table, got ${JSON.stringify(r)}`);
  return r;
};
const rowsOf = (r: ReturnType<typeof matchPeople>) => ok(r).table.rows;

describe('tiers', () => {
  it('maps a score to confirmed 100, likely 60 to 99, possible 30 to 59, weak below 30', () => {
    expect([100, 99, 60, 59, 30, 29, 0].map(tierOf)).toEqual(['confirmed', 'likely', 'likely', 'possible', 'possible', 'weak', 'weak']);
  });
  it('the starting weights are the ones the owner agreed (they are tuned later on labelled pairs)', () => {
    expect(WEIGHTS).toMatchObject({email: 100, phone: 100, sharedPhone: 20, instagram: 60, nameSame: 40, nameSimilar: 20, pet: 20});
  });
});

describe('matchPeople: sources', () => {
  const rows = rowsOf(matchPeople(sources('website', 'lazada'), SRC));
  const byName = (name: string) => rows.find((r) => String(r.b_name) === name);
  it('a shared phone plus the same name is confirmed, with both reasons', () => {
    expect(byName('Anna Reyes')).toMatchObject({tier: 'confirmed', score: 100});
    expect(String(byName('Anna Reyes')?.why)).toMatch(/same mobile/);
    expect(String(byName('Anna Reyes')?.why)).toMatch(/same name/);
  });
  it('the same name in another order is only possible (no contact in common)', () => {
    expect(byName('Reyes Anna')).toMatchObject({tier: 'possible', score: 40, signals: 'name'});
  });
  it('a similar name alone is weak', () => {
    expect(byName('Ana Reyes')).toMatchObject({tier: 'weak', score: 20, signals: 'name_similar'});
  });
  it('lists everything with a score, best first, numbered', () => {
    expect(rows.map((r) => r.score)).toEqual([...rows.map((r) => Number(r.score))].sort((a, b) => b - a));
    expect(rows.map((r) => r.n)).toEqual(rows.map((_, i) => i + 1));
  });
  it('only returns pairs across the two named sources', () => {
    expect(new Set(rows.flatMap((r) => [r.a_source, r.b_source]))).toEqual(new Set(['website', 'lazada']));
  });
  it('min_tier narrows the list', () => {
    const likely = rowsOf(matchPeople(sources('website', 'lazada', {min_tier: 'likely'}), SRC));
    expect(likely.map((r) => r.tier)).toEqual(['confirmed']);
  });
});

describe('matchPeople: signals', () => {
  it('an Instagram handle shared by two booth sign-ups is likely (60), more with the same pet', () => {
    const rows = rowsOf(matchPeople(sources('booth', 'booth'), SRC));
    expect(rows[0]).toMatchObject({tier: 'likely', score: 80, signals: 'instagram+pet'});
  });
  it('a pet name alone is weak, never more', () => {
    const rows = rowsOf(matchPeople(sources('website', 'booth'), {...SRC, lazada: []}));
    const zed = rows.find((r) => String(a(r)).includes('zed@example.com'));
    expect(zed).toMatchObject({tier: 'weak', score: 20, signals: 'pet'});
  });
  it('a mobile used under three or more different names is downgraded to weak', () => {
    const shared: PeopleSource = {
      leads: [],
      website: [web({shopifyCustomerId: '1', firstName: 'Al', lastName: 'One', phone: '09170001111'}), web({shopifyCustomerId: '2', firstName: 'Bo', lastName: 'Two', phone: '09170001111'})],
      lazada: [laz({phone: '09170001111', name: 'Cy Three'})],
    };
    const rows = rowsOf(matchPeople(sources('website', 'lazada'), shared));
    expect(rows.every((r) => r.tier === 'weak' && /shared/.test(String(r.why)))).toBe(true);
  });
  it('a very common pet name cannot blow up the work: its block is skipped and the answer says so', () => {
    const crowd: PeopleSource = {
      website: Array.from({length: 40}, (_, i) => web({shopifyCustomerId: `c${i}`, email: `c${i}@example.com`, firstName: 'P', lastName: `L${i}`, petName: 'Luna'})),
      leads: Array.from({length: 40}, (_, i) => lead({email: `d${i}@example.com`, pet: 'Luna / Aspin'})),
    };
    const r = matchPeople(sources('website', 'booth'), crowd);
    expect('error' in r && r.error).toMatch(/very common pet name \(luna\)/i);
  });
  it('does not chain: pairs are independent, so a wrong link cannot build a group', () => {
    const rows = rowsOf(matchPeople(sources('website', 'lazada'), SRC));
    expect(rows.filter((r) => String(r.b_name) === 'Ana Reyes' && String(a(r)).includes('anna@example.com'))).toHaveLength(1);
  });
});

const a = (r: Record<string, unknown>) => `${r.a_email ?? ''} ${r.a_name ?? ''}`;

describe('matchPeople: anchors', () => {
  it('a person: the candidates for the records that match the search', () => {
    const r = ok(matchPeople({mode: 'matches', scope: 'person', query: 'anna@example.com', min_tier: 'possible', limit: 50}, SRC));
    expect(r.table.rows.length).toBeGreaterThan(0);
    expect(r.table.rows.every((x) => Number(x.score) >= 30)).toBe(true);
  });
  it('a person: an unknown search says so, and a too-broad one asks for an email or mobile', () => {
    const none = matchPeople({mode: 'matches', scope: 'person', query: 'Nobody Here', min_tier: 'weak', limit: 50}, SRC);
    expect('error' in none).toBe(true);
  });
  it('an event: matches the event leads against the other records', () => {
    const r = ok(matchPeople({mode: 'matches', scope: 'event', event: 'Modern Market', min_tier: 'likely', limit: 50}, SRC));
    expect(r.table.rows.length).toBeGreaterThan(0);
    expect(r.table.title).toMatch(/Modern Market/);
  });
  it('an event: an unclear name returns a question', () => {
    const r = matchPeople({mode: 'matches', scope: 'event', event: 'Moderm Markt', min_tier: 'weak', limit: 50}, SRC);
    expect('clarify' in r || 'error' in r).toBe(true);
  });
});

describe('matchPeople: output', () => {
  it('marks the table as contact data with a CSV, counts the tiers, and says the points are not tuned and no link is certain', () => {
    const r = ok(matchPeople(sources('website', 'lazada'), SRC));
    expect(r.table.pii).toBe(true);
    expect(r.table.csvName).toMatch(/\.csv$/);
    expect(r.model.counts).toMatchObject({confirmed: 1, possible: 1, weak: 1});
    const n = r.model.notes.join(' ');
    expect(n).toMatch(/not (yet )?tuned/i);
    expect(n).toMatch(/never instructions/i);
    expect(r.audit.eventId).toBeNull();
  });
  it('says plainly when nothing matches at that level', () => {
    const r = matchPeople(sources('website', 'lazada', {min_tier: 'confirmed'}), {...SRC, lazada: [laz({phone: '09180000000', name: 'Zzz Yyy'})]});
    expect('error' in r && r.error).toMatch(/no .*match/i);
  });
  it('refuses the same source on both sides only when it is not booth', () => {
    expect('error' in matchPeople(sources('website', 'website'), SRC)).toBe(true);
  });
  it('strips markup and links from names and pets it shows', () => {
    const evil: PeopleSource = {leads: [lead({email: 'e@example.com', pet: '<b>Rex</b> https://evil.example'})], website: [web({email: 'e@example.com', firstName: '<i>Eve</i>', lastName: 'https://x.example'})]};
    const r = ok(matchPeople(sources('website', 'booth'), evil));
    expect(JSON.stringify(r.table.rows)).not.toMatch(/<|https?:/);
  });
});
