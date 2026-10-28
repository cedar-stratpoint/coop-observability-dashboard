import {describe, expect, it} from 'vitest';
import {last12Months} from '../src/goldline-overview';

describe('last12Months', () => {
  it('ends at the given month and crosses the year', () => {
    const m = last12Months('2026-09-01');
    expect(m).toHaveLength(12);
    expect(m[0]).toBe('2025-10-01');
    expect(m[11]).toBe('2026-09-01');
    expect(last12Months('2026-02-16')[0]).toBe('2025-03-01');
  });
});
