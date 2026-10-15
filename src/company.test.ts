import {describe, it, expect} from 'vitest';
import {
  resolveActive,
  membershipViews,
  viewKey,
  switchableCompanies,
  isCoopAdmin,
  canEditData,
  canManageRoles,
  outOfScopeStores,
  COOP_VIEW_KEY,
  type Membership,
} from './company';

const coop: Membership = {companyId: null, role: 'coop_admin'};
const zoomyAdmin: Membership = {companyId: 'zoomy', role: 'company_admin'};
const goldlineAdmin: Membership = {companyId: 'goldline', role: 'company_admin'};
const goldlineAnalyst: Membership = {companyId: 'goldline', role: 'analyst'};
const storeMgr: Membership = {companyId: 'goldline', role: 'store_manager', storeScope: ['GL-013']};

describe('viewKey + membershipViews', () => {
  it('keys a company by id and the cross-tenant row by the sentinel', () => {
    expect(viewKey(zoomyAdmin)).toBe('zoomy');
    expect(viewKey(coop)).toBe(COOP_VIEW_KEY);
  });
  it('orders company views (alphabetical) before the Coop Admin view', () => {
    expect(membershipViews([coop, zoomyAdmin, goldlineAdmin]).map((v) => v.key)).toEqual([
      'goldline',
      'zoomy',
      'coop_admin',
    ]);
  });
});

describe('resolveActive (multi-role, view-based)', () => {
  it('returns null when the user has no memberships', () => {
    expect(resolveActive([])).toBeNull();
  });

  it('the Coop Admin view is data-blind and cross-tenant', () => {
    expect(resolveActive([coop])).toMatchObject({
      companyId: null,
      role: 'coop_admin',
      isCoopAdmin: true,
      canSeeData: false,
    });
  });

  it('multi-role defaults to a company (data) view, NOT coop_admin', () => {
    const ctx = resolveActive([zoomyAdmin, coop]);
    expect(ctx).toMatchObject({companyId: 'zoomy', isCoopAdmin: false, canSeeData: true});
  });

  it('multi-role: selecting the coop_admin view resolves to data-blind', () => {
    const ctx = resolveActive([zoomyAdmin, coop], 'coop_admin');
    expect(ctx).toMatchObject({companyId: null, isCoopAdmin: true, canSeeData: false});
  });

  it('a single company member resolves to that company, with data access', () => {
    expect(resolveActive([goldlineAdmin])).toMatchObject({
      companyId: 'goldline',
      role: 'company_admin',
      canSeeData: true,
    });
  });

  it('honors the requested view when the user holds it', () => {
    const ctx = resolveActive([zoomyAdmin, goldlineAnalyst], 'goldline');
    expect(ctx).toMatchObject({companyId: 'goldline', role: 'analyst'});
  });

  it('falls back to the first view (alphabetical) when the requested one is not held', () => {
    const ctx = resolveActive([zoomyAdmin, goldlineAnalyst], 'nope');
    expect(ctx?.companyId).toBe('goldline');
  });

  it('carries store scope for a store manager', () => {
    expect(resolveActive([storeMgr])?.storeScope).toEqual(['GL-013']);
  });
});

describe('switchableCompanies', () => {
  it('lists only real companies (never the cross-tenant null)', () => {
    expect(switchableCompanies([coop, zoomyAdmin, goldlineAdmin])).toEqual(['zoomy', 'goldline']);
  });
});

describe('role capabilities', () => {
  it('isCoopAdmin', () => {
    expect(isCoopAdmin('coop_admin')).toBe(true);
    expect(isCoopAdmin('company_admin')).toBe(false);
  });

  it('canEditData: company_admin + store_manager write, analyst does not, coop_admin never', () => {
    expect(canEditData('company_admin')).toBe(true);
    expect(canEditData('store_manager')).toBe(true);
    expect(canEditData('analyst')).toBe(false);
    expect(canEditData('coop_admin')).toBe(false);
  });

  it('canManageRoles: only coop_admin', () => {
    expect(canManageRoles('coop_admin')).toBe(true);
    expect(canManageRoles('company_admin')).toBe(false);
    expect(canManageRoles('analyst')).toBe(false);
    expect(canManageRoles('store_manager')).toBe(false);
  });
});

describe('outOfScopeStores', () => {
  it('returns [] when scope is null/empty (no restriction)', () => {
    expect(outOfScopeStores(null, ['A', 'B'])).toEqual([]);
    expect(outOfScopeStores(undefined, ['A'])).toEqual([]);
    expect(outOfScopeStores([], ['A', 'B'])).toEqual([]);
  });
  it('returns the codes outside the allowed set, de-duplicated', () => {
    expect(outOfScopeStores(['A'], ['A', 'B', 'B', 'C'])).toEqual(['B', 'C']);
  });
  it('returns [] when every code is in scope', () => {
    expect(outOfScopeStores(['A', 'B'], ['A', 'B', 'A'])).toEqual([]);
  });
});
