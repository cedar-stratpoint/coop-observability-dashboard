// How slanted a scanned page is, so review can tilt the row box with the paper (scan-review plan,
// step 4; same method as the answer-key checking page, where it was checked by eye on slanted pages).
// The form is a ruled table: compare the ruled-line pattern of narrow neighbouring strips across the
// table and add up how far each strip's lines sit below the previous one. Neighbouring strips shift by
// only a pixel or two, so the repeating row pattern cannot alias (comparing two far-apart strips can
// lock onto the wrong row and even report the wrong direction). Pure; no image library.

export type Slant = {
  /** Degrees, positive = the rows run down to the right (CSS rotate direction). */
  angle: number;
  /** Where the row positions were measured (the ITEM# column), as a fraction of the page width: the
   *  pivot to tilt a row box around. */
  px: number;
};

const DARK = 140;

/**
 * Estimate the slant of an upright page from a grayscale image (one byte per pixel, row-major).
 * Null when the page has no clear table (too few inked columns) so callers draw a straight box.
 */
export function estimateSlant(gray: Uint8Array | Uint8ClampedArray | number[], w: number, h: number): Slant | null {
  if (!(w > 50 && h > 50) || gray.length < w * h) return null;
  // Table extent: columns inked in many rows, ignoring the scan's own edges.
  const edge = Math.round(w * 0.02);
  let L = -1, R = -1;
  for (let x = edge; x < w - edge; x++) {
    let n = 0;
    for (let y = 0; y < h; y++) if (gray[y * w + x] < DARK) n++;
    if (n / h > 0.08) {
      if (L < 0) L = x;
      R = x;
    }
  }
  if (L < 0 || R - L < w * 0.3) return null;
  const strips = 12;
  const sw = Math.max(8, Math.round(w * 0.028));
  const lim = Math.max(3, Math.round(w * 0.005));
  const xs = Array.from({length: strips}, (_, k) => Math.round(L + (0.08 + (0.84 * k) / (strips - 1)) * (R - L)));
  const prof = xs.map((x0) => {
    const p = new Float64Array(h);
    let mean = 0;
    for (let y = 0; y < h; y++) {
      let n = 0;
      for (let x = x0; x < Math.min(w, x0 + sw); x++) if (gray[y * w + x] < DARK) n++;
      p[y] = n / sw;
      mean += p[y];
    }
    mean /= h;
    for (let y = 0; y < h; y++) p[y] -= mean;
    return p;
  });
  const corr = (a: Float64Array, b: Float64Array, s: number) => {
    let v = 0;
    for (let y = Math.max(0, -s); y < Math.min(h, h - s); y++) v += a[y] * b[y + s];
    return v;
  };
  // Best whole-pixel shift, refined to a fraction of a pixel with a parabola through its neighbours
  // (at 1000 px a 1.4 degree page moves under 2 px per strip, so whole pixels alone read ~25% low).
  const shift = (a: Float64Array, b: Float64Array) => {
    let best = 0, bestV = -Infinity;
    for (let s = -lim; s <= lim; s++) {
      const v = corr(a, b, s);
      if (v > bestV) {
        bestV = v;
        best = s;
      }
    }
    if (best === -lim || best === lim) return best;
    const vm = corr(a, b, best - 1), vp = corr(a, b, best + 1);
    const den = vm - 2 * bestV + vp;
    return den < 0 ? best + (vm - vp) / (2 * den) : best;
  };
  let total = 0;
  for (let k = 1; k < strips; k++) total += shift(prof[k - 1], prof[k]);
  const angle = (Math.atan2(total, xs[strips - 1] - xs[0]) * 180) / Math.PI;
  if (!Number.isFinite(angle) || Math.abs(angle) > 5) return null; // not a plausible scan skew
  return {angle: Math.round(angle * 100) / 100, px: Math.round(((L + 0.04 * (R - L)) / w) * 1000) / 1000};
}
