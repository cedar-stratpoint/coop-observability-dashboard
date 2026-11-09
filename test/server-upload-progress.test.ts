import {describe, expect, it} from 'vitest';
import {isSettledStatus, serverPageState} from '../src/server-upload-progress';

describe('serverPageState', () => {
  it('maps in-flight statuses to live item states', () => {
    expect(serverPageState('queued')).toBe('queued');
    expect(serverPageState('processing')).toBe('running');
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
  it('is false only while queued or processing', () => {
    expect(isSettledStatus('queued')).toBe(false);
    expect(isSettledStatus('processing')).toBe(false);
  });
  it('is true for every terminal status', () => {
    for (const s of ['needs_review', 'committed', 'rejected', 'failed']) {
      expect(isSettledStatus(s)).toBe(true);
    }
  });
});
