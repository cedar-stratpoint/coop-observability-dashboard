import {describe, expect, it, vi} from 'vitest';
import {draftLeads} from '../src/chat/contacts/draft';
import {listEventLeads, readContactsInput, type LeadsSource} from '../src/chat/contacts/leads';
import {listPeople, findPeople, type PeopleSource} from '../src/chat/contacts/people';
import {factNotes, PAWSPORT_SLOW, pawsportWithin, personFacts, type PeopleFacts} from '../src/chat/contacts/status';
import {crmCustomersResult, readCustomersInput, type CrmGet} from '../src/chat/crm/tools';
import type {CustomerContact} from '../src/customer-contacts';
import type {EnrichedCustomer} from '../src/crm-compute';
import type {PawsportHolder} from '../src/pawsport';
import type {SpinLead} from '../src/spin-leads-types';
import {fakeCrmClient} from './support/crm-fixtures';

// RET-18 P2: Ask Coop reads the team's contact status and PawSport. Synthetic people only.
const NOW = new Date('2026-10-07T04:00:00Z');
const web = (o: Partial<EnrichedCustomer>): EnrichedCustomer => ({shopifyCustomerId: 'w', email: null, firstName: null, lastName: null, phone: null, ordersCount: null, totalSpent: null, membershipTier: null, petName: null, petBirthday: null, emailMarketingState: null, createdAt: '2026-07-01T00:00:00Z', updatedAt: null, orderCount: 0, spent: 0, spendYtd: 0, firstOrderAt: null, lastOrderAt: null, firstOrderCode: null, codesUsed: null, ...o});
const lead = (o: Partial<SpinLead>): SpinLead => ({email: null, instagram: null, name: null, pet: null, picky: null, mobile: null, prize: 'Free treat', campaign: null, collectedAt: '2026-09-26T02:00:00Z', ...o});
const contact = (o: Partial<CustomerContact>): CustomerContact => ({id: Math.random().toString(36), email: null, instagram: null, mobile: null, channel: 'instagram', note: null, replied: false, contactedAt: '2026-10-01T02:00:00Z', createdBy: '', ...o});
const holder = (o: Partial<PawsportHolder>): PawsportHolder => ({shopifyCustomerId: 'gid://shopify/Customer/1', email: null, phone: null, number: 'ZMY26-AAAA-0001', issuedAt: '2026-09-12T03:00:00Z', pet: {name: 'Mimi', type: 'cat'}, route: 'qr', ...o});

const FACTS: PeopleFacts = {
  log: {rows: [contact({email: 'ana@example.com', replied: true, contactedAt: '2026-10-05T02:00:00Z'}), contact({instagram: 'bruno.dog', contactedAt: '2026-09-20T02:00:00Z'})], legacy: false},
  links: [],
  pawsport: {status: 'ok', holders: [holder({email: 'ana@example.com'}), holder({shopifyCustomerId: 'gid://shopify/Customer/2', phone: '9171112222', number: 'ZMY26-AAAA-0002', pet: {name: 'Bruno', type: 'dog'}})], warnings: []},
};
const SRC: PeopleSource = {
  website: [web({shopifyCustomerId: 'a', email: 'ana@example.com', firstName: 'Ana', lastName: 'Cruz'}), web({shopifyCustomerId: 'c', email: 'cy@example.com', firstName: 'Cy', lastName: 'Lim'})],
  leads: [lead({instagram: 'bruno.dog', mobile: '09171112222'}), lead({email: 'dee@example.com'})],
  lazada: [],
  facts: FACTS,
};
const people = (input: Record<string, unknown>, src: PeopleSource = SRC) => {
  const req = readContactsInput({mode: 'people', ...input});
  if ('error' in req || req.mode !== 'people') throw new Error(JSON.stringify(req));
  const r = listPeople(req, src);
  if (!('table' in r)) throw new Error(r.error);
  return r;
};

describe('contacts mode people: status and PawSport filters', () => {
  it('reads each person\'s team status and PawSport, and filters on them', () => {
    const all = people({});
    expect(all.model.counts).toMatchObject({in_source: 4, status_replied: 1, status_contacted: 1, status_not_contacted: 2, pawsport_yes: 2, pawsport_no: 2});
    expect(people({contact_status: 'not_contacted'}).table.rows.map((r) => r.email ?? r.instagram).sort()).toEqual(['cy@example.com', 'dee@example.com']);
    // "Which booth leads also have a PawSport?": the lead matches the holder by mobile
    expect(people({source: 'booth', has_pawsport: 'yes'}).table.rows).toMatchObject([{instagram: '@bruno.dog', pawsport: 'yes', contact_status: 'contacted', pawsport_detail: expect.stringContaining('ZMY26-AAAA-0002')}]);
    // "PawSport holders not contacted yet": none here (both were contacted)
    expect(people({has_pawsport: 'yes', contact_status: 'not_contacted'}).table.rows).toEqual([]);
  });
  it('"who replied this week": a replied contact logged on or after the day', () => {
    expect(people({contact_status: 'replied', contacted_since: '2026-10-05'}).table.rows.map((r) => r.email)).toEqual(['ana@example.com']);
    expect(people({contact_status: 'replied', contacted_since: '2026-10-06'}).table.rows).toEqual([]);
    expect(people({contacted_since: '2026-09-20'}).table.rows).toHaveLength(2);
  });
  it('refuses a bad filter value', () => {
    expect(readContactsInput({mode: 'people', contact_status: 'never'})).toEqual({error: expect.stringMatching(/contact_status must be one of/)});
    expect(readContactsInput({mode: 'people', contacted_since: 'last week'})).toEqual({error: expect.stringMatching(/YYYY-MM-DD/)});
  });
  it('find rows carry the same columns', () => {
    const r = findPeople({mode: 'find', query: 'ana@example.com'}, SRC);
    expect('table' in r && r.table.rows[0]).toMatchObject({contact_status: 'replied', replied: 'yes', team_last_contacted: '2026-10-05', pawsport: 'yes'});
  });
});

describe('unknown is never "never"', () => {
  it('an unreadable log reads unknown for everyone, matches no "not contacted" filter, and says so', () => {
    const src = {...SRC, facts: {...FACTS, log: null}};
    const r = people({}, src);
    expect(r.model.counts).toMatchObject({status_unknown: 4, status_not_contacted: 0});
    expect(r.table.rows.every((x) => x.contact_status === 'unknown' && x.replied === null)).toBe(true);
    expect(people({contact_status: 'not_contacted'}, src).table.rows).toEqual([]);
    expect(r.model.notes.join(' ')).toMatch(/could not be read[^.]*unknown/);
  });
  it('the legacy log: a person without an email is unknown, one with an email is still read', () => {
    const src = {...SRC, facts: {...FACTS, log: {rows: [], legacy: true}}};
    const rows = people({source: 'booth'}, src).table.rows;
    expect(rows.find((x) => x.instagram === '@bruno.dog')?.contact_status).toBe('unknown');
    expect(rows.find((x) => x.email === 'dee@example.com')?.contact_status).toBe('not_contacted');
  });
  it('no seam at all: everything unknown, never not_contacted or no', () => {
    const f = personFacts(null)({emails: ['ana@example.com'], mobiles: [], instagram: null});
    expect(f).toMatchObject({state: 'unknown', pawsport: 'unknown'});
    expect(factNotes(null).join(' ')).toMatch(/unknown for everyone/);
  });
});

describe('PawSport unknown when Shopify is not read', () => {
  it('unavailable: pawsport unknown for all, "has none" matches nobody, and the note says so', () => {
    const src = {...SRC, facts: {...FACTS, pawsport: {status: 'unavailable' as const, holders: [], warnings: []}}};
    const r = people({}, src);
    expect(r.model.counts).toMatchObject({pawsport_unknown: 4, pawsport_no: 0});
    expect(people({has_pawsport: 'no'}, src).table.rows).toEqual([]);
    expect(r.model.notes.join(' ')).toMatch(/Shopify could not be read for PawSport/);
  });
  it('a cut-off list: matched holders are yes, everyone else unknown (never no)', () => {
    const src = {...SRC, facts: {...FACTS, pawsport: {...FACTS.pawsport, incomplete: true}}};
    expect(people({}, src).model.counts).toMatchObject({pawsport_yes: 2, pawsport_unknown: 2, pawsport_no: 0});
  });
});

describe('list_crm_customers: status, PawSport and the identity rule (D3)', () => {
  const get = (): CrmGet => (e) => fakeCrmClient().client.get(e);
  const crmFacts: PeopleFacts = {log: {rows: [contact({email: 'ana@example.com'})], legacy: false}, links: [], pawsport: {status: 'ok', holders: [holder({shopifyCustomerId: 'gid://shopify/Customer/c1', email: 'ana@example.com'})], warnings: []}};
  const run = (input: Record<string, unknown>, identity: boolean) => {
    const req = readCustomersInput({group_by: 'none', ...input});
    if ('error' in req) throw new Error(req.error);
    return crmCustomersResult(req, get(), NOW, undefined, undefined, {facts: async () => crmFacts, identity});
  };
  it('a non-allowlisted viewer gets the yes/no and the counts, never the passport number or pet', async () => {
    const r = await run({}, false);
    expect(r.columns.map((c) => c.key)).not.toContain('pawsport_detail');
    expect(JSON.stringify(r.rows)).not.toMatch(/ZMY26|Mimi/);
    expect(r.rows.find((x) => x.email === 'ana@example.com')).toMatchObject({pawsport: 'yes', contact_status: 'contacted'});
    expect(r.meta.checks.map((c) => c.text).join(' ')).toMatch(/Shopify has 1 PawSport holders in all/);
  });
  it('an allowlisted viewer also gets the passport details', async () => {
    const r = await run({}, true);
    expect(r.rows.find((x) => x.email === 'ana@example.com')?.pawsport_detail).toMatch(/ZMY26-AAAA-0001 · Mimi \(cat\)/);
  });
  it('filters: PawSport holders not contacted yet, and holders', async () => {
    expect((await run({has_pawsport: 'yes', contact_status: 'not_contacted'}, false)).rows).toEqual([]);
    expect((await run({has_pawsport: 'no', contact_status: 'not_contacted'}, false)).rows.map((x) => x.email).sort()).toEqual(['ben@example.com', 'cy@example.com']);
  });
  it('the facts read failing reads unknown, never not_contacted', async () => {
    const req = readCustomersInput({group_by: 'none', contact_status: 'not_contacted'});
    if ('error' in req) throw new Error(req.error);
    const r = await crmCustomersResult(req, get(), NOW, undefined, undefined, {facts: async () => { throw new Error('down'); }});
    expect(r.rows).toEqual([]);
  });
});

// ---------- review fixes (2026-11-26) ----------

const EVENT_SRC: LeadsSource = {
  events: [{event_id: 'e1', name: 'Circuit Makati', starts_on: '2026-09-26', ends_on: '2026-09-26'}],
  leads: [lead({email: 'ana@example.com', pet: 'Ana pet'}), lead({email: 'dee@example.com', pet: 'Dee pet'}), lead({email: 'eve@example.com', pet: 'Eve pet'})],
  facts: {...FACTS, log: {rows: [contact({email: 'ana@example.com'})], legacy: false}},
};
const contactsReq = (input: Record<string, unknown>) => {
  const r = readContactsInput({event: 'Circuit Makati', ...input});
  if ('error' in r) throw new Error(r.error);
  return r;
};

describe('review 1: a draft follows the filtered list it comes after', () => {
  it('list_leads not_contacted numbers Dee 1 and Eve 2; per_lead row 1 goes to Dee, not Ana', () => {
    const list = listEventLeads(contactsReq({mode: 'list_leads', contact_status: 'not_contacted'}) as never, EVENT_SRC);
    if (!('table' in list)) throw new Error('no table');
    expect(list.table.rows.map((r) => [r.n, r.email])).toEqual([[1, 'dee@example.com'], [2, 'eve@example.com']]);
    const d = draftLeads(contactsReq({mode: 'draft', channel: 'email', contact_status: 'not_contacted', per_lead: [{n: 1, text: 'Hi Dee'}]}) as never, EVENT_SRC);
    expect('table' in d && d.table.rows).toEqual([{n: 1, to: 'dee@example.com', message: 'Hi Dee'}]);
    expect(draftLeads(contactsReq({mode: 'draft', channel: 'email', contact_status: 'not_contacted', per_lead: [{n: 3, text: 'x'}]}) as never, EVENT_SRC)).toEqual({error: expect.stringMatching(/Row 3 is not in the list: it has 2 rows/)});
  });
  it('a template draft goes only to the filtered leads', () => {
    const d = draftLeads(contactsReq({mode: 'draft', channel: 'email', contact_status: 'not_contacted', template: 'Hi {{pet}}'}) as never, EVENT_SRC);
    expect('table' in d && d.table.rows.map((r) => r.to)).toEqual(['dee@example.com', 'eve@example.com']);
    expect('model' in d && d.model.notes.join(' ')).toMatch(/Only the 2 of 3 leads that match the filter \(not contacted\)/);
  });
});

describe('review 2: unread Same person links never make "not contacted"', () => {
  it('not_contacted becomes unknown, contacted and replied stay, and a note says why', () => {
    const r = people({}, {...SRC, facts: {...FACTS, links: null}});
    expect(r.model.counts).toMatchObject({status_not_contacted: 0, status_unknown: 2, status_contacted: 1, status_replied: 1});
    expect(r.model.notes.join(' ')).toMatch(/Same person links could not be read/);
  });
});

describe('review 3: PawSport has its own time budget, and starts beside the CRM reads', () => {
  it('a read past the budget is unavailable with the slow note; a fast one passes through', async () => {
    vi.useFakeTimers();
    try {
      const slow = pawsportWithin(new Promise(() => {}), 12_000);
      await vi.advanceTimersByTimeAsync(12_000);
      await expect(slow).resolves.toEqual({status: 'unavailable', holders: [], warnings: [PAWSPORT_SLOW]});
    } finally {
      vi.useRealTimers();
    }
    await expect(pawsportWithin(Promise.resolve(FACTS.pawsport))).resolves.toBe(FACTS.pawsport);
    expect(factNotes({...FACTS, pawsport: {status: 'unavailable', holders: [], warnings: [PAWSPORT_SLOW]}}).join(' ')).toContain(PAWSPORT_SLOW);
  });
  it('list_crm_customers asks for the facts before the CRM answers', async () => {
    let factsAsked = false;
    let crmDoneFirst = false;
    const slowGet: CrmGet = async (e) => {
      await new Promise((r) => setTimeout(r, 20));
      if (!factsAsked) crmDoneFirst = true;
      return fakeCrmClient().client.get(e);
    };
    const req = readCustomersInput({group_by: 'none'});
    if ('error' in req) throw new Error(req.error);
    await crmCustomersResult(req, slowGet, NOW, undefined, undefined, {facts: async () => { factsAsked = true; return FACTS; }});
    expect(factsAsked).toBe(true);
    expect(crmDoneFirst).toBe(false);
  });
});

describe('review 4-6: contacted includes replied with a day; caveats on no match; date checks', () => {
  it('contacted + contacted_since includes those who replied, and the title says so', () => {
    const r = people({contact_status: 'contacted', contacted_since: '2026-09-01'});
    expect(r.table.rows.map((x) => x.contact_status).sort()).toEqual(['contacted', 'replied']);
    expect(r.table.title).toMatch(/contacted \(replied included\)/);
    expect(people({contact_status: 'contacted'}).table.rows.map((x) => x.contact_status)).toEqual(['contacted']);
  });
  it('a zero-match list names every unread source', () => {
    const src: LeadsSource = {...EVENT_SRC, facts: {log: null, links: [], pawsport: {status: 'unavailable', holders: [], warnings: []}}};
    const r = listEventLeads(contactsReq({mode: 'list_leads', has_pawsport: 'yes'}) as never, src);
    expect('error' in r && r.error).toMatch(/contact log could not be read[\s\S]*Shopify could not be read/);
  });
  it('refuses an impossible day and not_contacted / unknown with contacted_since', () => {
    expect(readContactsInput({mode: 'people', contacted_since: '2026-02-30'})).toEqual({error: expect.stringMatching(/real PH day/)});
    expect(readContactsInput({mode: 'people', contact_status: 'not_contacted', contacted_since: '2026-11-01'})).toEqual({error: expect.stringMatching(/cannot go with contact_status not_contacted/)});
    expect(readCustomersInput({contact_status: 'unknown', contacted_since: '2026-11-01'})).toEqual({error: expect.stringMatching(/cannot go with contact_status unknown/)});
  });
});
