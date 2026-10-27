import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {coverage, parseCsv, proposeAliases, rowsToApply, toCsv, type Observed} from '../src/sku-alias-csv';

const products = [{product_id: 'ZMYFDMEATBEFWHL01', name: 'Freeze-Dried Beef Whole'}, {product_id: 'ZMYFDMEATDCKWHL01', name: 'Freeze-Dried Duck Whole'}];
const seen: Observed[] = [
  {channel: 'shopee', alias_type: 'sku', alias_value: 'zmyfdmeatbefwhl01', label: 'Beef'},
  {channel: 'shopee', alias_type: 'sku', alias_value: 'ZMY-LEGACY1', label: 'Old'},
  {channel: 'website', alias_type: 'title', alias_value: 'Freeze-dried  beef whole', label: 'x'},
  {channel: 'website', alias_type: 'sku', alias_value: 'WEB-1', label: 'y'},
  {channel: 'website', alias_type: 'sku', alias_value: 'WEB-1', label: 'dup'},
];

describe('sku alias csv', () => {
  it('proposes exact SKU matches as auto and everything else as unconfirmed proposals', () => {
    const rows = proposeAliases(seen, products);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({source: 'auto', confirmed: 'yes', product_id: 'ZMYFDMEATBEFWHL01'});
    expect(rows[1]).toMatchObject({source: 'manual', confirmed: 'no', product_id: ''});
    expect(rows[2]).toMatchObject({source: 'manual', confirmed: 'no', product_id: 'ZMYFDMEATBEFWHL01'});
  });
  it('round-trips through CSV, quoting commas', () => {
    const rows = proposeAliases([{channel: 'website', alias_type: 'title', alias_value: 'Duo, big', label: 'q"q'}], products);
    expect(parseCsv(toCsv(rows))[0]).toMatchObject({alias_value: 'Duo, big', label: 'q"q'});
  });
  it('apply writes only auto and confirmed rows, and says why it skipped the rest', () => {
    const csv = proposeAliases(seen, products);
    csv[1].product_id = 'ZMYFDMEATDCKWHL01'; // edited but NOT confirmed
    csv[2].confirmed = 'yes';
    const {apply, skipped} = rowsToApply(csv, products, '2026-10-26T00:00:00Z');
    expect(apply.map((r) => r.alias_value)).toEqual(['zmyfdmeatbefwhl01', 'Freeze-dried  beef whole']);
    expect(skipped.map((s) => s.reason)).toEqual(['not confirmed', 'not confirmed']);
  });
  it('rejects a product that is not in the POS, and a fake auto row', () => {
    const base = {channel: 'shopee' as const, alias_type: 'sku' as const, alias_value: 'A', label: '', product_id: 'NOPE', bundle_id: '', component_qty: 1, valid_from: '', valid_to: ''};
    const r = rowsToApply([{...base, source: 'manual', confirmed: 'yes'}, {...base, product_id: 'ZMYFDMEATBEFWHL01', source: 'auto', confirmed: 'yes'}], products, 'now');
    expect(r.apply).toEqual([]);
    expect(r.skipped).toHaveLength(2);
  });
  it('the shipped example is synthetic and parses', () => {
    const rows = parseCsv(readFileSync('scripts/sku-aliases.example.csv', 'utf8'));
    expect(rows).toHaveLength(4);
    expect(rowsToApply(rows, products, 'now').apply).toHaveLength(2);
  });
  it('coverage counts distinct identifiers with an alias per channel', () => {
    expect(coverage(seen, [{channel: 'shopee', alias_type: 'sku', alias_value: 'ZMYFDMEATBEFWHL01'}])).toEqual({shopee: {observed: 2, mapped: 1}, website: {observed: 2, mapped: 0}});
  });
});
