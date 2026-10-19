import {describe, expect, it} from 'vitest';
import {resolveProduct, type CatalogProduct} from '../src/chat/product-resolve';
import {ASKS, askOwner, clarifyText, isClarify} from '../src/chat/clarify';

// A1 (plan knowledge/tasks/2026-10-19-ask-coop-inventory-plan.md): exact answers at once, anything spelled differently or
// shared by several products is confirmed with the owner first (owner rule 2026-10-19: always confirm a non-exact match).
const CATALOG: CatalogProduct[] = [
  {sku: 'ZMYFDFDRYOG01', name: 'Freeze Dried Yogurt Cubes'},
  {sku: 'ZMYFDCHK01', name: 'Freeze Dried Chicken Cubes'},
  {sku: 'P2', name: 'Salmon Bites'},
  {sku: 'P4', name: 'Beef Strips'},
  {sku: 'P6', name: 'Unsold New Treat'},
];
const r = (q: string) => resolveProduct(q, CATALOG);
const skus = (res: ReturnType<typeof r>): string[] =>
  res.kind === 'exact' ? [res.product.sku] : res.kind === 'confirm' ? res.candidates.map((p) => p.sku) : res.nearest.map((p) => p.sku);

describe('resolveProduct: exact (no question)', () => {
  it('a SKU in any case', () => {
    expect(r('zmyfdfdryog01')).toEqual({kind: 'exact', product: CATALOG[0]});
  });
  it('the exact name, ignoring case, spaces and punctuation', () => {
    expect(r('  salmon   BITES! ')).toMatchObject({kind: 'exact', product: {sku: 'P2'}});
  });
  it('a shorter name whose words all appear in exactly one product', () => {
    expect(r('yogurt cubes')).toMatchObject({kind: 'exact', product: {sku: 'ZMYFDFDRYOG01'}});
    expect(r('salmon')).toMatchObject({kind: 'exact', product: {sku: 'P2'}});
  });
  it('filler words around the name are ignored', () => {
    expect(r('the yogurt cubes')).toMatchObject({kind: 'exact', product: {sku: 'ZMYFDFDRYOG01'}});
  });
  it('a product that never sold resolves (catalog, not sales)', () => {
    expect(r('new treat')).toMatchObject({kind: 'exact', product: {sku: 'P6'}});
  });
});

describe('resolveProduct: confirm (ask the owner)', () => {
  it('the screenshot case: "yoghurt cubes" is a spelling match, so it is confirmed, not answered', () => {
    const res = r('yoghurt cubes');
    expect(res.kind).toBe('confirm');
    expect(skus(res)).toEqual(['ZMYFDFDRYOG01']);
  });
  it('a typo in one word of the name', () => {
    expect(skus(r('freez dried yogurt'))).toEqual(['ZMYFDFDRYOG01']);
    expect(r('beef stirps').kind).toBe('confirm');
  });
  it('several products share the words: all are offered', () => {
    const res = r('cubes');
    expect(res.kind).toBe('confirm');
    expect(skus(res).sort()).toEqual(['ZMYFDCHK01', 'ZMYFDFDRYOG01']);
  });
  it('the closest spelling comes first', () => {
    expect(skus(r('freeze dried yoghurt cubes'))[0]).toBe('ZMYFDFDRYOG01');
  });
});

describe('resolveProduct: none', () => {
  it('nothing matches every word: the products sharing a word are the nearest', () => {
    const res = r('salmon treat');
    expect(res.kind).toBe('none');
    expect(skus(res)).toContain('P2');
  });
  it('nothing at all', () => {
    expect(r('zebra saddle')).toEqual({kind: 'none', nearest: []});
    expect(r('   ')).toEqual({kind: 'none', nearest: []});
  });
  it('short words never fuzzy-match (no "cat" -> "car")', () => {
    expect(resolveProduct('cat', [{sku: 'X', name: 'Car Toy'}])).toEqual({kind: 'none', nearest: []});
  });
});

describe('clarifyText', () => {
  it('writes the question and the hidden chip line the drawer already renders', () => {
    expect(clarifyText({question: 'Did you mean **Yogurt Cubes**?', options: ['Freeze Dried Yogurt Cubes (Z1)']})).toBe(
      'Did you mean **Yogurt Cubes**?\n\n<suggest>Freeze Dried Yogurt Cubes (Z1)</suggest>',
    );
  });
  it('options are data: separators and tags are removed, at most 5 are kept', () => {
    const t = clarifyText({question: 'Which? <go>x</go>', options: ['a|b', '<suggest>c', 'd', 'e', 'f', 'g']});
    expect(t).toBe('Which? gox/go\n\n<suggest>a b | suggest c | d | e | f</suggest>');
  });
  it('isClarify recognises only a well-formed clarify result', () => {
    expect(isClarify({clarify: {question: 'q', options: []}})).toBe(true);
    expect(isClarify({error: 'x'})).toBe(false);
    expect(isClarify({clarify: null})).toBe(false);
    expect(isClarify(null)).toBe(false);
  });
});

describe('ask_owner (A3)', () => {
  it('returns the fixed question and choices for the topic; the model writes neither', () => {
    expect(askOwner({about: 'channel'})).toEqual({clarify: {question: 'Which sales channel?', options: ['All channels', 'Offline (POS)', 'Shopee', 'Lazada', 'Website']}});
    expect(askOwner({about: 'period'})).toEqual({clarify: ASKS.period});
    expect(askOwner({about: 'comparison'})).toEqual({clarify: ASKS.comparison});
  });
  it('refuses any other topic with the allowed values', () => {
    expect(askOwner({about: 'stock'})).toEqual({error: 'about must be one of: period, channel, comparison.'});
    expect(askOwner(null)).toMatchObject({error: expect.stringMatching(/period, channel, comparison/)});
  });
  it('every fixed question fits the chip cap', () => {
    for (const c of Object.values(ASKS)) expect(c.options.length).toBeLessThanOrEqual(5);
  });
});
