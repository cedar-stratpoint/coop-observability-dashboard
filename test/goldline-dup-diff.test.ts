import {describe, expect, it} from 'vitest';
import {diffExtractions, type DiffRow} from '../src/goldline-dup-diff';

const r = (code: string, v: Partial<Omit<DiffRow, 'item_code'>> = {}): DiffRow => ({item_code: code, ...v});

describe('diffExtractions', () => {
  it('reports identical reads', () => {
    const rows = [r('FBPP01', {ending_on_hand: 7, delivery: 2}), r('FBPP02', {ending_on_hand: 3})];
    const d = diffExtractions(rows, rows.map((x) => ({...x})));
    expect(d.identical).toBe(true);
    expect(d.differingItems).toBe(0);
  });

  it('shows changed fields as from (prior) → to (current)', () => {
    const cur = [r('FBPP01', {ending_on_hand: 9, stockroom: 4})];
    const prior = [r('FBPP01', {ending_on_hand: 7, stockroom: 4})];
    const d = diffExtractions(cur, prior);
    expect(d.identical).toBe(false);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0].fields).toEqual([{field: 'ending_on_hand', from: 7, to: 9}]);
  });

  it('treats a newly-filled cell (null → number) as a change', () => {
    const d = diffExtractions([r('FBPP01', {delivery: 5})], [r('FBPP01', {delivery: null})]);
    expect(d.changed[0].fields).toEqual([{field: 'delivery', from: null, to: 5}]);
  });

  it('separates added and removed items', () => {
    const d = diffExtractions([r('FBPP01', {ending_on_hand: 1}), r('NEW', {ending_on_hand: 2})], [r('FBPP01', {ending_on_hand: 1}), r('GONE', {ending_on_hand: 3})]);
    expect(d.added.map((x) => x.item_code)).toEqual(['NEW']);
    expect(d.removed.map((x) => x.item_code)).toEqual(['GONE']);
    expect(d.differingItems).toBe(2);
  });
});
