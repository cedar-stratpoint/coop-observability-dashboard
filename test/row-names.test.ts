import {describe, expect, it} from 'vitest';
import {rowNames} from '../src/row-names';
import {printedPageItems} from '../src/goldline-printed-page';

const names = (codes: string[], v: string | null, p: number) => rowNames(codes.map((item_code) => ({item_code})), v, p);

describe('rowNames', () => {
  it.each(['legacy', 'v1', 'v2'])('gives every row of every %s page its own printed name', (v) => {
    for (let p = 1; p <= 5; p++) {
      const items = printedPageItems(v, p);
      expect(names(items.map((i) => i.code), v, p)).toEqual(items.map((i) => i.product));
    }
  });
  it('tells the five ACCS 288 brushes apart', () => {
    const got = names(['ACCS 288', 'ACCS 288', 'ACCS 288', 'ACCS 288', 'ACCS 288'], 'v1', 4);
    expect(new Set(got).size).toBe(5);
    expect(got[0]).toContain('#185');
  });
  it('names the codes older reads used, whatever their spacing', () => {
    const [a, b] = names(['ACCS185', 'ACCS03'], 'legacy', 4);
    expect(a).toMatch(/185|Stippling/i);
    expect(b).toContain('#03');
  });
  it('finds a row whose page number was read wrong, and leaves what it cannot name', () => {
    expect(names(['HSGCC'], 'v2', 1)[0]).toBeTruthy();
    expect(names(['NOPE123'], 'v1', 1)).toEqual([null]);
    expect(rowNames([{item_code: '', printed_name: 'Amber'}, {item_code: 'NOPE', printed_name: 'Paper name'}], 'v1', 1)).toEqual(['Amber', 'Paper name']);
  });
  it('never invents a name for an extra row with a shared code', () => {
    expect(names(Array(6).fill('ACCS 288'), 'v1', 4)[5]).toBeNull();
  });
});

// QA San Pablo (Nov 25): these rows showed the reader's note, or a shortened catalog name, where
// the printed name belongs. They show the name printed on the Legacy form, even with a note on
// the row or a printed name the reader read differently.
describe('Legacy page 3 names as printed (QA Nov 25)', () => {
  it.each([
    ['24HRMESGDE', 'Double Espresso'],
    ['24HRMESGM', 'Macchiato'],
    ['24HRTEEP', 'TO1 - Black (Quick dry)'],
    ['LEL091', 'LIQUID EYELINER SMALL (Black)'],
    ['EGLE', 'EASY GLIDE LIQUID EYELINER 3ml (black)'],
  ])('%s → %s', (code, name) => {
    expect(rowNames([{item_code: code, printed_name: 'Maybe: O/S written, no counts'}], 'legacy', 3)).toEqual([name]);
    expect(names([code], 'legacy', 3)).toEqual([name]);
  });
});
