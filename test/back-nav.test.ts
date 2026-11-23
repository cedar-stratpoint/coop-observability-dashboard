import {describe, expect, it} from 'vitest';
import {isLocalPath, mergeListParams, parseReturnEntry, readListParams, RETURN_TTL_MS, returnHref, type ReturnEntry} from '../src/back-nav';

const DEFAULTS = {filter: 'all', q: '', page: '1'};

describe('list params', () => {
  it('drops defaults and keeps params the list does not own', () => {
    expect(mergeListParams('store=S1', DEFAULTS, {filter: 'out', q: '', page: '1'})).toBe('store=S1&filter=out');
    expect(mergeListParams('store=S1&filter=out&page=3', DEFAULTS, {filter: 'all', q: '', page: '1'})).toBe('store=S1');
  });

  it('round-trips through the URL, falling back to defaults', () => {
    const qs = mergeListParams('', DEFAULTS, {filter: 'healthy', q: 'lip tint', page: '2'});
    expect(readListParams(qs, DEFAULTS)).toEqual({filter: 'healthy', q: 'lip tint', page: '2'});
    expect(readListParams('store=S1', DEFAULTS)).toEqual(DEFAULTS);
  });
});

describe('return entry', () => {
  const now = 1_800_000_000_000;
  const entry = (over: Partial<ReturnEntry> = {}) => JSON.stringify({url: '/stock?filter=out&page=2', scrollY: 640, rowId: 'GL-01', at: now - 1000, to: '/stock/GL-01', ...over});

  it('parses a good entry', () => {
    expect(parseReturnEntry(entry(), now)).toEqual({url: '/stock?filter=out&page=2', scrollY: 640, rowId: 'GL-01', at: now - 1000, to: '/stock/GL-01'});
  });

  it('rejects stale, future, malformed and off-site entries', () => {
    expect(parseReturnEntry(entry({at: now - RETURN_TTL_MS - 1}), now)).toBeNull();
    expect(parseReturnEntry(entry({at: now + 120_000}), now)).toBeNull();
    expect(parseReturnEntry('{nope', now)).toBeNull();
    expect(parseReturnEntry(null, now)).toBeNull();
    expect(parseReturnEntry(entry({url: '//evil.example/stock'}), now)).toBeNull();
    expect(parseReturnEntry(entry({url: 'https://evil.example/stock'}), now)).toBeNull();
  });

  it('clamps a bad scroll position to the top', () => {
    expect(parseReturnEntry(entry({scrollY: -5}), now)?.scrollY).toBe(0);
  });
});

describe('returnHref', () => {
  const e: ReturnEntry = {url: '/stock?store=S1&filter=out', scrollY: 0, rowId: null, at: 0, to: '/stock/X'};

  it('returns to the remembered list when it is the same list', () => {
    expect(returnHref(e, '/stock?store=S1')).toBe('/stock?store=S1&filter=out');
  });

  it('uses the fixed parent for another list or no entry', () => {
    expect(returnHref(e, '/stock/restock')).toBe('/stock/restock');
    expect(returnHref(null, '/stock')).toBe('/stock');
  });
});

describe('isLocalPath', () => {
  it('accepts same-origin paths only', () => {
    expect(isLocalPath('/uploads?x=1')).toBe(true);
    expect(isLocalPath('//x.com')).toBe(false);
    expect(isLocalPath('/\\x.com')).toBe(false);
    expect(isLocalPath('x')).toBe(false);
  });
});
