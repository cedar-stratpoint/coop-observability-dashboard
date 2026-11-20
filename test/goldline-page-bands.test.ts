import {describe, expect, it} from 'vitest';
import {BAND_HEIGHT, BAND_OVERLAP, bandRects, bandsNote} from '../src/goldline-page-bands';

describe('bandRects', () => {
  it('covers a 300 dpi page top to bottom with overlapping 1000 px bands', () => {
    const r = bandRects(3900);
    expect(r[0]).toEqual({y: 0, h: BAND_HEIGHT});
    for (let i = 1; i < r.length; i++) expect(r[i].y).toBe(r[i - 1].y + BAND_HEIGHT - BAND_OVERLAP);
    const last = r.at(-1)!;
    expect(last.y + last.h).toBe(3900);
    expect(r).toHaveLength(5);
  });
  it('drops a trailing sliver the previous band already covers', () => {
    const r = bandRects(840 * 2 + 1000 + 100); // would leave a 100 px last band
    expect(r.every((b) => b.h >= 250)).toBe(true);
  });
  it('returns one band for a short image and none for a bad size', () => {
    expect(bandRects(600)).toEqual([{y: 0, h: 600}]);
    expect(bandRects(0)).toEqual([]);
  });
});

describe('bandsNote', () => {
  it('tells the reader the bands overlap and to place rows by the printed ITEM#', () => {
    const n = bandsNote(5);
    expect(n).toMatch(/next 5 images are ZOOMED/);
    expect(n).toMatch(/ONE number/);
    expect(n).toMatch(/printed ITEM#/);
  });
});
