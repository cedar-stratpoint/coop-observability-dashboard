import {describe, expect, it} from 'vitest';
import {agreedSpelling, formConsultants} from '../src/goldline-ba-reconcile';
import type {ClassifiedPage} from '../src/goldline-segment';

// QA Nov 26: one BA's name read differently on every page of the same form.
type P = ClassifiedPage & {file: string};
let n = 0;
const page = (i: number, pg: number, consultant: string | null, store_code: string | null = '2414'): P => ({
  id: `u${++n}`, file: `Scan (page ${i} of 30).pdf`, page: pg, kind: 'inventory', orientation: 0, version: 'v1',
  store_code, store_name: null, period_start: null, period_end: null, consultant, confidence: 0.9,
});
const at = (p: P) => {
  const m = /^(.*) \(page (\d+) of \d+\)\.pdf$/.exec(p.file);
  return m ? {source: m[1], index: Number(m[2])} : null;
};
const names = (ps: P[]) => ps.map((p) => p.consultant);

describe('agreedSpelling', () => {
  it('takes the name most pages wrote, ignoring case and middle initials, in its fullest form', () => {
    expect(agreedSpelling(['Elaiza Mae V. Caleon', 'Eldiza Mae V. Caleon', 'Elaiza Mae V. Caleon'])).toBe('Elaiza Mae V. Caleon');
    expect(agreedSpelling(['Flordeliza G. Tipay', 'Flor deliza Tibay', 'Fiordeliza Tipay', 'Flordeliza Tipay'])).toBe('Flordeliza G. Tipay');
    expect(agreedSpelling(['ORTEGA, SONNILYN', 'Ortega, Connilyn', 'ORTEGA, CONNILYN', 'ORTEGA, CONNILYN', 'ORTEGA, SONNILYN'])).toBe('Ortega, Connilyn');
  });
  it('on a tie, the reading closest to the others, never simply the longest', () => {
    expect(agreedSpelling(['Nanette Saladaga', 'Nanette Saralaga', 'Nanette Vadpacagia', 'Nanette Vadalagra'])).not.toBe('Nanette Vadpacagia');
  });
});

describe('formConsultants', () => {
  it('the pages of one form agree on one BA, keeping what each page read', () => {
    const ps = [page(1, 1, 'Elaiza Mae V. Calen'), page(2, 2, 'Elaiza Mae V. Caleon'), page(3, 3, 'Elaiza Mae V. Caleon'), page(4, 4, null), page(5, 5, 'Elaiza Mae V. Calleja')];
    const out = formConsultants(ps, at);
    expect(names(out)).toEqual(Array(5).fill('Elaiza Mae V. Caleon'));
    expect(out[0].consultant_read).toBe('Elaiza Mae V. Calen');
    expect(out[3].consultant_read).toBeNull();
    expect(out[1].consultant_read).toBeUndefined(); // already agreed
  });
  it('a "BA" that is really the store is replaced; the registry spelling wins when known', () => {
    const storeName = (c: string) => (c === '1216' ? 'WALTERMART PLARIDEL' : null);
    const ps = [page(19, 1, 'Mary Ann M. Panal', '1216'), page(20, 2, 'Mary Ann Panal', '1216'), page(21, 3, 'Walter Plaridel', '1216')];
    const out = formConsultants(ps, at, ['Mary Ann M. Panal'], storeName);
    expect(names(out)).toEqual(['Mary Ann M. Panal', 'Mary Ann M. Panal', 'Mary Ann M. Panal']);
    expect(out[2].consultant_read).toBe('Walter Plaridel');
  });
  it('a page naming someone else keeps its own name; one reading alone changes nothing', () => {
    const ps = [page(1, 1, 'Chen T. Alesna'), page(2, 2, 'Chen T. Alesha'), page(3, 3, 'Ortega, Connilyn')];
    expect(names(formConsultants(ps, at))).toEqual(['Chen T. Alesna', 'Chen T. Alesna', 'Ortega, Connilyn']);
    const lone = [page(1, 1, 'Chen T. Alesna'), page(2, 2, null)];
    expect(names(formConsultants(lone, at))).toEqual(['Chen T. Alesna', null]);
  });
  it('two different forms in one scan stay apart', () => {
    const ps = [page(1, 1, 'Carmie M. Caridad'), page(2, 2, 'Carmie M. Caridad'), page(3, 1, 'Nanette Saladaga'), page(4, 2, null)];
    expect(names(formConsultants(ps, at))).toEqual(['Carmie M. Caridad', 'Carmie M. Caridad', 'Nanette Saladaga', null]);
  });
});
