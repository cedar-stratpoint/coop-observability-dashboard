// RET-17 Task 4 (plan knowledge/tasks/2026-11-25-ret17-implementation-plan.md): the Event leads page is status first. Counts per
// status, the Status filter, and "logging moves a lead out of Not contacted". Unknown is never counted as "Not contacted"
// (Review Focus 5): a lead with no email, Instagram or mobile, or one whose log cannot be read, is 'unknown'.
import {describe, expect, it} from 'vitest';
import type {CustomerContact} from '../src/customer-contacts';
import type {CustomerLink} from '../src/customer-links';
import {contactStatusLabel, filterByStatus, leadsCsv, leadStatusCounts, leadStatuses, type SpinLead} from '../src/spin-leads-types';
import {leadKey} from '../src/lead-order-match';

const lead = (o: Partial<SpinLead>): SpinLead => ({
  email: null, instagram: null, name: null, pet: null, picky: null, mobile: null, prize: 'Free treat', campaign: 'modern-market-nov2026',
  collectedAt: '2026-11-15T03:00:00Z', ...o,
});
let n = 0;
const contact = (o: Partial<CustomerContact>): CustomerContact => ({
  id: `c${++n}`, email: null, instagram: null, mobile: null, channel: 'instagram', note: null, replied: false,
  contactedAt: '2026-11-20T02:00:00Z', createdBy: 'ana@zoomy.ph', ...o,
});

const IG_ONLY = lead({instagram: 'Karla.Sy', collectedAt: '2026-11-15T03:01:00Z'});
const EMAIL_ONLY = lead({email: 'mia@example.com', collectedAt: '2026-11-15T03:02:00Z'});
const MOBILE_ONLY = lead({mobile: '0917 148 8749', collectedAt: '2026-11-15T03:03:00Z'});
const REPLIED = lead({email: 'jo@example.com', instagram: 'jo.pets', collectedAt: '2026-11-15T03:04:00Z'});
const NOT_YET = lead({instagram: 'bea.cat', collectedAt: '2026-11-15T03:05:00Z'});
const NO_KEYS = lead({name: 'Walk-in', collectedAt: '2026-11-15T03:06:00Z'});
const LEADS = [IG_ONLY, EMAIL_ONLY, MOBILE_ONLY, REPLIED, NOT_YET, NO_KEYS];

const LOG = [
  contact({instagram: 'karla.sy', channel: 'instagram'}), // IG-only lead typed "Karla.Sy", logged as "karla.sy" (Review Focus 1)
  contact({email: 'jo@example.com', channel: 'email'}),
  contact({instagram: 'jo.pets', replied: true, contactedAt: '2026-11-21T02:00:00Z'}),
];
const LINKS: CustomerLink[] = [];

describe('leadStatusCounts', () => {
  it('counts each lead once by its status; a lead with no keys is unknown, never not contacted', () => {
    expect(leadStatusCounts(LEADS, LOG, LINKS)).toEqual({not_contacted: 3, contacted: 1, replied: 1, unknown: 1});
  });
  it('an unreadable log makes every lead unknown (never "not contacted")', () => {
    expect(leadStatusCounts(LEADS, null, LINKS)).toEqual({not_contacted: 0, contacted: 0, replied: 0, unknown: 6});
  });
  it('on the legacy log (no Instagram / mobile columns) only leads with an email have a known status', () => {
    expect(leadStatusCounts(LEADS, LOG.filter((c) => c.email), LINKS, {legacy: true})).toEqual({not_contacted: 1, contacted: 1, replied: 0, unknown: 4});
  });
});

describe('filterByStatus', () => {
  it("'not_contacted' excludes unknown and no-key leads", () => {
    expect(filterByStatus(LEADS, 'not_contacted', LOG, LINKS)).toEqual([EMAIL_ONLY, MOBILE_ONLY, NOT_YET]);
    expect(filterByStatus(LEADS, 'not_contacted', null, LINKS)).toEqual([]);
  });
  it("'all' keeps every lead; 'replied' and 'unknown' pick theirs", () => {
    expect(filterByStatus(LEADS, 'all', LOG, LINKS)).toEqual(LEADS);
    expect(filterByStatus(LEADS, 'replied', LOG, LINKS)).toEqual([REPLIED]);
    expect(filterByStatus(LEADS, 'unknown', LOG, LINKS)).toEqual([NO_KEYS]);
  });
  it('logging a contact moves the lead out of not contacted', () => {
    const after = [contact({mobile: '9171488749', channel: 'sms'}), ...LOG];
    expect(filterByStatus(LEADS, 'not_contacted', after, LINKS)).toEqual([EMAIL_ONLY, NOT_YET]);
    expect(leadStatusCounts(LEADS, after, LINKS).contacted).toBe(2);
  });
});

describe('leadStatuses', () => {
  it('keys each status by leadKey, with the last contact day', () => {
    const s = leadStatuses(LEADS, LOG, LINKS);
    expect(s[leadKey(REPLIED)]).toEqual({state: 'replied', lastAt: '2026-11-21T02:00:00Z', lastChannel: 'instagram'});
    expect(s[leadKey(NO_KEYS)].state).toBe('unknown');
  });
});

describe('contactStatusLabel', () => {
  it('reads "Not contacted", "Contacted · <PH day>", "Replied · <PH day>", "Unknown"', () => {
    expect(contactStatusLabel({state: 'not_contacted', lastAt: null, lastChannel: null})).toBe('Not contacted');
    // 2026-11-20T17:00Z is already Nov 21 in Manila.
    expect(contactStatusLabel({state: 'contacted', lastAt: '2026-11-20T17:00:00Z', lastChannel: 'sms'})).toBe('Contacted · Nov 21');
    expect(contactStatusLabel({state: 'replied', lastAt: '2026-11-21T02:00:00Z', lastChannel: 'instagram'})).toBe('Replied · Nov 21');
    expect(contactStatusLabel({state: 'contacted', lastAt: null, lastChannel: null})).toBe('Contacted');
    expect(contactStatusLabel({state: 'unknown', lastAt: null, lastChannel: null})).toBe('Unknown');
  });
});

describe('leadsCsv', () => {
  it('has status, last contacted and replied first; unknown says Unknown, never No', () => {
    const s = leadStatuses(LEADS, LOG, LINKS);
    const rows = leadsCsv(LEADS, s, {}, '2026-11-25T03:00:00Z');
    expect(rows[1].slice(0, 3)).toEqual(['Status', 'Last contacted', 'Replied']);
    const byIg = (h: string) => rows.find((r) => r.includes(h))!;
    expect(byIg('@jo.pets').slice(0, 3)).toEqual(['Replied', 'Nov 21, 2026', 'Yes']);
    expect(byIg('@bea.cat').slice(0, 3)).toEqual(['Not contacted', 'Never', 'No']);
    expect(rows.find((r) => r.includes('Walk-in'))!.slice(0, 3)).toEqual(['Unknown', 'Unknown', 'Unknown']);
  });
});
