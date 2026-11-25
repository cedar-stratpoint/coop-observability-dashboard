import {describe, expect, it} from 'vitest';
import {pageMarks, parseFlagInput, REASON_MAX, rowMarks, upsertLocal, type ReviewMark} from '../src/goldline-review-marks';

const UP = '0b6f6a3e-2d7c-4c1e-9a43-0f3d7a1b2c3d';

describe('parseFlagInput', () => {
  const ok = (raw: unknown) => {
    const r = parseFlagInput(raw);
    if (!r.ok) throw new Error(r.error);
    return r.input;
  };
  it('accepts a row flag and trims the note', () => {
    expect(ok({uploadId: UP, itemCode: ' TCES17317 ', rowIndex: 4, kind: 'damage', reason: '  written  in ending '})).toEqual({uploadId: UP, itemCode: 'TCES17317', rowIndex: 4, kind: 'damage', reason: 'written in ending'});
  });
  it('a page flag has no row', () => {
    expect(ok({uploadId: UP, itemCode: '', rowIndex: 3, kind: 'column_changed', reason: ''})).toEqual({uploadId: UP, itemCode: null, rowIndex: null, kind: 'column_changed', reason: null});
  });
  it('keeps row kinds on rows and page kinds on pages', () => {
    expect(parseFlagInput({uploadId: UP, itemCode: 'A1', kind: 'column_changed'})).toMatchObject({ok: false});
    expect(parseFlagInput({uploadId: UP, itemCode: null, kind: 'illegible'})).toMatchObject({ok: false});
    expect(parseFlagInput({uploadId: UP, itemCode: 'A1', kind: 'added_row'})).toMatchObject({ok: false});
  });
  it('Other needs a note; notes have a limit', () => {
    expect(parseFlagInput({uploadId: UP, itemCode: 'A1', kind: 'other', reason: ' '})).toEqual({ok: false, error: 'Say what to look at.'});
    expect(parseFlagInput({uploadId: UP, itemCode: 'A1', kind: 'note', reason: 'x'.repeat(REASON_MAX + 1)})).toMatchObject({ok: false});
  });
  it('rejects a bad page id, kind or row index', () => {
    expect(parseFlagInput({uploadId: 'nope', itemCode: 'A1', kind: 'note'})).toMatchObject({ok: false});
    expect(parseFlagInput({uploadId: UP, itemCode: 'A1', kind: 'padding'})).toMatchObject({ok: false});
    expect(ok({uploadId: UP, itemCode: 'A1', kind: 'note', rowIndex: -2}).rowIndex).toBeNull();
    expect(parseFlagInput(null)).toMatchObject({ok: false});
  });
});

const mark = (p: Partial<ReviewMark>): ReviewMark => ({
  id: 'm1',
  uploadId: UP,
  itemCode: 'A1',
  rowIndex: 0,
  kind: 'note',
  source: 'reviewer',
  reason: null,
  status: 'open',
  createdBy: 'a@x',
  createdAt: '2026-11-25T08:00:00Z',
  clearedBy: null,
  clearedAt: null,
  ...p,
});

describe('marks on a page', () => {
  const marks = [
    mark({id: '1'}),
    mark({id: '2', kind: 'damage', createdAt: '2026-11-25T09:00:00Z'}),
    mark({id: '3', status: 'cleared', kind: 'illegible'}),
    mark({id: '4', itemCode: null, kind: 'column_changed'}),
  ];
  it('a row shows its open marks, newest first', () => expect(rowMarks(marks, 'A1').map((m) => m.id)).toEqual(['2', '1']));
  it('the page shows its own marks only', () => expect(pageMarks(marks).map((m) => m.id)).toEqual(['4']));
  it('a saved mark replaces the same row, kind and source, else adds', () => {
    expect(upsertLocal(marks, mark({id: '3', kind: 'illegible', status: 'open'})).find((m) => m.id === '3')?.status).toBe('open');
    expect(upsertLocal(marks, mark({id: '9', kind: 'other'}))).toHaveLength(5);
  });
});
