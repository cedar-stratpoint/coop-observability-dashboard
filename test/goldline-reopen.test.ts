import {describe, expect, it} from 'vitest';
import {committedCodes, reopenedNote, restoreCommitted, reviewedRows, type CommittedRow} from '../src/goldline-reopen';
import {countsAgainstBa, withdrawnBy} from '../src/goldline-checks';
import {withdrawnNote} from '../src/goldline-flag-lines';
import type {ExtractedPage, ExtractedRow} from '../src/goldline-extract-run';

// Reopen for review (Nov 27). Plan: knowledge/tasks/2026-11-27-reopen-flare-band-wording.md (W3).

const row = (item_code: string, p: Partial<ExtractedRow> = {}): ExtractedRow => ({
  item_code, stockroom: null, drawer: null, selling_area: null, delivery: null, ending_on_hand: null, confidence: 0.9, ...p,
});
const committed = (item_code: string, p: Partial<CommittedRow> = {}): CommittedRow => ({
  item_code, store_code: '5300', period_start: '2026-09-01', period_end: '2026-09-15', consultant: 'Ma. Sofia Lucero',
  stockroom: null, drawer: null, selling_area: null, delivery: null, ending_on_hand: null, extra: null, ...p,
});
const read: ExtractedPage = {
  store_code: '5308', period_start: '09/09', period_end: null, consultant: 'Sofia',
  rows: [
    row('ELCX1313', {selling_area: 8, ending_on_hand: 8, confidence: 0.45}), // reader misread 7 as 8
    row('ELIF3125B', {confidence: 0.5}),
    row('EFLLF12', {selling_area: 2, ending_on_hand: 2}),
  ],
  bands: [{group: 'ELISE LASHES', amount: 4522, written_price: null, printed_price: 238, pieces: 19, kind: null, offer_price: null, first_index: 0, codes: ['ELCX1313'], use_price: 238}],
};
const at = '2026-11-27T05:00:00.000Z';
const o = {version: 'v1', pageNo: 5, at, by: 'reviewer@example.com'};

describe('restoreCommitted', () => {
  it('gives each read row its committed cells and marks it reviewed; header takes the commit', () => {
    const {page, restored} = restoreCommitted(read, [
      committed('ELCX1313', {selling_area: 7, ending_on_hand: 7}),
      committed('ELIF3125B'),
      committed('EFLLF12', {selling_area: 2, ending_on_hand: 2}),
    ], o);
    expect(restored).toBe(3);
    expect(page.rows[0]).toMatchObject({item_code: 'ELCX1313', selling_area: 7, ending_on_hand: 7, reviewed: true, confidence: 0.45});
    expect(page.rows.every((r) => r.reviewed)).toBe(true);
    expect(page).toMatchObject({store_code: '5300', period_start: '2026-09-01', period_end: '2026-09-15', consultant: 'Ma. Sofia Lucero'});
    expect(page.reopened).toEqual({at, by: 'reviewer@example.com', store_code: '5300', period_start: '2026-09-01', period_end: '2026-09-15', consultant: 'Ma. Sofia Lucero', restored: 3, kept_elsewhere: []});
    // Band picks ride along untouched.
    expect(page.bands?.[0].use_price).toBe(238);
  });

  it('appends a product the reviewer added; a row whose count moved to another page keeps the read', () => {
    const {page} = restoreCommitted(read, [
      committed('ELCX1313', {selling_area: 7, ending_on_hand: 7}),
      committed('JLLS05', {selling_area: 1, ending_on_hand: 1}),
    ], {...o, keptElsewhere: ['EFLLF12']});
    expect(page.rows).toHaveLength(4);
    expect(page.rows[3]).toMatchObject({item_code: 'JLLS05', ending_on_hand: 1, added: true, reviewed: true});
    expect(page.rows[2]).toMatchObject({item_code: 'EFLLF12', ending_on_hand: 2});
    expect(page.rows[2].reviewed).toBeUndefined();
    expect(page.reopened?.kept_elsewhere).toEqual(['EFLLF12']);
  });

  it('matches accessories under the product code they were committed as', () => {
    const acc: ExtractedPage = {store_code: '473', rows: [row('ACCS 288', {printed_name: 'Nichido Stippling Brush #185'}), row('ACCS 288', {printed_name: 'Nichido Foundation Brush #193'})]};
    const codes = committedCodes(acc, 'v1', 4);
    expect(codes[0]).not.toBe('ACCS 288');
    const {page} = restoreCommitted(acc, [committed(codes[0], {ending_on_hand: 3}), committed(codes[1], {ending_on_hand: 5})], {...o, pageNo: 4});
    expect(page.rows.map((r) => r.ending_on_hand)).toEqual([3, 5]);
    // The read keeps its printed codes (commit maps them again).
    expect(page.rows.map((r) => r.item_code)).toEqual(['ACCS 288', 'ACCS 288']);
  });

  it('Legacy: restores its own counts in extra, keeps the read\'s other extras', () => {
    const leg: ExtractedPage = {store_code: '473', rows: [row('EGLE', {extra: {beginning: 9, begin_plus_delivery: 9, deducted_pcs: 2}})]};
    const {page} = restoreCommitted(leg, [committed('EGLE', {ending_on_hand: 7, extra: {beginning: 10, begin_plus_delivery: 10, deducted_pcs: 3, unit_price: 168}})], {...o, version: 'legacy'});
    expect(page.rows[0].extra).toEqual({beginning: 10, begin_plus_delivery: 10, deducted_pcs: 3});
  });

  it('nothing committed: the page is unchanged', () => {
    expect(restoreCommitted(read, [], o)).toEqual({page: read, restored: 0});
  });
});

describe('reviewedRows / reopenedNote', () => {
  it('starts committed rows answered', () => {
    expect([...reviewedRows([{reviewed: true}, {}, {reviewed: true}])]).toEqual([0, 2]);
    expect(reviewedRows(null).size).toBe(0);
  });
  it('says who, when, and what stays elsewhere, without dashes', () => {
    const n = reopenedNote({at, by: 'lance@example.com', kept_elsewhere: ['EFLLF12', 'EFLLF13']});
    expect(n).toMatch(/^Reopened for review by lance on Nov 27\./);
    expect(n).toMatch(/2 counts stay in Inventory from another page \(EFLLF12, EFLLF13\)\./);
    expect(n).not.toMatch(/[–—]/);
    expect(reopenedNote({at, by: null, kept_elsewhere: []})).not.toMatch(/another page/);
  });
});

describe('withdrawn checks', () => {
  it('only the reopened page\'s stopped checks are withdrawn', () => {
    const stopped = [{id: 'a', source_upload_id: 'p21'}, {id: 'b', source_upload_id: 'p32'}, {id: 'c', source_upload_id: null}, {id: 'd', source_upload_id: 'p21'}];
    expect(withdrawnBy(stopped, 'p21')).toEqual(['a', 'd']);
  });
  it('a withdrawn check does not count against the BA; open and resolved still do', () => {
    expect(countsAgainstBa('withdrawn')).toBe(false);
    expect(countsAgainstBa('resolved')).toBe(true);
    expect(countsAgainstBa('open')).toBe(true);
  });
  it('the hub says why it closed', () => {
    expect(withdrawnNote(null)).toBe('Withdrawn: its page was reopened for review, so it no longer counts against the BA.');
    expect(withdrawnNote('checked with the BA')).toMatch(/BA\. checked with the BA$/);
  });
});
