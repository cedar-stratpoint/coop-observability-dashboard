import {describe, expect, it} from 'vitest';
import {bulkVerdict} from '../src/upload-batch';

// "Commit all" on a grouped upload (Nov 25): the single-form rules, except unchecked rows.
const page = (p: number, flagged = 0, status = 'needs_review', detectedStore: string | null = '473') => ({uploadId: `u${p}`, page: p, flagged, resolved: 0, status, detectedStore});
const form = (pages = [page(1), page(2)], storeCode = '473') => ({storeCode, periodStart: '2026-09-16', periodEnd: '2026-09-30', pages});

describe('bulkVerdict', () => {
  it('a clean form is ready', () => expect(bulkVerdict(form())).toEqual({state: 'ready'}));
  it('unchecked low-confidence rows are counted, not a blocker', () => {
    expect(bulkVerdict(form([page(1, 3), page(2, 2)]))).toEqual({state: 'flagged', rows: 5});
  });
  it('whatever stops a single commit stops this one', () => {
    expect(bulkVerdict(form(undefined, ''))).toMatchObject({state: 'blocked', reason: 'Enter the store code.'});
    expect(bulkVerdict(form([page(1), page(2, 0, 'processing')]))).toMatchObject({state: 'blocked'});
    expect(bulkVerdict(form([page(1), page(1)]))).toMatchObject({state: 'blocked', reason: expect.stringMatching(/twice/)});
    expect(bulkVerdict(form([page(1), page(2, 0, 'needs_review', '5300')]))).toMatchObject({state: 'blocked', reason: expect.stringMatching(/different stores/)});
    expect(bulkVerdict({...form(), periodStart: '2026-09-31x'})).toMatchObject({state: 'blocked'});
  });
  it('nothing left to commit is not ready', () => {
    expect(bulkVerdict(form([page(1, 0, 'committed')]))).toMatchObject({state: 'blocked'});
  });
});
