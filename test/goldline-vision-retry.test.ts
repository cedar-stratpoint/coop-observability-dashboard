import {describe, expect, it} from 'vitest';
import {isTransientJsonMiss} from '../src/goldline-extract';

// The extract/classify calls retry only a transient empty/invalid-JSON response (a 200
// with no usable text — observed on live scans, pages 23/33/57/79 that read fine on a
// re-try). Key, content, timeout and shape errors must NOT be classed as transient, so
// they fail fast instead of burning the route's time budget on hopeless re-tries.
describe('isTransientJsonMiss', () => {
  it('matches the transient empty / invalid-JSON misses', () => {
    expect(isTransientJsonMiss(new Error('Vision returned no text content'))).toBe(true);
    expect(isTransientJsonMiss(new Error('Vision did not return valid JSON'))).toBe(true);
    expect(isTransientJsonMiss('Vision did not return valid JSON')).toBe(true);
  });

  it('does not match real errors that should fail fast', () => {
    expect(isTransientJsonMiss(new Error('Request timed out'))).toBe(false);
    expect(isTransientJsonMiss(new Error('credit balance is too low'))).toBe(false);
    expect(isTransientJsonMiss(new Error('Extraction JSON did not match the expected page shape'))).toBe(false);
    expect(isTransientJsonMiss(new Error('Extraction declined: not an inventory page'))).toBe(false);
    expect(isTransientJsonMiss(null)).toBe(false);
  });
});
