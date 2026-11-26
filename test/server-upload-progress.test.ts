import {describe, expect, it} from 'vitest';
import {isSettledStatus, serverPageState, tallyServerPages} from '../src/server-upload-progress';

describe('serverPageState', () => {
  it('maps in-flight statuses to live item states', () => {
    expect(serverPageState('queued')).toBe('queued');
    expect(serverPageState('processing')).toBe('running');
    expect(serverPageState('queued_batch')).toBe('running'); // L7: read is out in a batch
  });
  it('maps every terminal read to done, including a set-aside page', () => {
    expect(serverPageState('needs_review')).toBe('done');
    expect(serverPageState('committed')).toBe('done');
    expect(serverPageState('rejected')).toBe('done'); // set aside, not a failure
  });
  it('maps failed to failed, and anything unknown to queued (safe default)', () => {
    expect(serverPageState('failed')).toBe('failed');
    expect(serverPageState('weird')).toBe('queued');
  });
});

describe('isSettledStatus', () => {
  it('is false while queued, queued_batch (L7), or processing', () => {
    expect(isSettledStatus('queued')).toBe(false);
    expect(isSettledStatus('queued_batch')).toBe(false);
    expect(isSettledStatus('processing')).toBe(false);
  });
  it('is true for every terminal status', () => {
    for (const s of ['needs_review', 'committed', 'rejected', 'failed']) {
      expect(isSettledStatus(s)).toBe(true);
    }
  });
});

describe('tallyServerPages', () => {
  it('counts read, set aside, failed and in flight for an earlier scan row', () => {
    const t = tallyServerPages(['needs_review', 'committed', 'rejected', 'failed', 'queued', 'queued_batch', 'processing'].map((status) => ({status})));
    expect(t).toEqual({total: 7, read: 2, setAside: 1, failed: 1, inFlight: 3});
    expect(tallyServerPages([])).toEqual({total: 0, read: 0, setAside: 0, failed: 0, inFlight: 0});
  });
});
