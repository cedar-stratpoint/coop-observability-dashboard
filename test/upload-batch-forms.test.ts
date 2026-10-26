import {describe, expect, it} from 'vitest';
import {groupForms, scanOrder, scanPosition} from '../src/upload-batch';

describe('scanPosition', () => {
  it('reads where a split page sat in its scan', () => {
    expect(scanPosition('stack (page 7 of 25).pdf')).toEqual({source: 'stack', index: 7});
    expect(scanPosition('1.pdf')).toBeNull();
  });
});

describe('scanOrder', () => {
  it('orders split pages by position, separate files by upload time', () => {
    const pages = [
      {filename: 'stack (page 2 of 3).pdf', created_at: '2026-10-30T01:00:05Z'},
      {filename: 'stack (page 1 of 3).pdf', created_at: '2026-10-30T01:00:06Z'},
      {filename: 'later.pdf', created_at: '2026-10-30T02:00:00Z'},
      {filename: 'stack (page 3 of 3).pdf', created_at: '2026-10-30T01:00:01Z'},
    ];
    expect(scanOrder(pages).map((p) => p.filename)).toEqual(['stack (page 1 of 3).pdf', 'stack (page 2 of 3).pdf', 'stack (page 3 of 3).pdf', 'later.pdf']);
  });
});

describe('groupForms', () => {
  const pages = (...n: Array<number | null>) => n.map((page, i) => ({id: i, page}));
  it('starts a new form whenever the page number drops', () => {
    expect(groupForms(pages(1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2)).map((f) => f.map((p) => p.page))).toEqual([
      [1, 2, 3, 4, 5],
      [1, 2, 3, 4, 5],
      [1, 2],
    ]);
  });
  it('keeps unnumbered pages with their form, and one form stays one', () => {
    expect(groupForms(pages(1, null, 3, 4, 5)).length).toBe(1);
    expect(groupForms(pages(1, 2, null, 1)).map((f) => f.length)).toEqual([3, 1]);
  });
  it('keeps a page scanned twice in its form (the review asks to remove the copy)', () => {
    expect(groupForms(pages(1, 2, 2, 3)).length).toBe(1);
  });
});
