import {describe, expect, it} from 'vitest';
import {printedNames, printedPageItems, withPrintedHeadings} from './goldline-printed-page';

describe('printedPageItems', () => {
  it('uses the printed list for the page version (QA San Pablo, Legacy page 3)', () => {
    const items = printedPageItems('legacy', 3);
    const byCode = Object.fromEntries(items.map((i) => [i.code, i]));
    expect(byCode.KPMNEP99?.group).toBe('MINERAL KOHL - ONYX (2 in 1 Eyeliner & Under Eyeliner)');
    expect(byCode.LCMS01?.product).toBe('LENGTH & CURL MASCARA');
  });
  it('keeps name tags and per-item prices on the Make-Up Collection page', () => {
    const items = printedPageItems('legacy', 2);
    const byCode = Object.fromEntries(items.map((i) => [i.code, i]));
    expect(byCode.MS099717?.product).toBe('#9717 Naturally Beautiful');
    expect(byCode.MS09113?.product).toMatch(/^#G0II3-A /);
    expect([byCode.BESP?.price, byCode.LSESP?.price, byCode.CPC001?.price]).toEqual([320, 320, 350]);
  });
  it('falls back to the shared page list for an unknown version', () => {
    const items = printedPageItems('unknown', 1);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.group === null && i.price === null)).toBe(true);
  });
});

describe('withPrintedHeadings', () => {
  it('lays the printed heading and price over the catalog, keeping unprinted codes', () => {
    const cat = {A: {productLine: 'Icy Pout Serum Lip Stain', unitPrice: 280}, B: {productLine: 'Other', unitPrice: 5}};
    const out = withPrintedHeadings(cat, [{code: 'A', product: 'Caramel Swirl', group: 'ICY POUT SERUM LIP STAIN', price: 285}]);
    expect(out.A).toEqual({productLine: 'ICY POUT SERUM LIP STAIN', unitPrice: 285});
    expect(out.B).toEqual(cat.B);
    expect(printedNames([{code: 'A', product: 'Caramel Swirl', group: null, price: null}])).toEqual({A: 'Caramel Swirl'});
  });
});
