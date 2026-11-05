import {describe, it, expect} from 'vitest';
import {shouldRedirectFromZoomy, homeFor, healthReportAccess} from './company-nav';

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

describe('healthReportAccess', () => {
  const zoomy = {companyId: 'zoomy', isCoopAdmin: false, canSeeData: true};
  it('lets a Zoomy data viewer and a Coop Admin in', () => {
    expect(healthReportAccess(zoomy)).toBe('allow');
    expect(healthReportAccess({companyId: null, isCoopAdmin: true, canSeeData: false})).toBe('allow');
  });
  it('bounces a Goldline view, even one held by a Coop Admin holder', () => {
    expect(healthReportAccess({companyId: 'goldline', isCoopAdmin: false, canSeeData: true})).toBe('bounce');
  });
  it('bounces a non-data view with no company', () => {
    expect(healthReportAccess({companyId: null, isCoopAdmin: false, canSeeData: false})).toBe('bounce');
  });
  it('leaves signed-out / no-membership (null) to the sign-in flow', () => {
    expect(healthReportAccess(null)).toBe('signin');
  });
});
