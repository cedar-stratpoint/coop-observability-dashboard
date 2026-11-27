import {describe, expect, it} from 'vitest';
import {
  peso,
  allowedPrices,
  bandFlagRows,
  bandNote,
  checkBands,
  cleanBands,
  flaggedRowIndexes,
  stampPickedPrices,
  withPickedPrices,
  pickPaperPriceLabel,
  BAND_PICK_SCOPE,
  type PaperBand,
} from '../src/band-prices';

// SM San Pablo, Legacy page 2 (QA Nov 25): the band prints ₱225, the BA wrote 180 beside
// USMLLC05 and totalled the band at ₱6,480 = 36 pcs × 180.
const G = 'ULTRA STAY MATTE LIQUID LIP COLOR';
const items = [
  {code: 'IPSL01', group: 'ICY POUT SERUM LIP STAIN', price: 285},
  ...Array.from({length: 10}, (_, i) => ({code: `USMLLC${String(i + 1).padStart(2, '0')}`, group: G, price: 225})),
];
const endings = [5, 17, null, null, 1, null, 2, null, 4, 10, 2];
const rows = items.map((it, i) => ({item_code: it.code, ending_on_hand: endings[i]}));
const band = (b: PaperBand[]) => b.find((x) => x.group === G)!;

describe('checkBands', () => {
  it('a written price that reconciles is still one flag on the band', () => {
    const b = band(checkBands(items, rows, [{family: G, amount: 6480, written_price: 180}]));
    expect(b).toMatchObject({kind: 'written', offer_price: 180, printed_price: 225, pieces: 36, amount: 6480, first_index: 1});
    expect(b.codes).toHaveLength(10);
    expect(bandNote(b)).toBe('₱180 written beside the band, printed ₱225. Paper total ₱6,480');
  });

  it('no written price read, but the total only fits another whole price', () => {
    const b = band(checkBands(items, rows, [{family: G, amount: 6480, written_price: null}]));
    expect(b).toMatchObject({kind: 'implied', offer_price: 180});
    expect(bandNote(b)).toBe('Paper total fits ₱180 a piece, not the printed ₱225. Paper total ₱6,480');
  });

  it('agreeing paper is saved but not flagged', () => {
    expect(band(checkBands(items, rows, [{family: G, amount: 8100}]))).toMatchObject({kind: null, offer_price: null});
    expect(band(checkBands(items, rows, [{family: G, amount: 8100, written_price: 225}]))).toMatchObject({kind: null});
  });

  it('a total that implies no believable whole price stays with the mismatch note', () => {
    expect(band(checkBands(items, rows, [{family: G, amount: 6000}])).kind).toBeNull(); // 166.67
    expect(band(checkBands(items, rows, [{family: G, amount: 36}])).kind).toBeNull(); // ₱1 a piece
  });

  it('matches a band written with a shorter or longer heading; skips bands with nothing on paper', () => {
    expect(checkBands(items, rows, [{family: 'Ultra Stay Matte Liquid Lip Color (Smudge Proof)', amount: 6480}])).toHaveLength(1);
    expect(checkBands(items, rows, [])).toEqual([]);
    expect(checkBands(items, rows, [{family: G, amount: null, written_price: null}])).toEqual([]);
  });

  it('a total that is whole pieces at the printed price says a count is off, not the price (Elise Lashes)', () => {
    const lashes = [{code: 'EL1', group: 'ELISE LASHES', price: 238}, {code: 'EL2', group: 'ELISE LASHES', price: 238}];
    const b = checkBands(lashes, [{item_code: 'EL1', ending_on_hand: 10}, {item_code: 'EL2', ending_on_hand: 7}], [{family: 'ELISE LASHES', amount: 4522}]);
    expect(b[0]).toMatchObject({kind: null, offer_price: null, pieces: 17}); // 4,522 = 19 x 238
  });

  it('a band with nothing on hand has nothing to value, so it is never flagged', () => {
    const none = rows.map((r) => (r.item_code.startsWith('USMLLC') ? {...r, ending_on_hand: null} : r));
    expect(band(checkBands(items, none, [{family: G, amount: null, written_price: 180}]))).toMatchObject({kind: null, pieces: 0});
  });

  it('skips bands whose items print different prices', () => {
    const mixed = [{code: 'BESP', group: 'MAKE-UP COLLECTION', price: 320}, {code: 'CPC001', group: 'MAKE-UP COLLECTION', price: 350}];
    expect(checkBands(mixed, mixed.map((m) => ({item_code: m.code, ending_on_hand: 2})), [{family: 'MAKE-UP COLLECTION', amount: 999, written_price: 300}])).toEqual([]);
  });
});

describe('peso', () => {
  it('prints centavos with two places, whole pesos plain', () => {
    expect(peso(158.4)).toBe('₱158.40');
    expect(peso(213.75)).toBe('₱213.75');
    expect(peso(6480)).toBe('₱6,480');
  });
});

describe('flags and picks', () => {
  const bands = checkBands(items, rows, [{family: G, amount: 6480, written_price: 180}]);

  it('one flag per open band, added to the low-confidence rows', () => {
    expect(bandFlagRows(bands)).toEqual([1]);
    const page = {rows: rows.map((_, i) => ({confidence: i === 4 ? 0.5 : 0.9})), bands};
    expect(flaggedRowIndexes(page, 0.6)).toEqual([1, 4]);
    expect(flaggedRowIndexes({rows: page.rows, bands: [{...bands[0], use_price: 225}]}, 0.6)).toEqual([4]);
    expect(flaggedRowIndexes({rows: page.rows}, 0.6)).toEqual([4]);
  });

  it('only the printed or offered price can be picked', () => expect(allowedPrices(bands[0])).toEqual([225, 180]));

  it('a pick of the offered price values this form at it; keeping the printed price changes nothing', () => {
    const picked = [{...bands[0], use_price: 180}];
    const catalog = {USMLLC05: {unitPrice: 225, productLine: G}, IPSL01: {unitPrice: 285, productLine: null}};
    expect(withPickedPrices(catalog, picked).USMLLC05.unitPrice).toBe(180);
    expect(withPickedPrices(catalog, picked).IPSL01.unitPrice).toBe(285);
    expect(withPickedPrices(catalog, [{...bands[0], use_price: 225}])).toBe(catalog);
    const stamped = stampPickedPrices([{item_code: 'USMLLC01', extra: {beginning: 3}}, {item_code: 'IPSL01'}], picked);
    expect(stamped[0].extra).toEqual({beginning: 3, unit_price: 180});
    expect(stamped[1]).toEqual({item_code: 'IPSL01'});
  });

  it('cleans stored bands and keeps the pick', () => {
    expect(cleanBands(null)).toEqual([]);
    expect(cleanBands([{group: 1}, 'x'])).toEqual([]);
    const [b] = cleanBands([{...bands[0], use_price: 180, kind: 'bogus'}]);
    expect(b).toMatchObject({group: G, use_price: 180, kind: null, offer_price: 180});
  });
});

// QA Nov 27: "Use ₱180" sat on the band's first row and read as "just this cell". It prices the
// whole band, so the button says how many rows it covers.
describe('pickPaperPriceLabel', () => {
  const band = (n: number) => ({offer_price: 180, codes: Array.from({length: n}, (_, i) => `USMLLC${i + 1}`)});
  it('names the whole band', () => {
    expect(pickPaperPriceLabel(band(10))).toBe('Use ₱180 for all 10');
    expect(pickPaperPriceLabel(band(2))).toBe('Use ₱180 for both');
    expect(pickPaperPriceLabel(band(1))).toBe('Use ₱180');
    expect(pickPaperPriceLabel({offer_price: 199, codes: ['24/7SEPM', '24/7SEPU', '24/7SEPM']})).toBe('Use ₱199 for both');
    expect(pickPaperPriceLabel({offer_price: null, codes: []})).toBe('');
  });
  it('the scope line has no dashes', () => {
    expect(BAND_PICK_SCOPE).toBe('Applies to the whole band, this form only.');
    expect(BAND_PICK_SCOPE).not.toMatch(/[–—]/);
  });
});
