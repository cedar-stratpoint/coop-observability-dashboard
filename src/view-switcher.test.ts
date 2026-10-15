import {describe, expect, it} from 'vitest';
import {companyHue, groupViews, monogram, type SwitcherView} from './view-switcher';

const v = (companyId: string | null, name: string, role = 'company_admin'): SwitcherView => ({
  key: companyId ?? 'coop_admin',
  companyId,
  role,
  name,
});

describe('groupViews', () => {
  it('pins Coop Admin and sorts companies A–Z by name', () => {
    const {coop, companies} = groupViews([v('zoomy', 'Zoomy'), v(null, 'Coop Admin', 'coop_admin'), v('goldline', 'Goldline Cosmetics'), v('acme', 'acme labs')]);
    expect(coop?.key).toBe('coop_admin');
    expect(companies.map((c) => c.name)).toEqual(['acme labs', 'Goldline Cosmetics', 'Zoomy']);
  });

  it('has no Coop section when the user is not a Coop Admin', () => {
    const {coop, companies} = groupViews([v('zoomy', 'Zoomy'), v('goldline', 'Goldline Cosmetics')]);
    expect(coop).toBeNull();
    expect(companies).toHaveLength(2);
  });
});

describe('companyHue', () => {
  it('is fixed for known tenants and stable for others', () => {
    expect(companyHue('goldline')).toBe(75);
    expect(companyHue('acme')).toBe(companyHue('acme'));
    expect(typeof companyHue('acme')).toBe('number');
  });
});

describe('monogram', () => {
  it('uses up to two initials', () => {
    expect(monogram('Goldline Cosmetics')).toBe('GC');
    expect(monogram('Zoomy')).toBe('Z');
    expect(monogram('  ')).toBe('?');
  });
});
