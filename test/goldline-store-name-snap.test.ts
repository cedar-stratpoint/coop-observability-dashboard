import {describe, expect, it} from 'vitest';
import {applyStoreRegistry, snapStoreWithName, type ClassifiedPage, type StoreRef} from '../src/goldline-segment';
import {storeCheckNote} from '../src/store-check-note';

// QA Nov 26: store 2414 (SM CENTER PULILAN) was read as 2944, 2410, 2494 and 2140 while the store
// name beside it was read right every time. Registry names are truncated to 20 characters.
const STORES: StoreRef[] = [
  {code: '2414', name: 'SM CENTER PULILAN'},
  {code: '2413', name: 'SM CITY-SAN JOSE DEL'},
  {code: '2415', name: 'ROBINSONS MALOLOS'},
  {code: '241', name: 'SM CITY-NORTH EDSA 2'},
  {code: '2934', name: 'GAISANO GRAND CITY G'},
  {code: '2946', name: 'GAISANO COUNTRY MALL'},
  {code: '473', name: 'SM CITY-SAN PABLO 1'},
  {code: '1269', name: 'PREMIER PLAZA MALL S'},
];
const NAME = 'Watsons SM Center Pulilan';

describe('snapStoreWithName', () => {
  it('a misread code beside a clear store name snaps to that store, by name', () => {
    for (const read of ['2944', '2410', '2494', '2140']) {
      expect(snapStoreWithName(read, NAME, STORES)).toEqual({code: '2414', status: 'corrected', from: read, by: 'name'});
    }
    expect(snapStoreWithName('2494', 'Watsons CM Center Pulilan', STORES).code).toBe('2414'); // name misread too
  });
  it('without a usable name it is the plain code snap', () => {
    expect(snapStoreWithName('2410', null, STORES).status).toBe('ambiguous');
    expect(snapStoreWithName('2944', 'Watsons Mall', STORES).status).toBe('ambiguous'); // 2934 and 2946 are both one away
    expect(snapStoreWithName('472', null, STORES)).toEqual({code: '473', status: 'corrected', from: '472'});
  });
  it('a code too far from the named store is not corrected, the named store is offered first', () => {
    const s = snapStoreWithName('8800', NAME, STORES);
    expect(s.code).toBe('8800');
    expect(s.status).toBe('unknown');
    expect(s.candidates?.[0]).toBe('2414');
  });
  it('a real code is never overridden; a close store the name points at is flagged as a mismatch', () => {
    expect(snapStoreWithName('2415', NAME, STORES)).toEqual({code: '2415', status: 'name_mismatch', candidates: ['2414']});
    expect(snapStoreWithName('2414', NAME, STORES)).toEqual({code: '2414', status: 'exact'});
    expect(snapStoreWithName('473', NAME, STORES)).toEqual({code: '473', status: 'exact'}); // far apart: not a misread
  });
  it('no code read: the named store is only suggested', () => {
    expect(snapStoreWithName(null, NAME, STORES)).toEqual({code: null, status: 'missing', candidates: ['2414']});
  });
  it('the board regroups older pages by name too (applyStoreRegistry)', () => {
    const page = {id: 'u1', page: 1, kind: 'inventory', orientation: 0, version: 'v1', store_code: '2944', store_name: NAME, period_start: null, period_end: null, consultant: null, confidence: 0.85} as ClassifiedPage;
    const [p] = applyStoreRegistry([page], STORES);
    expect(p.store_code).toBe('2414');
    expect(p.store_snap?.by).toBe('name');
    // Plain codes (no names) still work as before.
    expect(applyStoreRegistry([page], ['2414', '2413'])[0].store_code).toBe('2944');
  });
});

describe('storeCheckNote', () => {
  const nameOf = (c: string) => ({'2414': 'SM Center Pulilan', '2413': 'SM City-San Jose Del'})[c] ?? null;
  it('says what Coop did and offers the way back', () => {
    const n = storeCheckNote({status: 'corrected', from: '2944', by: 'name', candidates: []}, '2414', nameOf);
    expect(n?.text).toContain('Coop read 2944 on the page, which isn’t a known store');
    expect(n?.text).toContain('2414 · SM Center Pulilan');
    expect(n?.action).toEqual({label: 'Undo, use 2944', code: '2944'});
  });
  it('an unknown code offers the likely store', () => {
    const n = storeCheckNote({status: 'ambiguous', from: null, by: null, candidates: ['2413', '2414']}, '2410', nameOf);
    expect(n?.text).toBe('Coop read 2410 on the page, which isn’t a known store. The nearest code is 2413 · SM City-San Jose Del. Pick the right store.');
    const p30 = storeCheckNote({status: 'ambiguous', from: null, by: null, candidates: ['2413']}, '1769', nameOf, 'Gaisano Central Surigao');
    expect(p30?.text).toBe('Coop read 1769 on the page, which isn’t a known store. The nearest code is 2413 · SM City-San Jose Del. The page says “Gaisano Central Surigao”. Pick the right store.');
    expect(n?.action).toEqual({label: 'Use 2413 · SM City-San Jose Del', code: '2413'});
  });
  it('a name mismatch and a missing code with a named store', () => {
    expect(storeCheckNote({status: 'name_mismatch', from: null, by: null, candidates: ['2414']}, '2415', nameOf)?.action?.code).toBe('2414');
    expect(storeCheckNote({status: 'missing', from: null, by: null, candidates: ['2414']}, '', nameOf)?.text).toContain('couldn’t read a store code');
    expect(storeCheckNote({status: 'missing', from: null, by: null, candidates: []}, '', nameOf)).toBeNull();
    expect(storeCheckNote(null, '2414', nameOf)).toBeNull();
  });
  it('never uses dashes in the copy', () => {
    for (const status of ['corrected', 'ambiguous', 'unknown', 'name_mismatch', 'missing'] as const) {
      const n = storeCheckNote({status, from: '2944', by: 'name', candidates: ['2414']}, '2410', nameOf);
      expect(`${n?.text ?? ''} ${n?.action?.label ?? ''}`).not.toMatch(/[–—]/);
    }
  });
});
