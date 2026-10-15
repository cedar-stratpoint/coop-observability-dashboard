import {describe, it, expect} from 'vitest';
import {parseCsv, parseGoldlinePos} from './goldline-csv';

const HEADER =
  'Location,Location Desc,SKU Code,SKU Desc,Gross Sales Retail TY,Sales Units TY,Sales Net of Vat Net of Discount';

describe('parseCsv', () => {
  it('handles quoted fields with embedded commas and "" escapes', () => {
    const grid = parseCsv('a,"b,c","he said ""hi"""\n1,2,3');
    expect(grid[0]).toEqual(['a', 'b,c', 'he said "hi"']);
    expect(grid[1]).toEqual(['1', '2', '3']);
  });
  it('drops blank lines and tolerates no trailing newline', () => {
    expect(parseCsv('x\n\n\ny')).toEqual([['x'], ['y']]);
  });
});

describe('parseGoldlinePos', () => {
  it('maps the real Nichido columns to sale rows', () => {
    const csv = `${HEADER}\n1,CUBAO,38005997,NICHIDO EAR CLEANER EARCL8,90.00,2,80.36`;
    const {rows, errors} = parseGoldlinePos(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        storeCode: '1',
        storeName: 'CUBAO',
        skuCode: '38005997',
        skuDesc: 'NICHIDO EAR CLEANER EARCL8',
        grossRetail: 90,
        units: 2,
        netOfVat: 80.36,
      },
    ]);
  });

  it('is case/space-insensitive on headers and strips thousands separators', () => {
    const csv = '  location , SKU CODE , gross sales retail ty , sales units ty , net sales\n' +
      '7,BB03N,"1,250.50",10,"1,100"';
    const {rows} = parseGoldlinePos(csv);
    expect(rows[0]).toMatchObject({storeCode: '7', skuCode: 'BB03N', grossRetail: 1250.5, units: 10, netOfVat: 1100});
  });

  it('reports missing required columns', () => {
    const {rows, errors} = parseGoldlinePos('Location,SKU Desc\n1,foo');
    expect(rows).toEqual([]);
    expect(errors.some((e) => /SKU Code/i.test(e))).toBe(true);
  });

  it('skips rows missing a store or SKU, and notes it', () => {
    const csv = `${HEADER}\n,CUBAO,38005997,x,1,1,1\n1,CUBAO,FBPP01,y,2,2,2`;
    const {rows, errors} = parseGoldlinePos(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].skuCode).toBe('FBPP01');
    expect(errors.some((e) => /skipped/i.test(e))).toBe(true);
  });

  it('leaves blank numeric cells as null (not 0)', () => {
    const csv = `${HEADER}\n1,CUBAO,FBPP01,y,,,`;
    const {rows} = parseGoldlinePos(csv);
    expect(rows[0]).toMatchObject({grossRetail: null, units: null, netOfVat: null});
  });
});
