import {describe, expect, it} from 'vitest';
import {axisTicks, fmtAxisTick} from '../src/plan-axis';

// Owner, 2026-11-06 ("sure ka tama to?"): the cash chart's y-axis read 0k, 0k, 1k, 1k, 2k. The gridlines sat on padded, un-round values and each label was
// rounded to the nearest thousand. Ticks are now round steps and a label keeps the decimals its step needs, so no two labels repeat.
describe('chart y-axis ticks', () => {
  it('round steps covering the data, never two equal labels', () => {
    const {ticks} = axisTicks(120, 1890);
    expect(ticks).toEqual([0, 500, 1000, 1500, 2000]);
    const labels = ticks.map((v) => fmtAxisTick(v, 500));
    expect(labels).toEqual(['0', '500', '1k', '1.5k', '2k']);
    expect(new Set(labels).size).toBe(labels.length);
  });
  it('a range that goes below zero', () => {
    const {ticks, lo, hi} = axisTicks(-340, 760);
    expect(lo).toBeLessThanOrEqual(-340);
    expect(hi).toBeGreaterThanOrEqual(760);
    expect(ticks).toContain(0);
    expect(ticks.map((v) => fmtAxisTick(v, ticks[1] - ticks[0]))).toEqual(['−500', '0', '500', '1k']);
  });
  it('millions', () => {
    const {ticks} = axisTicks(0, 4_200_000);
    expect(ticks.map((v) => fmtAxisTick(v, ticks[1] - ticks[0]))).toEqual(['0', '2M', '4M', '6M']);
  });
  it('a flat line still gets a range', () => {
    const {ticks} = axisTicks(800, 800);
    expect(ticks.length).toBeGreaterThan(1);
  });
});
