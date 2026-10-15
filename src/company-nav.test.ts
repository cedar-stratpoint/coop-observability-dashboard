import {describe, it, expect} from 'vitest';
import {shouldRedirectFromZoomy, homeFor} from './company-nav';

describe('shouldRedirectFromZoomy', () => {
  it('leaves signed-out / no-membership alone (null ctx)', () => {
    expect(shouldRedirectFromZoomy(null)).toBe(false);
  });
  it('lets Zoomy through', () => {
    expect(shouldRedirectFromZoomy({companyId: 'zoomy'})).toBe(false);
  });
  it('redirects a Goldline user and the data-blind Coop Admin (null companyId)', () => {
    expect(shouldRedirectFromZoomy({companyId: 'goldline'})).toBe(true);
    expect(shouldRedirectFromZoomy({companyId: null})).toBe(true);
  });
});

describe('homeFor', () => {
  it('sends a Coop Admin to the role console, a company view to its overview', () => {
    expect(homeFor({isCoopAdmin: true})).toBe('/admin/users');
    expect(homeFor({isCoopAdmin: false})).toBe('/overview');
    expect(homeFor(null)).toBe('/overview');
    expect(homeFor({isCoopAdmin: false, companyId: 'zoomy'})).toBe('/');
    expect(homeFor({isCoopAdmin: false, companyId: 'goldline'})).toBe('/overview');
  });
});
