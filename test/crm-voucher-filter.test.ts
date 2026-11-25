import {describe, expect, it} from 'vitest';
import {codesUsedList, EMPTY_CUSTOMER_FILTER, filterCustomers, voucherMatch, voucherOptions} from '../src/crm-compute';

const row = (id: string, orderCount: number, codesUsed: string[] | null) =>
  ({shopifyCustomerId: id, email: `${id}@example.com`, firstName: id, lastName: null, phone: null, petName: null, membershipTier: null, orderCount, codesUsed}) as never;

const rows = [
  row('a', 1, ['GRAND300']),
  row('b', 2, ['GRAND300', 'FAM40']),
  row('c', 1, []), // bought, never used a code
  row('d', 0, null), // never ordered
  row('e', 3, null), // orders unknown
  row('f', 1, ['FAM40']),
  row('g', 1, ['FAM40']),
];
const ids = (r: Array<{shopifyCustomerId: string}>) => r.map((x) => x.shopifyCustomerId);

describe('voucher filter (Customers tab)', () => {
  it('all keeps everyone', () => {
    expect(filterCustomers(rows, EMPTY_CUSTOMER_FILTER, '')).toHaveLength(rows.length);
  });
  it('a code keeps only buyers who used it on any order, case-insensitive', () => {
    expect(ids(filterCustomers(rows, {...EMPTY_CUSTOMER_FILTER, voucher: 'grand300'}, ''))).toEqual(['a', 'b']);
  });
  it('any = buyers with at least one code; none = buyers who used no code', () => {
    expect(ids(filterCustomers(rows, {...EMPTY_CUSTOMER_FILTER, voucher: 'any'}, ''))).toEqual(['a', 'b', 'f', 'g']);
    expect(ids(filterCustomers(rows, {...EMPTY_CUSTOMER_FILTER, voucher: 'none'}, ''))).toEqual(['c']);
  });
  it('unknown orders and non-buyers never match "none" (unknown is never "never")', () => {
    expect(voucherMatch(row('d', 0, null), 'none')).toBe(false);
    expect(voucherMatch(row('e', 3, null), 'none')).toBe(false);
  });
  it('search matches a voucher code', () => {
    expect(ids(filterCustomers(rows, EMPTY_CUSTOMER_FILTER, 'fam4'))).toEqual(['b', 'f', 'g']);
  });
  it('options list each code with its buyers, most first; codesUsedList keeps the same order', () => {
    expect(voucherOptions(rows)).toEqual([{code: 'FAM40', buyers: 3}, {code: 'GRAND300', buyers: 2}]);
    expect(codesUsedList(rows)).toEqual(['FAM40', 'GRAND300']);
  });
  it('a filter without voucher (Ask Coop tool) still works', () => {
    expect(filterCustomers(rows, {tier: 'all', buyers: 'buyers'}, '')).toHaveLength(6);
  });
});
