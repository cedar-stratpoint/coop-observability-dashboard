import {describe, expect, it} from 'vitest';
import {matchesLeadSearch, type SpinLead} from '../src/spin-leads-types';

const lead: SpinLead = {
  email: 'Ana.Cruz@gmail.com', instagram: 'mimi_cat', name: 'Ana Cruz', pet: 'Mimi / Puspin', picky: null,
  mobile: '0917 123 4567', prize: 'Free treat', campaign: null, collectedAt: '2026-11-01T10:00:00+08:00',
};

describe('matchesLeadSearch', () => {
  it('empty query matches everyone', () => expect(matchesLeadSearch(lead, '  ')).toBe(true));
  it('name, email, pet, case-insensitive', () => {
    expect(matchesLeadSearch(lead, 'ana cruz')).toBe(true);
    expect(matchesLeadSearch(lead, 'GMAIL')).toBe(true);
    expect(matchesLeadSearch(lead, 'puspin')).toBe(true);
  });
  it('handle with or without @', () => {
    expect(matchesLeadSearch(lead, '@mimi_cat')).toBe(true);
    expect(matchesLeadSearch(lead, 'mimi_')).toBe(true);
  });
  it('mobile ignores spaces and dashes', () => {
    expect(matchesLeadSearch(lead, '09171234567')).toBe(true);
    expect(matchesLeadSearch(lead, '123-4567')).toBe(true);
  });
  it('no match', () => {
    expect(matchesLeadSearch(lead, 'pedro')).toBe(false);
    expect(matchesLeadSearch({...lead, mobile: null}, '0917')).toBe(false);
  });
});
