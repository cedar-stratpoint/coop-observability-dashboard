import {describe, expect, it} from 'vitest';
import {baOnDate, matchBa, parseBaLines, resolveBa, type StoreBa} from '../src/goldline-ba';

const dir: StoreBa[] = [
  {name: 'Liza Mendoza', started_on: '2026-01-01', ended_on: '2026-10-15'},
  {name: 'Ana Perez', started_on: '2026-10-16', ended_on: null},
];

describe('matchBa', () => {
  it('matches ignoring case and dots, and a shortened last name when only one fits', () => {
    expect(matchBa('liza  mendoza', ['Liza Mendoza'])).toBe('Liza Mendoza');
    expect(matchBa('Liza M.', ['Liza Mendoza', 'Ana Perez'])).toBe('Liza Mendoza');
    expect(matchBa('Liza', ['Liza Mendoza'])).toBe('Liza Mendoza');
  });
  it('refuses to guess between two BAs with the same first name', () => {
    expect(matchBa('Liza M.', ['Liza Mendoza', 'Liza Marquez'])).toBeNull();
    expect(matchBa('Grace T.', ['Liza Mendoza'])).toBeNull();
  });
});

describe('baOnDate', () => {
  it('picks the assignment covering the date', () => {
    expect(baOnDate(dir, '2026-10-15')).toBe('Liza Mendoza');
    expect(baOnDate(dir, '2026-10-31')).toBe('Ana Perez');
    expect(baOnDate(dir, '2025-12-31')).toBeNull();
  });
});

describe('resolveBa', () => {
  it('uses the written name, completed from the directory', () => {
    expect(resolveBa({written: 'Liza M.', storeBas: dir, periodEnd: '2026-10-31'})).toEqual({name: 'Liza Mendoza', source: 'form'});
  });
  it('keeps a written name the directory does not know', () => {
    expect(resolveBa({written: 'Joy Ramos', storeBas: dir, periodEnd: '2026-10-31'})).toEqual({name: 'Joy Ramos', source: 'form'});
  });
  it('falls back to the store BA on the last day when the form has no name', () => {
    expect(resolveBa({written: '  ', storeBas: dir, periodEnd: '2026-10-15'})).toEqual({name: 'Liza Mendoza', source: 'directory'});
    expect(resolveBa({written: null, storeBas: [], periodEnd: '2026-10-15'})).toEqual({name: null, source: 'none'});
  });
});

describe('parseBaLines', () => {
  it('reads comma, tab or spaced lines, skips a header, reports the rest', () => {
    const {rows, errors} = parseBaLines('Store code, BA name\n1, Liza Mendoza\n2\tAna Perez\n15    Joy  Ramos\n\nnonsense');
    expect(rows).toEqual([
      {store: '1', name: 'Liza Mendoza'},
      {store: '2', name: 'Ana Perez'},
      {store: '15', name: 'Joy Ramos'},
    ]);
    expect(errors).toEqual(['nonsense']);
  });
});
