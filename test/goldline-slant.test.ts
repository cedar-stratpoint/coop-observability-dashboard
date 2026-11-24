import {describe, expect, it} from 'vitest';
import {estimateSlant} from '../src/goldline-slant';

/** A white page with a ruled table (rules every 22 px, borders) tilted by `deg`. */
function page(deg: number, w = 1000, h = 1400): Uint8Array {
  const g = new Uint8Array(w * h).fill(255);
  const t = Math.tan((deg * Math.PI) / 180);
  const L = 150, R = 900;
  for (let x = L; x <= R; x++) {
    for (let y0 = 120; y0 < 1300; y0 += 22) {
      const y = Math.round(y0 + t * (x - L));
      if (y >= 0 && y < h) g[y * w + x] = 0;
    }
  }
  for (const x of [L, 260, 700, R]) for (let y = 110; y < 1310; y++) g[y * w + x] = 0;
  return g;
}

describe('estimateSlant', () => {
  it.each([0, 0.6, -0.5, 1.4])('reads a %s degree page', (deg) => {
    const s = estimateSlant(page(deg), 1000, 1400);
    expect(s).not.toBeNull();
    expect(Math.abs(s!.angle - deg)).toBeLessThan(0.15);
    expect(s!.px).toBeGreaterThan(0.14);
    expect(s!.px).toBeLessThan(0.2);
  });
  it('gives up on a page with no table', () => {
    expect(estimateSlant(new Uint8Array(1000 * 1400).fill(255), 1000, 1400)).toBeNull();
  });
});
