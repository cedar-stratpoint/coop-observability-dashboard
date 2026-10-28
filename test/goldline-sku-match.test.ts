import {describe, expect, it} from 'vitest';
import {abbreviates, matchSkus, scorePair, tokens, type CatalogItem, type ChainSkuStat} from '../src/goldline-sku-match';

// Real names from the Watsons files and the Nichido catalog.
const catalog: CatalogItem[] = [
  {item_code: 'MPEPC', product_line: 'Minerals Precise Eye Pencil', variant: 'Minerals Precise Eye Pencil Chestnut', unit_price: 175},
  {item_code: 'MPEPH', product_line: 'Minerals Precise Eye Pencil', variant: 'Minerals Precise Eye Pencil Hazelnut', unit_price: 175},
  {item_code: 'TWC01154', product_line: 'Two Way Cake (21 Grams)', variant: '#4 Oriental', unit_price: 185},
  {item_code: 'MTW01174', product_line: 'Two Way Cake Matte', variant: 'Matte Oriental', unit_price: 150},
  {item_code: 'ACCS525', product_line: 'Accessories', variant: 'Retractable Blusher Brush #525', unit_price: 140},
  {item_code: 'ACCS521', product_line: 'Accessories', variant: 'Retractable Powder Brush #521', unit_price: 238},
  {item_code: 'BPDB01', product_line: 'Brow Pencil (Paraben Free)', variant: 'Brow Pencil Dark Brown', unit_price: 80},
  {item_code: 'BPFB02', product_line: 'Brow Pencil (Paraben Free)', variant: 'Brow Pencil Fudge Brown', unit_price: 80},
];
const sku = (sku_code: string, name: string, price: number, units = 100): ChainSkuStat => ({sku_code, name, units, gross: price * units});

describe('tokens and abbreviations', () => {
  it('drops the brand and stop words, expands Watsons short forms', () => {
    expect(tokens('NICHIDO MINERAL PRECISE EP CHESTNUT', true)).toEqual(['MINERAL', 'PRECISE', 'EYE', 'PENCIL', 'CHESTNUT']);
    expect(tokens('Two Way Cake (21 Grams)')).toEqual(['TWO', 'WAY', 'CAKE', '21']);
  });
  it('reads cut-short and squeezed words', () => {
    expect(abbreviates('CHESTNUT', 'CHESTNUT')).toBe(1);
    expect(abbreviates('MINERAL', 'MINERALS')).toBe(0.9);
    expect(abbreviates('MTTE', 'MATTE')).toBe(0.7);
    expect(abbreviates('CKE', 'CAKE')).toBe(0.7);
    expect(abbreviates('TAN', 'BEIGE')).toBe(0);
  });
});

describe('scorePair', () => {
  it('prefers the right shade within a line', () => {
    const s = sku('70075145', 'NICHIDO MINERAL PRECISE EP CHESTNUT', 175);
    expect(scorePair(s, catalog[0])).toBeGreaterThan(scorePair(s, catalog[1]) + 0.2);
  });
  it('uses the number inside the name', () => {
    const s = sku('38048039', 'NICHIDO RETRACTABLE BLUSHER BRUSH #525', 140);
    expect(scorePair(s, catalog[4])).toBeGreaterThan(1);
    expect(scorePair(s, catalog[5])).toBeLessThan(0.5);
  });
  it('penalises a price far above the catalog price', () => {
    const s = sku('x', 'NICHIDO BROW PENCIL DARK BROWN', 80);
    const pricey = {...catalog[6], unit_price: 40};
    expect(scorePair(s, catalog[6])).toBeGreaterThan(scorePair(s, pricey));
  });
});

describe('matchSkus', () => {
  const skus = [
    sku('70075145', 'NICHIDO MINERAL PRECISE EP CHESTNUT', 175, 500),
    sku('70075150', 'NICHIDO MINERAL PRECISE EP HAZELNUT', 175, 400),
    sku('38048039', 'NICHIDO RETRACTABLE BLUSHER BRUSH #525', 140, 600),
    sku('70022220', 'NICHIDO BROW PENCIL DARK BROWN', 80, 300),
    sku('70037661', 'NICHIDO BROW PENCIL FUDGE BROWN', 80, 250),
    sku('dead', 'NICHIDO BROW PENCIL COCO BROWN', 80, 0),
  ];
  it('pairs each SKU with its item, one to one', () => {
    const m = Object.fromEntries(matchSkus(skus, catalog).map((x) => [x.skuCode, x.itemCode]));
    expect(m).toEqual({'70075145': 'MPEPC', '70075150': 'MPEPH', '38048039': 'ACCS525', '70022220': 'BPDB01', '70037661': 'BPFB02'});
  });
  it('marks clear winners high', () => {
    const byCode = Object.fromEntries(matchSkus(skus, catalog).map((x) => [x.skuCode, x.tier]));
    expect(byCode['38048039']).toBe('high');
    expect(byCode['70075145']).toBe('high');
  });
  it('skips SKUs with no sales and keeps existing links out', () => {
    const m = matchSkus(skus, catalog, [{skuCode: '38048039', itemCode: 'ACCS525'}]);
    expect(m.find((x) => x.skuCode === 'dead')).toBeUndefined();
    expect(m.find((x) => x.skuCode === '38048039' || x.itemCode === 'ACCS525')).toBeUndefined();
  });
  it('honours pairs an admin turned down', () => {
    const m = matchSkus(skus, catalog, [], new Set(['70022220|BPDB01']));
    expect(m.find((x) => x.skuCode === '70022220')?.itemCode).not.toBe('BPDB01');
  });
});

// Wrong suggestions found in the Oct 26 hand check of the 10 Watsons months.
describe('matchSkus regressions (Oct 26 hand check)', () => {
  const lashes: CatalogItem[] = ['84331', '84440', '84452', '84453'].map((n) => ({item_code: `TLGL${n.slice(1)}`, product_line: 'Glamour Lashes', variant: `Glamour Lashes ${n}`, unit_price: 150}));
  it('reads the lash number inside "84331BR" so the lashes are not shifted one row', () => {
    const skus = [sku('1', 'NICHIDO TRULASHES GLAMOUR LASHES 84331BR', 150), sku('2', 'NICHIDO TRULASHES GLAMOUR LASHES 84440TL', 150), sku('3', 'NICHIDO TRULASHES GLAMOUR LASHES 84452TL', 150), sku('4', 'NICHIDO TRULASHES GLAMOUR LASHES 84453TL', 150)];
    const m = Object.fromEntries(matchSkus(skus, lashes).map((x) => [x.skuCode, x.itemCode]));
    expect(m).toEqual({'1': 'TLGL4331', '2': 'TLGL4440', '3': 'TLGL4452', '4': 'TLGL4453'});
  });
  it('tells the pink and silver lip brushes apart by the shade initial', () => {
    const brushes: CatalogItem[] = [
      {item_code: 'RLBP191', product_line: 'Accessories', variant: 'Ret Lip Brush Aluminum Pink or Violet', unit_price: 60},
      {item_code: 'RLBS191', product_line: 'Accessories', variant: 'Ret Lip Brush Aluminum Silver', unit_price: 60},
    ];
    const m = Object.fromEntries(matchSkus([sku('p', 'NICHIDO RETRACTABLE LIP BRUSH ALUMINUM P', 60), sku('s', 'NICHIDO RETRACTABLE LIP BRUSH ALUMINUM S', 60)], brushes).map((x) => [x.skuCode, x.itemCode]));
    expect(m).toEqual({p: 'RLBP191', s: 'RLBS191'});
  });
  it('lets the price pick the ₱150 matte cake over the ₱185 one', () => {
    const s = sku('m', 'NICHIDO TWO WAY CKE MTTE ORIENTAL', 150);
    expect(scorePair(s, catalog[3])).toBeGreaterThan(scorePair(s, catalog[2]));
  });
  it('does not offer a ₱160 item to an ₱88 SKU', () => {
    const s = sku('b', 'NICHIDO TRUE COLORS POWDER BLUSH COOL RU', 88);
    const item: CatalogItem = {item_code: 'TCPBCR04', product_line: 'True Colors Powder Blush', variant: 'Powder Blush Cool Rum', unit_price: 160};
    expect(matchSkus([s], [item]).find((x) => x.tier !== 'low')).toBeUndefined();
  });
  it('does not match item codes by their digits alone (FP01202 is not TSP01202)', () => {
    const s = sku('f', 'NICHIDO FINAL POWDER IVORY GLOW FP01202', 200);
    const tsp: CatalogItem = {item_code: 'TSP01202', product_line: 'Translucent Setting Powder', variant: 'Ivory Glow', unit_price: 240};
    expect(matchSkus([s], [tsp]).find((x) => x.tier === 'high')).toBeUndefined();
  });
});
