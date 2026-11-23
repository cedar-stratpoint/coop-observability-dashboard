import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {beforeAll, describe, expect, it} from 'vitest';
import {matchPoForm, poFormPhrases, type CatalogProduct, type PoFormResult} from '../src/goldline-po-form';
import {poFormCellsFromGrid, readPoFormXlsx} from '../src/goldline-po-form-xlsx';

// The real PO form Nichido sent (Nov 23, "PO FILE PAGE 1-2.xlsx") against the Staging
// catalog. Pins what the matcher reads so a change to it can't silently drop products.
const catalog = JSON.parse(readFileSync(join(__dirname, 'fixtures/goldline-catalog.json'), 'utf8')) as CatalogProduct[];

describe('PO form · the real sample', () => {
  let result: PoFormResult;
  const on = (code: string) => result.matches.some((m) => m.item_code === code);
  const from = (code: string) => result.matches.find((m) => m.item_code === code)?.phrase.text;

  beforeAll(async () => {
    const cells = await readPoFormXlsx(readFileSync(join(__dirname, 'fixtures/goldline-po-form.xlsx')));
    result = matchPoForm(poFormPhrases(cells), catalog);
  });

  it('reads most of the catalog and leaves only a couple of lines unmatched', () => {
    expect(result.matches.length).toBeGreaterThanOrEqual(240);
    expect(result.unmatched.length).toBeLessThanOrEqual(3);
  });

  it('one product per printed line', () => {
    const codes = result.matches.map((m) => m.item_code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('expands the form’s abbreviations within the right family', () => {
    expect(from('TSP01202')).toMatch(/I\. Glow/); // TSP · I. Glow = Ivory Glow
    expect(from('PF09113')).toMatch(/S\. Beige/); // Powder Plus Foundation · S. Beige
    expect(from('TCES1731')).toMatch(/C\. Pearl/); // TCC E/S · C. Pearl
    expect(from('MPEPTE')).toMatch(/T\. Eye/); // Tiger Eye, not Taupe
    expect(from('MPEPT')).toMatch(/Taupe/);
  });

  it('numbered shades and lash codes land on the right product', () => {
    expect(from('PEP092')).toMatch(/#802/);
    expect(from('PEP093')).toMatch(/#803/);
    expect(from('TWC01152')).toMatch(/#2/);
    expect(from('TLDL6619')).toMatch(/86619/); // De Luxe, not Glamour
    expect(from('TLGL4552')).toMatch(/84552/);
    expect(from('ELN4455')).toMatch(/N4455/); // shade on the heading's own line
  });

  it('keeps notes and instructions out', () => {
    expect(result.unmatched.some((u) => /bestseller|keywords|sayo|flashback/i.test(u.text))).toBe(false);
  });

  it('leaves discontinued products off (inactive)', () => {
    for (const code of ['EFTT1064', 'BGPL01', 'FCPP01131', 'TCES1734', 'BC01191']) expect(on(code)).toBe(false);
  });
});

describe('poFormCellsFromGrid', () => {
  it('takes only the DESCRIPTION columns under the header', () => {
    const grid = [['PURCHASE ORDER FORM'], ['QTY.', 'DESCRIPTION', '', 'QTY.', 'DESCRIPTION'], ['•', 'Bronzing Powder - Go Bronze', 'note', '', 'Lashpad']];
    expect(poFormCellsFromGrid(grid, '1').map((c) => [c.column, c.text])).toEqual([
      [0, 'Bronzing Powder - Go Bronze'],
      [1, 'Lashpad'],
    ]);
  });
});
