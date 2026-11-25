import {describe, expect, it} from 'vitest';
import {
  approvedTotal,
  deliveredFrom,
  groupByProductLine,
  lineAmount,
  poNumber,
  poStatus,
  receiptsByMonth,
  receiveError,
  receivedBetween,
  reservedByItem,
  shadeOf,
  shortBy,
  type Receipt,
} from './goldline-po';

// The mockup's PO-0042 for Cubao: three lines approved on the run (the fourth, rejected
// there, is shown on the PO but isn't one of its lines).
const po0042 = [
  {qty: 28, unitPrice: 368, receivedQty: 28},
  {qty: 12, unitPrice: 80, receivedQty: 10},
  {qty: 20, unitPrice: 130, receivedQty: null},
];
const st = (receivedQty: number | null = null) => ({receivedQty});

describe('poNumber and amounts', () => {
  it('pads the number like the paper form', () => {
    expect(poNumber(42)).toBe('PO-0042');
    expect(poNumber(12345)).toBe('PO-12345');
  });
  it('is qty × price, null with no price', () => {
    expect(lineAmount(28, 368)).toBe(10304);
    expect(lineAmount(3, 99.5)).toBe(298.5);
    expect(lineAmount(3, null)).toBeNull();
  });
  it('totals the lines (13,864 on PO-0042), unpriced ones add 0', () => {
    expect(approvedTotal(po0042)).toBe(13864);
    expect(approvedTotal([{qty: 2, unitPrice: null}])).toBe(0);
  });
});

describe('poStatus', () => {
  it('is partly received on PO-0042', () => {
    expect(poStatus(po0042)).toBe('partly_received');
  });
  it('is shipped while nothing has arrived', () => {
    expect(poStatus([st(), st()])).toBe('shipped');
  });
  it('is received when every line is in, even a short one, or a 0', () => {
    expect(poStatus([st(5), st(3), st(0)])).toBe('received');
  });
  it('is empty with no lines', () => {
    expect(poStatus([])).toBe('empty');
  });
});

describe('receipts', () => {
  const line = {qty: 12, shippedOn: '2026-10-18'};
  it('counts the units missing from a short receipt', () => {
    expect(shortBy({qty: 12, receivedQty: 10})).toBe(2);
    expect(shortBy({qty: 12, receivedQty: 12})).toBe(0);
    expect(shortBy({qty: 12, receivedQty: null})).toBe(0);
  });
  it('accepts 0 to the line qty, dated between shipping and today', () => {
    expect(receiveError(line, 10, '2026-10-22', '2026-11-03')).toBeNull();
    expect(receiveError(line, 0, '2026-10-18', '2026-11-03')).toBeNull();
  });
  it('refuses more than was sent and bad dates', () => {
    expect(receiveError(line, 13, '2026-10-22', '2026-11-03')).toBe('over_qty');
    expect(receiveError(line, -1, '2026-10-22', '2026-11-03')).toBe('bad_qty');
    expect(receiveError(line, 2.5, '2026-10-22', '2026-11-03')).toBe('bad_qty');
    expect(receiveError(line, 10, '2026-10-17', '2026-11-03')).toBe('bad_date');
    expect(receiveError(line, 10, '2026-11-04', '2026-11-03')).toBe('bad_date');
    expect(receiveError(line, 10, null, '2026-11-03')).toBe('bad_date');
  });
});

describe('delivered: the receipt wins, the form is the fallback', () => {
  const receipts: Receipt[] = [
    {storeCode: '1', itemCode: 'BPDB01', qty: 10, receivedOn: '2026-10-22'},
    {storeCode: '1', itemCode: 'BPDB01', qty: 4, receivedOn: '2026-10-29'},
    {storeCode: '1', itemCode: 'BPDB01', qty: 6, receivedOn: '2026-11-02'},
    {storeCode: '2', itemCode: 'BPDB01', qty: 9, receivedOn: '2026-10-22'},
  ];
  it('adds a month’s receipts per store and item', () => {
    const m = receiptsByMonth(receipts);
    expect(m.get('1|BPDB01|2026-10')).toBe(14);
    expect(m.get('1|BPDB01|2026-11')).toBe(6);
    expect(m.get('2|BPDB01|2026-10')).toBe(9);
    expect(m.get('1|BPDB01|2026-09')).toBeUndefined();
  });
  it('uses the receipt over the form’s Delivery column, the form when there is none', () => {
    expect(deliveredFrom(12, 10)).toBe(10);
    expect(deliveredFrom(12, 0)).toBe(0); // a receipt of 0 still wins
    expect(deliveredFrom(15, undefined)).toBe(15);
  });
  it('finds receipts inside a count’s period', () => {
    expect(receivedBetween(receipts, '1', 'BPDB01', '2026-10-16', '2026-10-31')).toBe(14);
    expect(receivedBetween(receipts, '1', 'BPDB01', '2026-10-01', '2026-10-15')).toBeUndefined();
  });
});

describe('reservedByItem', () => {
  it('holds back approved lines not on a PO yet, skips shipped (on a PO) and rejected ones', () => {
    expect(
      reservedByItem([
        {item_code: 'A', decision: 'approved', final_qty: 10, on_po: false},
        {item_code: 'A', decision: 'edited', final_qty: 4, on_po: false},
        {item_code: 'A', decision: 'approved', final_qty: 7, on_po: true},
        {item_code: 'B', decision: 'edited', final_qty: 3, on_po: true},
        {item_code: 'B', decision: 'rejected', final_qty: 0, on_po: false},
      ]),
    ).toEqual({A: 14});
  });
});

describe('paper layout', () => {
  it('groups shades under their product line, lines in order, "Other" last', () => {
    const groups = groupByProductLine([
      {productLine: 'Nichido Brow Pencil', shade: 'Fudge Brown', itemCode: 'BPFB'},
      {productLine: null, shade: 'Beauty Sponge', itemCode: 'SPONGE'},
      {productLine: 'Nichido Brow Pencil', shade: 'Dark Brown', itemCode: 'BPDB01'},
      {productLine: '6 in 1 Perfect Stay Liquid Foundation', shade: 'Buttermilk', itemCode: '6in1PSLFBU'},
    ]);
    expect(groups.map((g) => g.line)).toEqual(['6 in 1 Perfect Stay Liquid Foundation', 'Nichido Brow Pencil', 'Other']);
    expect(groups[1].items.map((i) => i.shade)).toEqual(['Dark Brown', 'Fudge Brown']);
  });
  it('prints the shade without the words it repeats from the line', () => {
    expect(shadeOf('Lip and Cheek Tint Paraben-Free', 'Lip and Cheek Tint Beach Glow', 'X')).toBe('Beach Glow');
    expect(shadeOf('Brow Pencil', 'Brow Pencil', 'BP01')).toBe('Brow Pencil');
    expect(shadeOf(null, null, 'BP01')).toBe('BP01');
    expect(shadeOf('24/7 Stylo Eyeliner Pen', 'Stylo Eyeliner Pen Umber Matte', '24/7SEPUM')).toBe('Umber Matte');
    expect(shadeOf('Brow Master Eye Pencil', 'Cocoa', 'BMEPC01')).toBe('Cocoa');
  });
});
