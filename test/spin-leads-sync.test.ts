import {describe, expect, it} from 'vitest';
import {newSpinLeadRows, splitContact, type RemoteSpinLead} from '../src/spin-leads-sync';

const remote = (over: Partial<RemoteSpinLead> = {}): RemoteSpinLead => ({
  contact: '@andrhey16', phone: null, pet: 'Nyx / Puspin', picky: 'No', prize: 'free-item',
  campaign: 'oct-market', subscribedAt: '2026-10-12T23:43:05.120Z', consentAt: '2026-10-12T23:43:05.120Z', ...over,
});

describe('spin-lead sync', () => {
  it('splits a contact the way the CSV import does', () => {
    expect(splitContact('@KylRvr')).toEqual({email: null, instagram: 'kylrvr'});
    expect(splitContact(' A@x.com ')).toEqual({email: 'A@x.com', instagram: null});
    expect(splitContact('not-a-contact')).toBeNull();
    expect(splitContact('@')).toBeNull();
  });

  it('turns a new Shopify lead into a table row with its prize label', () => {
    expect(newSpinLeadRows([remote()], [])).toEqual([{
      email: null, instagram: 'andrhey16', pet: 'Nyx / Puspin', picky: 'No', mobile: null, prize: 'Free Zoomy! Item',
      campaign: 'oct-market', collected_at: '2026-10-12T23:43:05.120Z', consent_at: '2026-10-12T23:43:05.120Z',
    }]);
    expect(newSpinLeadRows([remote({prize: 'peso300'})], [])[0].prize).toBe('₱300 Off');
    // A prize Coop has never seen keeps its id rather than vanishing.
    expect(newSpinLeadRows([remote({prize: 'mystery-box'})], [])[0].prize).toBe('mystery-box');
  });

  // The reason contact (not contact + time) decides "new": CSV rows hold
  // minute-rounded times, Shopify holds seconds.
  it('skips contacts already in the table, whatever their stored time', () => {
    const existing = [{email: null, instagram: 'andrhey16'}, {email: 'Old@x.com', instagram: null}];
    const rows = newSpinLeadRows([remote(), remote({contact: 'old@X.com'}), remote({contact: '@NewOne'})], existing);
    expect(rows.map((r) => r.instagram ?? r.email)).toEqual(['newone']);
  });

  it('dates a returning subscriber by the spin (consent), not their first signup', () => {
    const [row] = newSpinLeadRows([remote({subscribedAt: '2026-06-03T07:30:00Z', consentAt: '2026-10-11T12:56:00Z'})], []);
    expect(row.collected_at).toBe('2026-10-11T12:56:00Z');
    // Older rows without a consent time fall back to the signup time.
    expect(newSpinLeadRows([remote({consentAt: null})], [])[0].collected_at).toBe('2026-10-12T23:43:05.120Z');
  });

  it('drops leads with no usable contact or time, and a contact listed twice', () => {
    const rows = newSpinLeadRows(
      [remote({contact: 'junk'}), remote({consentAt: null, subscribedAt: null}), remote({contact: '@dup'}), remote({contact: '@DUP'})],
      [],
    );
    expect(rows.map((r) => r.instagram)).toEqual(['dup']);
  });
});
