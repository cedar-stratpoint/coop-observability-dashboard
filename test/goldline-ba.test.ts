import {describe, expect, it} from 'vitest';
import {baOnDate, matchBa, resolveBa, shouldRecordBa, type StoreBa} from '../src/goldline-ba';

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
    expect(resolveBa({written: 'Liza M.', storeBas: dir, periodEnd: '2026-10-31'})).toEqual({name: 'Liza Mendoza', source: 'store'});
  });
  it('keeps a written name the directory does not know', () => {
    expect(resolveBa({written: 'Joy Ramos', storeBas: dir, periodEnd: '2026-10-31'})).toEqual({name: 'Joy Ramos', source: 'new'});
  });
  it('falls back to the store BA on the last day when the form has no name', () => {
    expect(resolveBa({written: '  ', storeBas: dir, periodEnd: '2026-10-15'})).toEqual({name: 'Liza Mendoza', source: 'directory'});
    expect(resolveBa({written: null, storeBas: [], periodEnd: '2026-10-15'})).toEqual({name: null, source: 'none'});
  });
});

describe('resolveBa across stores (Oct 27: BAs learned from forms)', () => {
  const known = ['Liza Mendoza', 'Ana Perez', 'Joy Ramos', 'Joy Reyes'];
  it('recognises a known BA who moved stores, full name or first name and last initial', () => {
    expect(resolveBa({written: 'joy ramos', storeBas: [], known, periodEnd: '2026-10-31'})).toEqual({name: 'Joy Ramos', source: 'known'});
    expect(resolveBa({written: 'Ana P.', storeBas: [], known, periodEnd: '2026-10-31'})).toEqual({name: 'Ana Perez', source: 'known'});
  });
  it('matches a shortened word in a longer name', () => {
    expect(resolveBa({written: 'Maria Luisa R.', storeBas: [], known: [...known, 'Maria Luisa Reyes'], periodEnd: '2026-10-31'})).toEqual({name: 'Maria Luisa Reyes', source: 'known'});
    expect(resolveBa({written: 'Maria L. Reyes', storeBas: [], known: [...known, 'Maria Luisa Reyes'], periodEnd: '2026-10-31'})).toEqual({name: 'Maria Luisa Reyes', source: 'known'});
  });
  it('never matches another store on a first name alone, or an ambiguous initial', () => {
    expect(resolveBa({written: 'Ana', storeBas: [], known, periodEnd: '2026-10-31'})).toEqual({name: 'Ana', source: 'new'});
    expect(resolveBa({written: 'Joy R.', storeBas: [], known, periodEnd: '2026-10-31'})).toEqual({name: 'Joy R.', source: 'new'});
  });
  it('prefers the store’s own BAs over the rest', () => {
    expect(resolveBa({written: 'Liza', storeBas: dir, known, periodEnd: '2026-10-31'})).toEqual({name: 'Liza Mendoza', source: 'store'});
  });
});

describe('shouldRecordBa', () => {
  it('records a store’s first BA, and a new BA from a newer cycle', () => {
    expect(shouldRecordBa('Ana Perez', [], '2026-10-16')).toBe(true);
    expect(shouldRecordBa('Joy Ramos', dir, '2026-11-01')).toBe(true);
  });
  it('skips the current BA and forms older than the current assignment', () => {
    expect(shouldRecordBa('ana  perez', dir, '2026-11-01')).toBe(false);
    expect(shouldRecordBa('Joy Ramos', dir, '2026-10-01')).toBe(false);
  });
  it('never rewrites a past stint with no open assignment', () => {
    const closed: StoreBa[] = [{name: 'Liza Mendoza', started_on: '2026-01-01', ended_on: '2026-10-15'}];
    expect(shouldRecordBa('Joy Ramos', closed, '2026-09-01')).toBe(false);
    expect(shouldRecordBa('Joy Ramos', closed, '2026-10-16')).toBe(true);
  });
});
