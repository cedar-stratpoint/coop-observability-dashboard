import {describe, expect, it} from 'vitest';
import {bandOf, summarizeConfidence} from './review-confidence';

describe('bandOf', () => {
  it('splits at 0.6 and 0.85', () => {
    expect(bandOf(0.59)).toBe('low');
    expect(bandOf(0.6)).toBe('medium');
    expect(bandOf(0.849)).toBe('medium');
    expect(bandOf(0.85)).toBe('high');
  });
});

describe('summarizeConfidence', () => {
  it('counts rows per band (missing confidence counts as high, as elsewhere)', () => {
    const s = summarizeConfidence(0.9, [0.95, 0.9, 0.7, 0.5, undefined]);
    expect(s.counts).toEqual({high: 3, medium: 1, low: 1});
    expect(s.total).toBe(5);
  });
  it('high with flags points at the flagged rows', () => {
    const s = summarizeConfidence(0.95, [0.99, 0.5, 0.4]);
    expect(s.band).toBe('high');
    expect(s.verdict).toBe('High confidence');
    expect(s.guidance).toMatch(/2 rows flagged/);
  });
  it('medium and low change the instruction', () => {
    expect(summarizeConfidence(0.7, [0.7]).guidance).toMatch(/Review carefully/);
    expect(summarizeConfidence(0.4, [0.4]).guidance).toMatch(/every row/);
  });
  it('treats malformed row values as 1 (same as the table)', () => {
    expect(summarizeConfidence(0.9, [Number.NaN, 2, -1]).counts).toEqual({high: 2, medium: 0, low: 1});
  });
  it('handles no score and clamps out-of-range', () => {
    expect(summarizeConfidence(null, []).band).toBeNull();
    expect(summarizeConfidence(1.4, [1]).score).toBe(1);
  });
});
