import {describe, it, expect} from 'vitest';
import {printedNameConflict} from '../src/review-workbench';

describe('printedNameConflict', () => {
  it('flags a real disagreement (BB03B printed "BB 04 Beige" vs catalog "BB 03 Beige")', () => {
    expect(printedNameConflict('BB 04 Beige', 'BB 03 Beige')).toBe(true);
  });

  it('ignores case, spacing and punctuation differences', () => {
    expect(printedNameConflict('BB 03  Beige', 'bb03 beige')).toBe(false);
    expect(printedNameConflict('BB-03-BEIGE', 'BB 03 Beige')).toBe(false);
  });

  it('stays quiet when either side is blank (old scans with no printed_name)', () => {
    expect(printedNameConflict(null, 'BB 03 Beige')).toBe(false);
    expect(printedNameConflict(undefined, 'BB 03 Beige')).toBe(false);
    expect(printedNameConflict('BB 03 Beige', null)).toBe(false);
    expect(printedNameConflict('', 'BB 03 Beige')).toBe(false);
    expect(printedNameConflict('   ', 'BB 03 Beige')).toBe(false);
  });

  it('matches identical names', () => {
    expect(printedNameConflict('BB 03 Beige', 'BB 03 Beige')).toBe(false);
  });
});
