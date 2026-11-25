// RET-15 Slice B: "Same person" links. The CRM stays the source: a link only adds Instagram + Booth metadata beside a customer.
import {describe, expect, it} from 'vitest';
import {boothCell, boothText, customerBoothMap, samePersonOffer, linkPeopleWith, readLinkInput, unlinkPeopleWith, type CustomerLink, type LinkDeps} from '../src/customer-links';
import type {SpinLead} from '../src/spin-leads-types';

const ME = 'ana@zoomy.ph';
const ID = '0b6f6a52-2f6e-4f5e-9d33-6f1b8a3c9e01';
const lead = (o: Partial<SpinLead>): SpinLead => ({email: null, instagram: null, name: null, pet: null, picky: null, mobile: null, prize: 'Free treat', campaign: 'market-1', collectedAt: '2026-10-01T00:00:00Z', ...o});
const link = (o: Partial<CustomerLink>): CustomerLink => ({id: ID, customerEmail: 'mia@example.com', leadEmail: null, leadMobile: null, leadInstagram: null, leadCampaign: null, createdBy: ME, ...o});

describe('customerBoothMap', () => {
  it('same email is an exact match with no link', () => {
    const m = customerBoothMap([{email: 'Mia@Example.com'}], [lead({email: 'mia@example.com', instagram: '@Mia.Sy', pet: 'Mochi'})], []);
    expect(m.get('mia@example.com')).toMatchObject({source: 'exact', instagram: 'mia.sy', booth: [{campaign: 'market-1', prize: 'Free treat', pet: 'Mochi'}], links: []});
  });
  it('same mobile (last 10 digits) is an exact match', () => {
    const m = customerBoothMap([{email: 'mia@example.com', phone: '+63 917 123 4567'}], [lead({mobile: '09171234567'})], []);
    expect(m.get('mia@example.com')?.source).toBe('exact');
  });
  it('a saved link finds the lead by IG, mobile or email and is marked linked', () => {
    const l = lead({instagram: 'karla.sy', campaign: 'market-2'});
    const m = customerBoothMap([{email: 'mia@example.com'}], [l, lead({instagram: 'other'})], [link({leadInstagram: 'karla.sy'})]);
    expect(m.get('mia@example.com')).toMatchObject({source: 'linked', instagram: 'karla.sy', linkId: ID, links: [{id: ID, createdBy: ME}]});
    expect(m.get('mia@example.com')?.booth).toHaveLength(1);
  });
  it('exact wins over linked', () => {
    const m = customerBoothMap([{email: 'mia@example.com'}], [lead({email: 'mia@example.com', campaign: 'a'}), lead({instagram: 'x', campaign: 'b'})], [link({leadInstagram: 'x'})]);
    const v = m.get('mia@example.com');
    expect(v?.source).toBe('exact');
    expect(v?.booth.map((b) => b.campaign)).toEqual(['a']);
  });
  it('several leads give all their campaigns and the first Instagram', () => {
    const m = customerBoothMap([{email: 'mia@example.com'}], [lead({email: 'mia@example.com', campaign: 'a'}), lead({email: 'mia@example.com', campaign: 'b', instagram: 'mia1'})], []);
    expect(m.get('mia@example.com')?.booth.map((b) => b.campaign)).toEqual(['a', 'b']);
    expect(m.get('mia@example.com')?.instagram).toBe('mia1');
  });
  it('after unlink (no link rows) the customer has nothing', () => {
    expect(customerBoothMap([{email: 'mia@example.com'}], [lead({instagram: 'karla.sy'})], []).has('mia@example.com')).toBe(false);
  });
  it('a link whose lead is gone adds nothing', () => {
    expect(customerBoothMap([{email: 'mia@example.com'}], [], [link({leadInstagram: 'gone'})]).size).toBe(0);
  });
});

describe('boothCell: unknown is never "never"', () => {
  it('nothing found reads none only when leads and links were both read', () => {
    expect(boothCell(undefined, {leads: true, links: true})).toBe('none');
    expect(boothCell(undefined, {leads: true, links: false})).toBe('unknown');
    expect(boothCell(undefined, {leads: false, links: true})).toBe('unknown');
  });
  it('a found match always shows', () => {
    const f = customerBoothMap([{email: 'mia@example.com'}], [lead({email: 'mia@example.com'})], []).get('mia@example.com');
    expect(boothCell(f, {leads: true, links: false})).toBe(f);
  });
  it('chip text drops what the lead did not give', () => {
    expect(boothText({campaign: 'm1', prize: null, pet: 'Mochi'})).toBe('m1 · Mochi');
  });
});

function fakeDeps(o: {actor?: string | null; missing?: boolean; dup?: boolean; owner?: string} = {}) {
  const inserted: Record<string, unknown>[] = [];
  const deletes: {id: string; by: string}[] = [];
  const missing = {code: 'PGRST205', message: "Could not find the table 'public.customer_links'"};
  const deps: LinkDeps = {
    actor: async () => (o.actor === undefined ? ME : o.actor),
    insert: async (row) => {
      if (o.missing) return missing;
      if (o.dup) return {code: '23505', message: 'duplicate key'};
      inserted.push(row);
      return null;
    },
    deleteOwn: async (id, by) => {
      if (o.missing) return {error: missing, deleted: 0};
      deletes.push({id, by});
      return {error: null, deleted: by === (o.owner ?? ME) ? 1 : 0};
    },
  };
  return {deps, inserted, deletes};
}

describe('linkPeople / unlinkPeople', () => {
  it('writes normalised keys with created_by from the session, never the input', async () => {
    const {deps, inserted} = fakeDeps();
    const r = await linkPeopleWith(deps, {customerEmail: ' Mia@Example.COM ', leadInstagram: '@Karla.Sy', leadMobile: '0917 123 4567', leadCampaign: 'm1', createdBy: 'x@y.ph'});
    expect(r).toEqual({ok: true});
    expect(inserted).toEqual([{customer_email: 'mia@example.com', lead_email: null, lead_mobile: '9171234567', lead_instagram: 'karla.sy', lead_campaign: 'm1', created_by: ME}]);
  });
  it.each([
    [{customerEmail: 'nope', leadInstagram: 'a'}],
    [{customerEmail: 'mia@example.com'}],
    [{customerEmail: 'mia@example.com', leadEmail: 'bad'}],
    [{customerEmail: 'mia@example.com', leadInstagram: 'has space'}],
    [{customerEmail: 'mia@example.com', leadMobile: '123'}],
  ])('rejects %j', async (input) => {
    const {deps, inserted} = fakeDeps();
    expect((await linkPeopleWith(deps, input)).ok).toBe(false);
    expect(inserted).toEqual([]);
  });
  it('no session, missing table and a duplicate are handled', async () => {
    expect(await linkPeopleWith(fakeDeps({actor: null}).deps, {customerEmail: 'mia@example.com', leadInstagram: 'a'})).toMatchObject({ok: false});
    expect(await linkPeopleWith(fakeDeps({missing: true}).deps, {customerEmail: 'mia@example.com', leadInstagram: 'a'})).toMatchObject({ok: false, error: expect.stringContaining('not set up')});
    expect(await linkPeopleWith(fakeDeps({dup: true}).deps, {customerEmail: 'mia@example.com', leadInstagram: 'a'})).toEqual({ok: true});
  });
  it('only the person who linked can unlink', async () => {
    const mine = fakeDeps();
    expect(await unlinkPeopleWith(mine.deps, ID)).toEqual({ok: true});
    expect(mine.deletes).toEqual([{id: ID, by: ME}]);
    expect(await unlinkPeopleWith(fakeDeps({owner: 'bo@zoomy.ph'}).deps, ID)).toMatchObject({ok: false});
    expect(await unlinkPeopleWith(mine.deps, 'not-a-uuid')).toMatchObject({ok: false});
  });
  it('readLinkInput needs at least one lead identity', () => {
    expect(readLinkInput({customerEmail: 'mia@example.com', leadEmail: 'K@x.com'})).toMatchObject({lead_email: 'k@x.com'});
  });
});

describe('samePersonOffer (matches table rows)', () => {
  const base = {a_source: 'website CRM', a_email: 'mia@example.com', a_mobile: null, b_source: 'event leads', b_email: null, b_mobile: null, b_instagram: '@karla.sy', b_event: 'market-1', tier: 'confirmed'};
  it('offers a link for a website / event-lead pair with no shared email or mobile, even when tier says confirmed', () => {
    expect(samePersonOffer(base)).toEqual({link: {customerEmail: 'mia@example.com', leadEmail: null, leadMobile: null, leadInstagram: 'karla.sy', leadCampaign: 'market-1'}});
  });
  it('same email or same mobile is already matched', () => {
    expect(samePersonOffer({...base, b_email: 'MIA@example.com'})).toBe('exact');
    expect(samePersonOffer({...base, a_mobile: '+639171234567', b_mobile: '0917 123 4567'})).toBe('exact');
  });
  it('works with the sides swapped and ignores other source pairs', () => {
    expect(samePersonOffer({a_source: 'event leads', a_instagram: '@x', b_source: 'website CRM', b_email: 'mia@example.com'})).toMatchObject({link: {leadInstagram: 'x'}});
    expect(samePersonOffer({...base, b_source: 'Lazada'})).toBeNull();
    expect(samePersonOffer({a_source: 'website CRM', b_source: 'event leads', b_instagram: '@x'})).toBeNull();
  });
});
