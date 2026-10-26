import {describe, expect, it} from 'vitest';
import {
  categoryFromSubclass,
  headerRowIndex,
  itemCodeFromName,
  monthFromTitle,
  parseSubclassSheet,
  parseWatsonsGrids,
} from '../src/goldline-pos-xlsx';

// Shaped like the real Watsons workbook: blank rows, a title row with the month, the
// two vendor rows, then the header (its row moves between files) and the data.
const salesGrid = (title = '202609 SEPTEMBE', blankRows = 1): string[][] => [
  ['', ''],
  ['', title],
  ['', ''],
  ['', '', '741830101', '', 'GOLDLINE COSMETICS MANUFACTURING CORPORATION'],
  ['', '', '741830103', '', 'GOLDLINE COSMETICS CVW'],
  ...Array.from({length: blankRows}, () => ['']),
  ['', '', '', 'Location', '', 'Location Desc', 'SKU Code', 'SKU Name', '', 'Gross Sales Retail TY', 'Sales Units TY', 'Sales Net of Vat Net of Discount'],
  ['', '', '', '1', '', 'CUBAO', '38005992', 'NICHIDO BEAUTY SPONGE   SPG0161            ', '', '960', '16', '857.17'],
  ['', '', '', '1', '', 'CUBAO', '38005997', 'NICHIDO EAR CLEANER   EARCL8', '', '0', '', '0'],
  ['', '', '', '1027', '', 'GAISANO - TAGUM CITY', '38005992', 'NICHIDO BEAUTY SPONGE   SPG0161', '', '120', '2', '107.14'],
  ['', '', '', '', '', '', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', 'TOTAL', '', '1080', '18', '964.31'],
];

const subclassGrid: string[][] = [
  [''],
  ['', 'Sub Class', 'Subclass Name', 'SKU Code', 'SKU Name', 'Gross Sales Retail TY', 'Sales Units TY', 'Sales Net of Vat Net of Discount'],
  ['', '1', 'FACE COSMETICS', '38005992', 'NICHIDO BEAUTY SPONGE   SPG0161 ', '1080', '18', '964.31'],
  ['', '5', 'SKIN   FACIAL', '38005997', 'NICHIDO EAR CLEANER   EARCL8', '0', '', '0'],
  ['', '2', 'EYES COSMETICS', '38006200', 'NICHIDO PROFESSIONAL EYE PENCI', '0', '', '0'],
];

describe('monthFromTitle', () => {
  it('reads the month from a cut-short title and spans the whole month', () => {
    expect(monthFromTitle(salesGrid('202609 SEPTEMBE'))).toEqual({start: '2026-09-01', end: '2026-09-30'});
    expect(monthFromTitle(salesGrid('202602 FEBRUARY'))).toEqual({start: '2026-02-01', end: '2026-02-28'});
    expect(monthFromTitle(salesGrid('202512 DECEMBER '))).toEqual({start: '2025-12-01', end: '2025-12-31'});
  });
  it('ignores vendor codes and refuses an impossible month', () => {
    expect(monthFromTitle([['', '741830101']])).toBeNull();
    expect(monthFromTitle([['', '202613 SOMETHING']])).toBeNull();
    expect(monthFromTitle([['', 'no month here']])).toBeNull();
  });
});

describe('headerRowIndex', () => {
  it('finds the header wherever it sits', () => {
    expect(headerRowIndex(salesGrid(undefined, 1), ['Location', 'SKU Code'])).toBe(6);
    expect(headerRowIndex(salesGrid(undefined, 2), ['Location', 'SKU Code'])).toBe(7);
    expect(headerRowIndex([['a']], ['Location'])).toBe(-1);
  });
});

describe('subclass and category', () => {
  it('reads each SKU with a tidied name and subclass', () => {
    expect(parseSubclassSheet(subclassGrid)).toEqual([
      {skuCode: '38005992', name: 'NICHIDO BEAUTY SPONGE SPG0161', subclass: 'FACE COSMETICS'},
      {skuCode: '38005997', name: 'NICHIDO EAR CLEANER EARCL8', subclass: 'SKIN FACIAL'},
      {skuCode: '38006200', name: 'NICHIDO PROFESSIONAL EYE PENCI', subclass: 'EYES COSMETICS'},
    ]);
  });
  it('maps subclasses to Eyes, Lips, Face or Other', () => {
    expect(categoryFromSubclass('EYES COSMETICS')).toBe('eyes');
    expect(categoryFromSubclass('LIP COSMETICS')).toBe('lips');
    expect(categoryFromSubclass('FACE COSMETICS')).toBe('face');
    expect(categoryFromSubclass('SKIN   FACIAL')).toBe('other');
    expect(categoryFromSubclass('PROMO SKUS')).toBe('other');
    expect(categoryFromSubclass('OTHERS')).toBe('other');
    expect(categoryFromSubclass('')).toBeNull();
    expect(categoryFromSubclass(null)).toBeNull();
  });
});

describe('itemCodeFromName', () => {
  const catalog = ['SPG0161', 'CS0164', 'CS0165', 'EARCL8', 'BB03N', 'WSP208'];
  it('takes the item code the name ends with, ignoring padding and punctuation', () => {
    expect(itemCodeFromName('NICHIDO BEAUTY SPONGE   SPG0161            ', catalog)).toBe('SPG0161');
    expect(itemCodeFromName('NICHIDO 2 PCS. WEDGE SPONGE   WSP208 ', catalog)).toBe('WSP208');
    expect(itemCodeFromName('NICHIDO BB CREAM (BB03N)', catalog)).toBe('BB03N');
  });
  it('accepts a cut-short code only when it starts exactly one catalog code', () => {
    expect(itemCodeFromName('NICHIDO BEAUTY SPONGE SPG01', catalog)).toBe('SPG0161');
    expect(itemCodeFromName('NICHIDO EAR CLEANER EARC', catalog)).toBeNull(); // no digit: could be a word
    expect(itemCodeFromName('NICHIDO CURLER SILVER CS016', catalog)).toBeNull(); // CS0164 or CS0165
  });
  it('never treats the brand word as a code and returns null without a match', () => {
    expect(itemCodeFromName('NICHIDO', ['NICHIDO'])).toBeNull();
    expect(itemCodeFromName('NICHIDO PROFESSIONAL EYE PENCI', catalog)).toBeNull();
  });
});

describe('parseWatsonsGrids', () => {
  it('turns the workbook into one month of sales, its stores and its SKUs', () => {
    const wb = parseWatsonsGrids(salesGrid(), subclassGrid);
    expect(wb.month).toEqual({start: '2026-09-01', end: '2026-09-30'});
    expect(wb.errors).toEqual([]);
    expect(wb.rows).toHaveLength(3);
    expect(wb.rows[0]).toEqual({
      storeCode: '1', storeName: 'CUBAO', skuCode: '38005992', skuDesc: 'NICHIDO BEAUTY SPONGE SPG0161',
      grossRetail: 960, units: 16, netOfVat: 857.17,
    });
    expect(wb.rows[1].units).toBeNull(); // a blank units cell stays empty, not 0
    expect(wb.stores).toEqual([{storeCode: '1', name: 'CUBAO'}, {storeCode: '1027', name: 'GAISANO - TAGUM CITY'}]);
    expect(wb.skus.map((s) => s.skuCode)).toEqual(['38005992', '38005997', '38006200']);
  });
  it('checks the rows against the TOTAL row and refuses a mismatch', () => {
    expect(parseWatsonsGrids(salesGrid(), null)).toMatchObject({totalUnits: 18, checksumOk: true});
    const cut = salesGrid().filter((r) => r[6] !== '38005997' && r[3] !== '1027');
    const wb = parseWatsonsGrids(cut, null);
    expect(wb.checksumOk).toBe(false);
    expect(wb.errors[0]).toMatch(/16 units but the file's TOTAL says 18/);
  });
  it('adds SKUs seen only in the sales rows, without a subclass', () => {
    const wb = parseWatsonsGrids(salesGrid(), null);
    expect(wb.skus).toEqual([
      {skuCode: '38005992', name: 'NICHIDO BEAUTY SPONGE SPG0161', subclass: null},
      {skuCode: '38005997', name: 'NICHIDO EAR CLEANER EARCL8', subclass: null},
    ]);
  });
  it('says why when the file is not usable', () => {
    expect(parseWatsonsGrids(null, null).errors[0]).toMatch(/Per_Store_Per_SKU/);
    expect(parseWatsonsGrids([['', 'nothing']], null).errors[0]).toMatch(/header row/);
    const noMonth = parseWatsonsGrids(salesGrid('SEPTEMBER'), null);
    expect(noMonth.month).toBeNull();
    expect(noMonth.errors[0]).toMatch(/month/);
  });
});
