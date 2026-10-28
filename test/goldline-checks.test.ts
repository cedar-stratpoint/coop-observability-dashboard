import {describe, expect, it} from 'vitest';
import {allowedGap, baScores, baTags, categoryOf, monthlyChecks, rowFindings, rowMathOff, tagFor, type CountRow} from '../src/goldline-checks';

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
  it('passes a row whose ending is stockroom + drawer + selling area (delivery left out, Q23)', () => {
    expect(rowMathOff(r({stockroom: 16, selling_area: 15, ending_on_hand: 31}))).toBeNull();
    expect(rowMathOff(r({stockroom: 16, selling_area: 15, delivery: 5, ending_on_hand: 31}))).toBeNull();
  });
  it('flags an ending that adds the delivery in, or matches nothing', () => {
    expect(rowMathOff(r({stockroom: 16, selling_area: 15, delivery: 5, ending_on_hand: 36}))).toEqual({written: 36, counted: 31});
    expect(rowMathOff(r({stockroom: 16, selling_area: 15, delivery: 5, ending_on_hand: 40}))).toEqual({written: 40, counted: 31});
  });
  it('skips rows with no written ending or no parts', () => {
    expect(rowMathOff(r({stockroom: 16}))).toBeNull();
    expect(rowMathOff(r({ending_on_hand: 6}))).toBeNull();
    expect(rowMathOff(r({delivery: 6, ending_on_hand: 6}))).toBeNull();
  });
});

describe('rowFindings', () => {
  it('names one cause per check: math is an incorrect total, 0 or below is padding', () => {
    const f = rowFindings([
      row({period_start: '2026-10-01', period_end: '2026-10-15', stockroom: 3, selling_area: 2, ending_on_hand: 9}),
      row({item_code: 'BB03N', period_start: '2026-10-01', period_end: '2026-10-15', stockroom: 0, drawer: 0, selling_area: 0}),
    ]);
    expect(f.map((x) => [x.item_code, x.kind, x.cause])).toEqual([
      ['LIPT01', 'row_math', 'incorrect_total'],
      ['BB03N', 'zero_or_below', 'padding'],
    ]);
  });
  it('an unreadable cell skips the math check on that row', () => {
    const r = row({period_start: '2026-10-01', period_end: '2026-10-15', stockroom: 3, ending_on_hand: 9});
    const f = rowFindings([r], [{store_code: '1', item_code: 'LIPT01', period_start: '2026-10-01', period_end: '2026-10-15', upload_id: 'u9', marks: [{field: 'stockroom', mark: 'overwritten', written: '3 or 8'}]}]);
    expect(f.map((x) => [x.kind, x.cause])).toEqual([['unreadable', 'messy_handwriting']]);
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
  const base = {counts, adjustments: [], salesMonths: new Set(['1|2026-10']), linked: new Set(['LIPT01'])};

  it('Store A: POS also says 85, so it matches', () => {
    const {months, findings} = monthlyChecks({...base, posSold: () => 85});
    const oct = months.find((m) => m.month === '2026-10')!;
    expect(oct).toMatchObject({state: 'match', start: 100, ending: 15, formSold: 85, posSold: 85, gap: 0});
    expect(findings).toEqual([]);
  });
  it('Store B: POS says 70, a 15-unit gap is flagged with both BAs', () => {
    const {findings} = monthlyChecks({...base, posSold: () => 70});
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({kind: 'sales_gap', cause: 'incorrect_total', period_start: '2026-10-01', period_end: '2026-10-31', consultant: 'Liza M., Ana P.'});
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
  it('a skipped month restarts the baseline instead of comparing two months to one', () => {
    const c = [row({period_start: '2026-07-16', period_end: '2026-07-31', stockroom: 100}), ...counts.slice(1)];
    expect(monthlyChecks({...base, counts: c, posSold: () => 10}).months.find((m) => m.month === '2026-10')?.state).toBe('baseline');
  });
  it('a store with no POS rows that month waits, even when other stores have the month', () => {
    const {months, findings} = monthlyChecks({...base, salesMonths: new Set(['2|2026-10']), posSold: () => undefined});
    expect(months.find((m) => m.month === '2026-10')?.state).toBe('waiting_sales');
    expect(findings).toEqual([]);
  });
  it('POS sold more than the counts show is padding', () => {
    const {findings} = monthlyChecks({...base, posSold: () => 100});
    expect(findings[0]).toMatchObject({kind: 'sales_gap', cause: 'padding'});
    expect(findings[0].details).toMatchObject({form_sold: 85, pos_sold: 100, gap: -15, direction: 'pos_sold_more'});
  });
  it('no POS units for a linked item counts as 0 sold', () => {
    const {findings} = monthlyChecks({...base, posSold: () => undefined});
    expect(findings[0].details).toMatchObject({pos_sold: 0, gap: 85});
  });
});

describe('BA tags', () => {
  const zero = {messy_handwriting: 0, incorrect_total: 0, padding: 0};
  it('Clear at 0, At risk at 1 to 2, Delinquent at 3+ or any padding', () => {
    expect(tagFor(zero)).toBe('clear');
    expect(tagFor({...zero, messy_handwriting: 2})).toBe('at_risk');
    expect(tagFor({...zero, messy_handwriting: 2, incorrect_total: 1})).toBe('delinquent');
    expect(tagFor({...zero, padding: 1})).toBe('delinquent');
  });
  it('category is the cause seen most, padding first on a tie', () => {
    expect(categoryOf(zero)).toBeNull();
    expect(categoryOf({...zero, incorrect_total: 1, padding: 2})).toBe('padding');
    expect(categoryOf({...zero, incorrect_total: 1, padding: 1})).toBe('padding');
    expect(categoryOf({...zero, messy_handwriting: 2, incorrect_total: 1})).toBe('messy_handwriting');
  });
  it('one row per store, month and BA; a shared gap counts for both BAs; clean forms show as Clear', () => {
    const rows = baTags(
      [
        {store_code: '1', period_end: '2026-10-15', consultant: 'Grace Tan', cause: 'padding'},
        {store_code: '1', period_end: '2026-10-31', consultant: 'Grace Tan, Liza Mendoza', cause: 'incorrect_total'},
      ],
      [
        {store_code: '1', month: '2026-10', consultant: 'Grace Tan'},
        {store_code: '2', month: '2026-10', consultant: 'Ana Perez'},
      ],
    );
    expect(rows.map((r) => [r.store_code, r.ba, r.points, r.tag, r.category])).toEqual([
      ['1', 'Grace Tan', 2, 'delinquent', 'padding'],
      ['1', 'Liza Mendoza', 1, 'at_risk', 'incorrect_total'],
      ['2', 'Ana Perez', 0, 'clear', null],
    ]);
  });
});

describe('baScores', () => {
  it('rolls one BA across stores into one month row and skips tiles with no BA', () => {
    const tiles = baTags(
      [
        {store_code: '1', period_end: '2026-10-15', consultant: 'Liza Mendoza', cause: 'messy_handwriting'},
        {store_code: '2', period_end: '2026-10-31', consultant: 'Liza Mendoza', cause: 'incorrect_total'},
        {store_code: '2', period_end: '2026-10-31', consultant: 'Liza Mendoza', cause: 'incorrect_total'},
        {store_code: '3', period_end: '2026-10-31', consultant: null, cause: 'padding'},
      ],
      [{store_code: '4', month: '2026-10', consultant: 'Ana Perez'}],
    );
    expect(baScores(tiles).map((r) => [r.ba, r.stores.sort().join('+'), r.points, r.tag, r.category])).toEqual([
      ['Liza Mendoza', '1+2', 3, 'delinquent', 'incorrect_total'],
      ['Ana Perez', '4', 0, 'clear', null],
    ]);
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
