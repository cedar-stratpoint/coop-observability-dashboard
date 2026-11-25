import {describe, expect, it} from 'vitest';
import {exportRow, EXPORT_HEAD, filePage, filterLines, pageLabel, parseFlagFilter, type FlagLine} from '../src/goldline-flag-lines';

const line = (p: Partial<FlagLine>): FlagLine => ({
  key: 'k',
  source: 'reviewer',
  why: 'Damage written',
  note: null,
  open: true,
  storeCode: '473',
  storeName: 'Watsons SM San Pablo',
  ba: 'Leonisa Ramos',
  month: '2026-09',
  itemCode: 'TCES17317',
  product: 'True Colors Eye Shadow · Electric Pink',
  uploadId: 'u1',
  file: 'Oct scan',
  page: 11,
  pageOf: 98,
  createdAt: '2026-11-25T09:00:00Z',
  ...p,
});

describe('filePage', () => {
  it('reads the page out of a scan page file, preferring the batch name', () => {
    expect(filePage('Oct scan (page 7 of 98).pdf')).toEqual({file: 'Oct scan', page: 7, pageOf: 98});
    expect(filePage('Oct scan (page 7 of 98).pdf', 'Nov 24 Test Run')).toEqual({file: 'Nov 24 Test Run', page: 7, pageOf: 98});
    expect(filePage('form.pdf')).toEqual({file: 'form.pdf', page: null, pageOf: null});
    expect(filePage(null)).toEqual({file: null, page: null, pageOf: null});
  });
  it('labels the page', () => {
    expect(pageLabel({page: 7, pageOf: 98})).toBe('Page 7 of 98');
    expect(pageLabel({page: null, pageOf: null})).toBeNull();
  });
});

describe('parseFlagFilter', () => {
  it('never trusts the URL', () => {
    expect(parseFlagFilter({store: 'all', month: '2026-9', source: 'padding', status: 'x', q: '  glow '})).toEqual({store: null, month: null, source: null, open: 'open', q: 'glow'});
    expect(parseFlagFilter({store: '473', month: '2026-09', source: 'reader', status: 'all'})).toMatchObject({store: '473', month: '2026-09', source: 'reader', open: 'all'});
  });
});

describe('filterLines', () => {
  const lines = [
    line({key: 'a', storeCode: '5300', page: 3}),
    line({key: 'b', page: 11}),
    line({key: 'c', page: 7, source: 'check', why: 'Messy handwriting'}),
    line({key: 'd', open: false}),
    line({key: 'e', storeCode: null, month: null}),
  ];
  const keys = (p: Record<string, string>) => filterLines(lines, parseFlagFilter(p)).map((l) => l.key);
  it('open only by default, sorted by store then page, unknown store last', () => expect(keys({})).toEqual(['c', 'b', 'a', 'e']));
  it('one store, one source, closed too, and search', () => {
    expect(keys({store: '473'})).toEqual(['c', 'b']);
    expect(keys({source: 'check'})).toEqual(['c']);
    expect(keys({store: '473', status: 'all'})).toContain('d');
    expect(keys({q: 'messy'})).toEqual(['c']);
  });
});

describe('exportRow', () => {
  it('matches the head and says what to do with no dashes', () => {
    const r = exportRow(line({note: 'Under Ending'}));
    expect(r).toHaveLength(EXPORT_HEAD.length);
    expect(r).toEqual(['473', 'Watsons SM San Pablo', 'Leonisa Ramos', '2026-09', 'TCES17317', 'True Colors Eye Shadow · Electric Pink', 'Damage written', 'Under Ending', 'Reviewer', 'Oct scan', 'Page 11 of 98', 'Open', '2026-11-25']);
    expect(exportRow(line({source: 'check', open: false}))[11]).toBe('Resolved');
    expect(exportRow(line({open: false}))[11]).toBe('Cleared');
  });
});
