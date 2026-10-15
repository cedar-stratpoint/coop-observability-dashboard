import {describe, expect, it} from 'vitest';
import {fetchAllRows} from './pos-fetch-paginate';

// A fake paged table: rows 0..n-1, pages via (from, to) like PostgREST .range().
function table(n: number) {
  const calls: Array<[number, number]> = [];
  const makePage = async (from: number, to: number) => {
    calls.push([from, to]);
    const data = Array.from({length: Math.max(0, Math.min(to, n - 1) - from + 1)}, (_, i) => ({i: from + i}));
    return {data, error: null};
  };
  return {makePage, calls};
}

describe('fetchAllRows — parallel mode', () => {
  it('returns the same rows, in order, as the sequential loop', async () => {
    for (const n of [0, 1, 9, 10, 11, 25, 40, 41]) {
      const seq = await fetchAllRows('t', table(n).makePage, 10);
      const par = await fetchAllRows('t', table(n).makePage, 10, {concurrency: 4});
      expect(par).toEqual(seq);
      expect(par.map((r) => r.i)).toEqual(Array.from({length: n}, (_, i) => i));
    }
  });

  it('fetches a batch of pages at once and stops at the first short page', async () => {
    const t = table(25);
    await fetchAllRows('t', t.makePage, 10, {concurrency: 4});
    expect(t.calls).toEqual([
      [0, 9],
      [10, 19],
      [20, 29],
      [30, 39],
    ]); // one round trip instead of three
  });

  it('surfaces a page error', async () => {
    const bad = async (from: number) => (from === 10 ? {data: null, error: {message: 'boom'}} : {data: Array.from({length: 10}, () => ({})), error: null});
    await expect(fetchAllRows('gl_x', bad, 10, {concurrency: 3})).rejects.toThrow('gl_x read failed: boom');
  });
});
