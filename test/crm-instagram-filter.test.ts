import {describe, expect, it} from 'vitest';
import {instagramState, matchesInstagramFilter, type CustomerBooth} from '../src/customer-links';

const found = (instagram: string | null): CustomerBooth => ({instagram, booth: [], source: 'exact', links: []});
const READ = {leads: true, links: true};

describe('Instagram filter (owner 2026-11-25)', () => {
  it('has / none / unknown', () => {
    expect(instagramState(found('karla.sy'), READ)).toBe('has');
    expect(instagramState(found(null), READ)).toBe('none');
    expect(instagramState(undefined, READ)).toBe('none');
    expect(instagramState(undefined, {leads: false, links: true})).toBe('unknown');
    expect(instagramState(found('karla.sy'), {leads: false, links: false})).toBe('has');
  });
  it('unknown matches neither has nor none', () => {
    expect(matchesInstagramFilter('has', 'unknown')).toBe(false);
    expect(matchesInstagramFilter('none', 'unknown')).toBe(false);
    expect(matchesInstagramFilter('all', 'unknown')).toBe(true);
    expect(matchesInstagramFilter('has', 'has')).toBe(true);
  });
});
