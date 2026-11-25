// RET-17 Task 2 (plan knowledge/tasks/2026-11-25-ret17-implementation-plan.md, D3 + Review Focus 1, 2, 5): one person across
// email, Instagram, mobile and saved Same person links, and their contact status from the manual log.
import {describe, expect, it} from 'vitest';
import type {CustomerContact} from '../src/customer-contacts';
import type {CustomerLink} from '../src/customer-links';
import {contactStatus, contactsOf, samePerson, type Person} from '../src/person-identity';

const P = (o: Partial<Person>): Person => ({email: null, instagram: null, mobile: null, ...o});
let n = 0;
const C = (o: Partial<CustomerContact>): CustomerContact => ({
  id: `c${++n}`, email: null, instagram: null, mobile: null, channel: 'instagram', note: null, replied: false,
  contactedAt: '2026-11-20T02:00:00Z', createdBy: 'ana@zoomy.ph', ...o,
});
const L = (o: Partial<CustomerLink>): CustomerLink => ({
  id: 'l1', customerEmail: 'mia@example.com', leadEmail: null, leadMobile: null, leadInstagram: null, leadCampaign: null, createdBy: 'ana@zoomy.ph', ...o,
});

const TRISHIA = P({email: 'miyaamgo@gmail.com', mobile: '09171488749'});
const TRIXIE = P({email: 'agustintrixie@gmail.com', mobile: '09171488749'});

describe('samePerson', () => {
  it('an IG-only lead typed "@Karla.Sy" and a contact logged as "karla.sy" are the same person (Review Focus 1)', () => {
    expect(samePerson(P({instagram: '@Karla.Sy'}), P({instagram: 'karla.sy'}), [])).toBe(true);
  });
  it('same email, any case', () => {
    expect(samePerson(P({email: 'Mia@Example.com'}), P({email: 'mia@example.com '}), [])).toBe(true);
  });
  it('two people sharing a household mobile with different emails are NOT merged (Review Focus 2)', () => {
    expect(samePerson(TRISHIA, TRIXIE, [])).toBe(false);
  });
  it('the same mobile joins when one side carries no email', () => {
    expect(samePerson(TRISHIA, P({mobile: '+63 917 148 8749'}), [])).toBe(true);
  });
  it('different keys: not the same person; no keys never match', () => {
    expect(samePerson(P({email: 'a@x.com'}), P({email: 'b@x.com'}), [])).toBe(false);
    expect(samePerson(P({}), P({}), [])).toBe(false);
  });
  it('a link {customer_email, lead_instagram} joins the customer and that Instagram handle, both ways', () => {
    const links = [L({customerEmail: 'mia@example.com', leadInstagram: 'karla.sy'})];
    expect(samePerson(P({email: 'mia@example.com'}), P({instagram: '@Karla.Sy'}), links)).toBe(true);
    expect(samePerson(P({instagram: 'karla.sy'}), P({email: 'MIA@example.com'}), links)).toBe(true);
    expect(samePerson(P({email: 'mia@example.com'}), P({instagram: 'other'}), links)).toBe(false);
    expect(samePerson(P({email: 'mia@example.com'}), P({instagram: 'karla.sy'}), [])).toBe(false); // unlinked: apart
  });
  it('a link by lead mobile does not pull in someone with that mobile and another email', () => {
    const links = [L({customerEmail: 'miyaamgo@gmail.com', leadMobile: '9171488749'})];
    expect(samePerson(P({email: 'miyaamgo@gmail.com'}), P({mobile: '09171488749'}), links)).toBe(true);
    expect(samePerson(P({email: 'other@x.com'}), TRIXIE, links)).toBe(false);
  });
});

describe('contactsOf', () => {
  it('null when the log is unreadable; otherwise the contacts of that person only', () => {
    const karla = C({instagram: 'karla.sy'});
    const mia = C({email: 'mia@example.com', channel: 'sms'});
    expect(contactsOf(P({instagram: '@Karla.Sy'}), null, [])).toBeNull();
    expect(contactsOf(P({instagram: '@Karla.Sy'}), [karla, mia], [])).toEqual([karla]);
    expect(contactsOf(P({email: 'mia@example.com'}), [karla, mia], [L({leadInstagram: 'karla.sy'})])).toEqual([karla, mia]);
  });
  it('a person with no keys has no contacts', () => {
    expect(contactsOf(P({}), [C({instagram: 'karla.sy'})], [])).toEqual([]);
  });
});

describe('contactStatus', () => {
  it('the IG lead "@Karla.Sy" logged as karla.sy is contacted (Review Focus 1)', () => {
    const s = contactStatus(P({instagram: '@Karla.Sy'}), [C({instagram: 'karla.sy', contactedAt: '2026-11-21T03:00:00Z'})], []);
    expect(s).toEqual({state: 'contacted', lastAt: '2026-11-21T03:00:00Z', lastChannel: 'instagram'});
  });
  it('no logged contact: not contacted', () => {
    expect(contactStatus(P({email: 'mia@example.com'}), [C({instagram: 'karla.sy'})], [])).toEqual({state: 'not_contacted', lastAt: null, lastChannel: null});
  });
  it('any contact with replied: true gives replied; lastAt is the newest contact', () => {
    const s = contactStatus(P({email: 'mia@example.com'}), [
      C({email: 'mia@example.com', replied: true, contactedAt: '2026-11-18T02:00:00Z', channel: 'call'}),
      C({email: 'mia@example.com', contactedAt: '2026-11-22T02:00:00Z', channel: 'sms'}),
    ], []);
    expect(s).toEqual({state: 'replied', lastAt: '2026-11-22T02:00:00Z', lastChannel: 'sms'});
  });
  it('the household mobile: Trishia logged, Trixie stays not contacted (Review Focus 2)', () => {
    const log = [C({email: 'miyaamgo@gmail.com', mobile: '9171488749', channel: 'sms'})];
    expect(contactStatus(TRISHIA, log, []).state).toBe('contacted');
    expect(contactStatus(TRIXIE, log, []).state).toBe('not_contacted');
  });
  it('an unreadable log is unknown, never not contacted', () => {
    expect(contactStatus(P({email: 'mia@example.com'}), null, [])).toEqual({state: 'unknown', lastAt: null, lastChannel: null});
  });
  it('a person with no email, Instagram or mobile is unknown (Review Focus 5)', () => {
    expect(contactStatus(P({}), [C({instagram: 'karla.sy'})], [])).toEqual({state: 'unknown', lastAt: null, lastChannel: null});
  });
});

describe('review fixes', () => {
  it('a contact keyed only by mobile does not join a person with an email (Trishia), but joins a mobile-only lead', () => {
    const mobileOnly = C({mobile: '9171488749', channel: 'sms'});
    expect(contactsOf(TRISHIA, [mobileOnly], [])).toEqual([]);
    expect(contactsOf(TRIXIE, [mobileOnly], [])).toEqual([]);
    expect(contactStatus(TRISHIA, [mobileOnly], []).state).toBe('not_contacted');
    expect(contactsOf(P({mobile: '0917 148 8749'}), [mobileOnly], [])).toEqual([mobileOnly]);
    expect(contactStatus(P({mobile: '09171488749'}), [mobileOnly], []).state).toBe('contacted');
  });
  it('person-vs-person matching is unchanged: Trishia and a mobile-only lead are the same person', () => {
    expect(samePerson(TRISHIA, P({mobile: '9171488749'}), [])).toBe(true);
  });
  it('a mobile-only contact still joins the customer a Same person link ties that mobile to', () => {
    const mobileOnly = C({mobile: '9171488749', channel: 'sms'});
    const links = [L({customerEmail: 'miyaamgo@gmail.com', leadMobile: '9171488749'})];
    expect(contactsOf(TRISHIA, [mobileOnly], links)).toEqual([mobileOnly]);
    expect(contactsOf(TRIXIE, [mobileOnly], links)).toEqual([]);
  });
  it('the legacy log (no Instagram / mobile / replied columns): a person without an email is unknown', () => {
    const log = [C({email: 'mia@example.com'})];
    expect(contactStatus(P({instagram: '@Karla.Sy'}), log, [], {legacy: true})).toEqual({state: 'unknown', lastAt: null, lastChannel: null});
    expect(contactStatus(P({mobile: '09171488749'}), log, [], {legacy: true}).state).toBe('unknown');
    expect(contactsOf(P({instagram: 'karla.sy'}), log, [], {legacy: true})).toBeNull();
  });
  it('the legacy log: a person with an email keeps contacted / not contacted', () => {
    const log = [C({email: 'mia@example.com', channel: 'sms', contactedAt: '2026-11-10T02:00:00Z'})];
    expect(contactStatus(P({email: 'mia@example.com', instagram: 'karla.sy'}), log, [], {legacy: true})).toEqual({state: 'contacted', lastAt: '2026-11-10T02:00:00Z', lastChannel: 'sms'});
    expect(contactStatus(P({email: 'leo@example.com'}), log, [], {legacy: true}).state).toBe('not_contacted');
  });
  it('a contact whose contactedAt does not parse is ignored when picking the last contact', () => {
    const s = contactStatus(P({email: 'mia@example.com'}), [
      C({email: 'mia@example.com', contactedAt: 'not a date', channel: 'call'}),
      C({email: 'mia@example.com', contactedAt: '2026-11-12T02:00:00Z', channel: 'sms'}),
    ], []);
    expect(s).toEqual({state: 'contacted', lastAt: '2026-11-12T02:00:00Z', lastChannel: 'sms'});
    expect(contactStatus(P({email: 'mia@example.com'}), [C({email: 'mia@example.com', contactedAt: 'x'})], [])).toEqual({state: 'contacted', lastAt: null, lastChannel: null});
  });
});

// Review fix (whole-branch review, RET-17): one household phone, two different Instagram handles = two people, like two emails.
describe('samePerson: household mobile with different Instagram handles', () => {
  it('two leads with different IG handles and the same mobile are NOT the same person', () => {
    expect(samePerson(P({instagram: 'karla.sy', mobile: '09171488749'}), P({instagram: 'bea.cat', mobile: '0917 148 8749'}), [])).toBe(false);
  });
  it('same mobile, one side without IG, still joins', () => {
    expect(samePerson(P({instagram: 'karla.sy', mobile: '09171488749'}), P({mobile: '09171488749'}), [])).toBe(true);
  });
  it('a contact logged by IG + mobile does not land on another IG handle sharing that mobile', () => {
    const log = [C({instagram: 'bea.cat', mobile: '9171488749'})];
    expect(contactStatus(P({instagram: 'karla.sy', mobile: '09171488749'}), log, []).state).toBe('not_contacted');
  });
});

describe('keys that cannot be logged are not keys (status Unknown, no Log)', () => {
  it('a lead with only an invalid IG handle and a junk mobile is unknown', () => {
    expect(contactStatus(P({instagram: '@karla sy', mobile: 'N/A'}), [], []).state).toBe('unknown');
  });
});
