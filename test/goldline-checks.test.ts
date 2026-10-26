import {describe, expect, it} from 'vitest';
import {allowedGap, monthlyChecks, rowFindings, rowMathOff, type CountRow} from '../src/goldline-checks';

const row = (p: Partial<CountRow> & Pick<CountRow, 'period_start' | 'period_end'>): CountRow => ({
  store_code: '1', item_code: 'LIPT01', stockroom: null, drawer: null, selling_area: null, delivery: null,
  ending_on_hand: null, consultant: 'Liza M.', source_upload_id: 'u1', ...p,
});

describe('allowedGap', () => {
  it('is 1 unit or 5% of POS sold, whichever is larger', () => {
    expect(allowedGap(10)).toBe(1);
    expect(allowedGap(85)).toBe(4.25);
    expect(allowedGap(0)).toBe(1);
  });
});

describe('rowMathOff', () => {
  const r = (p: Partial<CountRow>) => row({period_start: '2026-10-01', period_end: '2026-10-15', ...p});
  it('passes a row that adds up with or without the delivery column', () => {
    expect(rowMathOff(r({stockroom: 16, selling_area: 15, ending_on_hand: 31}))).toBeNull();
    expect(rowMathOff(r({stockroom: 16, selling_area: 15, delivery: 5, ending_on_hand: 36}))).toBeNull();
    expect(rowMathOff(r({stockroom: 16, selling_area: 15, delivery: 5, ending_on_hand: 31}))).toBeNull();
  });
  it('flags a row that matches neither reading', () => {
    expect(rowMathOff(r({stockroom: 16, selling_area: 15, delivery: 5, ending_on_hand: 40}))).toEqual({written: 40, counted: 31, withDelivery: 36});
  });
  it('skips rows with no written ending or no parts', () => {
    expect(rowMathOff(r({stockroom: 16}))).toBeNull();
    expect(rowMathOff(r({ending_on_hand: 6}))).toBeNull();
  });
});

describe('rowFindings', () => {
  it('names one cause per check: math is human error, 0 or below is manipulation', () => {
    const f = rowFindings([
      row({period_start: '2026-10-01', period_end: '2026-10-15', stockroom: 3, selling_area: 2, ending_on_hand: 9}),
      row({item_code: 'BB03N', period_start: '2026-10-01', period_end: '2026-10-15', stockroom: 0, drawer: 0, selling_area: 0}),
    ]);
    expect(f.map((x) => [x.item_code, x.kind, x.cause])).toEqual([
      ['LIPT01', 'row_math', 'human_error'],
      ['BB03N', 'zero_or_below', 'manipulation'],
    ]);
  });
  it('an unreadable cell skips the math check on that row', () => {
    const r = row({period_start: '2026-10-01', period_end: '2026-10-15', stockroom: 3, ending_on_hand: 9});
    const f = rowFindings([r], [{store_code: '1', item_code: 'LIPT01', period_start: '2026-10-01', period_end: '2026-10-15', upload_id: 'u9', marks: [{field: 'stockroom', mark: 'overwritten', written: '3 or 8'}]}]);
    expect(f.map((x) => x.kind)).toEqual(['unreadable']);
    expect(f[0].source_upload_id).toBe('u9');
  });
});

describe('monthlyChecks', () => {
  // The plan's example: start 100, two forms in October, 15 left, so the form says 85 sold.
  const counts = [
    row({period_start: '2026-09-16', period_end: '2026-09-30', stockroom: 100}),
    row({period_start: '2026-10-01', period_end: '2026-10-15', stockroom: 40, consultant: 'Liza M.'}),
    row({period_start: '2026-10-16', period_end: '2026-10-31', stockroom: 15, consultant: 'Ana P.'}),
  ];
  const base = {counts, adjustments: [], salesMonths: new Set(['2026-10']), linked: new Set(['LIPT01'])};

  it('Store A: POS also says 85, so it matches', () => {
    const {months, findings} = monthlyChecks({...base, posSold: () => 85});
    const oct = months.find((m) => m.month === '2026-10')!;
    expect(oct).toMatchObject({state: 'match', start: 100, ending: 15, formSold: 85, posSold: 85, gap: 0});
    expect(findings).toEqual([]);
  });
  it('Store B: POS says 70, a 15-unit gap is flagged with both BAs', () => {
    const {findings} = monthlyChecks({...base, posSold: () => 70});
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({kind: 'sales_gap', cause: 'human_error', period_start: '2026-10-01', period_end: '2026-10-31', consultant: 'Liza M., Ana P.'});
    expect(findings[0].details).toMatchObject({form_sold: 85, pos_sold: 70, gap: 15, allowed: 3.5, direction: 'form_sold_more'});
  });
  it('a logged pull-out explains the gap before it is flagged', () => {
    const {months, findings} = monthlyChecks({...base, posSold: () => 70, adjustments: [{store_code: '1', item_code: 'LIPT01', period_end: '2026-10-20', qty: 15}]});
    expect(months.find((m) => m.month === '2026-10')).toMatchObject({start: 85, formSold: 70, state: 'match'});
    expect(findings).toEqual([]);
  });
  it('deliveries raise the start', () => {
    const c = [counts[0], {...counts[1], delivery: 20}, counts[2]];
    const {months} = monthlyChecks({...base, counts: c, posSold: () => 105});
    expect(months.find((m) => m.month === '2026-10')).toMatchObject({start: 120, formSold: 105, state: 'match'});
  });
  it('the first count is the baseline, a month without POS data waits, unlinked items are held out', () => {
    expect(monthlyChecks({...base, posSold: () => 85}).months.find((m) => m.month === '2026-09')?.state).toBe('baseline');
    expect(monthlyChecks({...base, salesMonths: new Set(), posSold: () => 85}).months.find((m) => m.month === '2026-10')?.state).toBe('waiting_sales');
    expect(monthlyChecks({...base, linked: new Set(), posSold: () => 85}).months.find((m) => m.month === '2026-10')?.state).toBe('unlinked');
  });
  it('no POS units for a linked item counts as 0 sold', () => {
    const {findings} = monthlyChecks({...base, posSold: () => undefined});
    expect(findings[0].details).toMatchObject({pos_sold: 0, gap: 85});
  });
});

import {itemDisplayName} from '../src/goldline-item-name';
describe('itemDisplayName', () => {
  it('drops the words the shade repeats from the line', () => {
    expect(itemDisplayName('Lip and Cheek Tint Paraben-Free', 'Lip and Cheek Tint Beach Glow')).toBe('Lip and Cheek Tint Paraben-Free · Beach Glow');
    expect(itemDisplayName('Elise Diva Lashes - Natural Hair', 'Elise Diva Lashes X4289')).toBe('Elise Diva Lashes - Natural Hair · X4289');
    expect(itemDisplayName('Two Way Cake (21 Grams)', '#4 Oriental')).toBe('Two Way Cake (21 Grams) · #4 Oriental');
    expect(itemDisplayName('7X Volume Curl Mascara', '7X Volume Curl Mascara')).toBe('7X Volume Curl Mascara');
    expect(itemDisplayName(null, null, 'ABC')).toBe('ABC');
  });
});
