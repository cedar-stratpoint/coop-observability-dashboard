import {describe, expect, it} from 'vitest';
import {pickCookieView, startViewKey, viewCookieValue, viewFromCookie, type Membership} from './company';

const m = (companyId: string | null, role = companyId ? 'company_admin' : 'coop_admin') =>
  ({companyId, role, storeScope: null}) as unknown as Membership;
const multi = [m('zoomy'), m('goldline'), m(null)];

describe('startViewKey', () => {
  it('uses the pinned default when still held', () => {
    expect(startViewKey(multi, {defaultView: 'coop_admin', lastView: 'zoomy'})).toBe('coop_admin');
  });
  it('falls back to the most recent view when nothing is pinned', () => {
    expect(startViewKey(multi, {defaultView: null, lastView: 'zoomy'})).toBe('zoomy');
  });
  it('skips views the user no longer holds', () => {
    expect(startViewKey(multi, {defaultView: 'acme', lastView: 'goldline'})).toBe('goldline');
    expect(startViewKey([m('zoomy')], {defaultView: 'goldline', lastView: 'coop_admin'})).toBe('zoomy');
  });
  it('defaults to the first view with no preferences, null with no views', () => {
    expect(startViewKey(multi, null)).toBe('goldline');
    expect(startViewKey([], {defaultView: 'zoomy', lastView: null})).toBeNull();
  });
});

describe('view cookie bound to a sign-in', () => {
  it('reads back only for the same sign-in', () => {
    const raw = viewCookieValue('sid-1', 'zoomy');
    expect(viewFromCookie(raw, 'sid-1')).toBe('zoomy');
    expect(viewFromCookie(raw, 'sid-2')).toBeNull();
  });
  it('ignores the old bare format and missing values', () => {
    expect(viewFromCookie('zoomy', 'sid-1')).toBeNull();
    expect(viewFromCookie(null, 'sid-1')).toBeNull();
    expect(viewFromCookie('sid-1:', 'sid-1')).toBeNull();
    expect(viewFromCookie('sid-1:zoomy', null)).toBeNull();
  });
});

describe('pickCookieView', () => {
  it('new sessions: this sign-in\'s choice, else the starting view', () => {
    expect(pickCookieView('sid-1:zoomy', 'sid-1', 'goldline')).toBe('zoomy');
    expect(pickCookieView('old:zoomy', 'sid-1', 'goldline')).toBe('goldline');
    expect(pickCookieView(null, 'sid-1', 'coop_admin')).toBe('coop_admin');
  });
  it('sessions from before the change keep the old behaviour', () => {
    expect(pickCookieView('zoomy', null, null)).toBe('zoomy');
    expect(pickCookieView('sid-9:goldline', undefined, null)).toBe('goldline');
    expect(pickCookieView(null, null, null)).toBeNull();
  });
});
