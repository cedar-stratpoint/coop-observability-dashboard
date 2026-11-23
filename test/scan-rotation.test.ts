import {describe, expect, it} from 'vitest';
import {effectiveRotation} from '../components/analyst/scan-rotation';

describe('effectiveRotation', () => {
  it('shows an upright page as is, and an upside-down page turned', () => {
    expect(effectiveRotation(0, false)).toBe(0);
    expect(effectiveRotation(null, false)).toBe(0);
    expect(effectiveRotation(undefined, false)).toBe(0);
    expect(effectiveRotation(180, false)).toBe(180);
  });
  it('a reviewer flip turns the page once more', () => {
    expect(effectiveRotation(0, true)).toBe(180);
    expect(effectiveRotation(180, true)).toBe(0);
  });
  it('ignores values other than 180', () => {
    expect(effectiveRotation(90, false)).toBe(0);
  });
});
