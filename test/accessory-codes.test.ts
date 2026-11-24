import {describe, expect, it} from 'vitest';
import {accessorySku, duplicateCodeMessage, withProductCodes} from '../src/accessory-codes';
import {printedPageItems} from '../src/goldline-printed-page';

describe('withProductCodes', () => {
  it.each(['legacy', 'v1', 'v2'])('gives the 19 accessories on %s page 4 their own product codes', (v) => {
    const items = printedPageItems(v, 4);
    const out = withProductCodes(items.map((i) => ({item_code: i.code})), v, 4).map((r) => r.item_code);
    const acc = out.filter((_, n) => /^ACCS/.test(items[n].code));
    expect(acc).toHaveLength(19);
    expect(new Set(acc).size).toBe(19);
    expect(acc).toEqual(expect.arrayContaining(['ACCS03', 'ACCS05', 'ACCS185', 'ACCS197', 'ACCSBELTBAG']));
    expect(duplicateCodeMessage(out.map((item_code) => ({item_code})))).toBeNull();
    // Everything that isn't an accessory keeps its printed code.
    out.forEach((c, n) => { if (!/^ACCS/.test(items[n].code)) expect(c).toBe(items[n].code); });
  });
  it('pairs by order and leaves older codes and extra rows alone', () => {
    const out = withProductCodes([{item_code: 'ACCS185'}, {item_code: 'ACCS 288'}, {item_code: 'ACCS 288'}], 'v1', 4).map((r) => r.item_code);
    expect(out).toEqual(['ACCS185', 'ACCS185', 'ACCS193']);
    expect(withProductCodes([{item_code: 'FBPP01'}], 'v1', 1)).toEqual([{item_code: 'FBPP01'}]);
  });
  it('keeps the counts on each row', () => {
    expect(withProductCodes([{item_code: 'ACCS 288', ending_on_hand: 4}], 'v2', 4)[0]).toEqual({item_code: 'ACCS185', ending_on_hand: 4});
  });
});

describe('accessorySku / duplicateCodeMessage', () => {
  it('reads the product code from the printed name', () => {
    expect(accessorySku({code: 'ACCS 150', product: 'Nichido Angled Eyebrow Brush #251'})).toBe('ACCS251');
    expect(accessorySku({code: 'ACCS 600', product: 'Nichido Belt Bag'})).toBe('ACCSBELTBAG');
    expect(accessorySku({code: 'FBPP01', product: 'Salmon #2'})).toBeNull();
  });
  it('names the rows that still share a code', () => {
    expect(duplicateCodeMessage([{item_code: 'A'}, {item_code: 'B'}, {item_code: 'A'}])).toMatch(/^Rows 1, 3 all have item code A/);
  });
});
