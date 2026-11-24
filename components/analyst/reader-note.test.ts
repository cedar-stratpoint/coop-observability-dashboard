import {describe, expect, it} from 'vitest';
import {noteLayout, readerNote} from './reader-note';

describe('readerNote', () => {
  it('rewrites the QA examples into column names (Legacy page filed as locations)', () => {
    expect(readerNote('ending circled 3 with 1; equals beginning 20 + col3 11; col3 could be 1', 'legacy-locations')).toBe(
      'Ending circled 3 with 1; equals stockroom 20 + selling area 11; selling area could be 1',
    );
    expect(readerNote('O/S; off_manifest: printed row not in reference list, printed name Double Espresso', 'legacy-locations')).toBe(
      'O/S; not on the usual list for this page, printed as "Double Espresso"',
    );
    expect(readerNote('off_manifest: printed row not in reference list, printed name TO1 - Black Quick dry; blank counts', 'legacy-printed')).toBe(
      'Not on the usual list for this page, printed as "TO1 - Black Quick dry"; blank counts',
    );
  });
  it('drops a stale "not in the list" remark when the row is on the page list', () => {
    expect(readerNote('O/S; not in reference list', 'legacy-locations', {known: true})).toBe('O/S');
    expect(readerNote('O/S; off_manifest: printed row not in reference list, printed name Double Espresso', 'legacy-locations', {known: true})).toBe('O/S');
    expect(readerNote('off_manifest: printed row not in reference list, printed name TO1 - Black; blank counts', 'legacy-printed', {known: true})).toBe('Blank counts');
    expect(readerNote('O/S; not in reference list', 'legacy-locations')).toBe('O/S; not on the usual list for this page');
  });
  it('leaves nothing of "printed but not in reference list" behind (scan page 7, page 70)', () => {
    const known = (s: string) => readerNote(s, 'legacy-locations', {known: true});
    expect(known('O/S; off_manifest: printed but not in reference list')).toBe('O/S');
    expect(known('off_manifest: printed but not in reference list; blank row')).toBe('Blank row');
    expect(known("off_manifest: printed but not in reference list; printed name 'Macchiato'; O/S marked")).toBe('O/S marked');
  });
  it('names columns by each layout', () => {
    expect(readerNote('col4 could be 7', 'v1')).toBe('Delivery could be 7');
    expect(readerNote('col1 could be 7', 'v2')).toBe('Delivery could be 7');
    expect(readerNote('col3 could be 25', 'legacy-printed')).toBe('Beginning + Delivery could be 25');
    expect(readerNote('ending_on_hand unclear, selling_area 4', 'v1')).toBe('Ending unclear, selling area 4');
  });
  it('leaves plain notes alone and drops empty ones', () => {
    expect(readerNote('drawer could be 30', 'v1')).toBe('Drawer could be 30');
    expect(readerNote('  ', 'v1')).toBeNull();
    expect(readerNote(null, 'v1')).toBeNull();
    expect(readerNote('off_manifest', 'v1')).toBeNull();
  });
});

describe('noteLayout', () => {
  it('reads a Legacy row as locations when it was filed that way', () => {
    expect(noteLayout('legacy', {drawer: 4})).toBe('legacy-locations');
    expect(noteLayout('legacy', {})).toBe('legacy-printed');
    expect(noteLayout('v2', {})).toBe('v2');
    expect(noteLayout(null, {})).toBe('v1');
  });
});
