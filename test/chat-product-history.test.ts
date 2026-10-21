import {describe, expect, it} from 'vitest';
import {shapeProductHistory} from '../src/chat/product-history';
import type {DigestRow} from '../src/chat/read/digest';

// FICTIONAL: two Shopee windows with their own export dates, the product in the top 5 of one only.
const row = (from: string, to: string, created: string, top: {title: string; revenue: number; units: number}[]): DigestRow =>
  ({window_from: `${from}T00:00:00.000Z`, window_to: `${to}T00:00:00.000Z`, created_at: created, digest: {window: {label: '', from, to}, degraded: false, headline: '', themes: [], figures: [], recommendations: [], shopee: {sales: {window: {from, to, label: ''}, figures: [], topProducts: top}}}} as unknown as DigestRow);

const ROWS = [
  row('2026-10-05', '2026-10-11', '2026-10-12T00:00:00Z', [{title: 'Joint Chews', revenue: 900, units: 9}]),
  row('2026-09-28', '2026-10-04', '2026-10-05T00:00:00Z', [{title: 'Yoghurt Cubes 50g', revenue: 1200, units: 12}, {title: 'Joint Powder', revenue: 500, units: 5}]),
];

describe('shapeProductHistory', () => {
  it('sums the product over the stored windows and says it is a lower bound', () => {
    const out = shapeProductHistory({product: 'yoghurt cubes'}, ROWS, '2026-10-21', false);
    if ('error' in out) throw new Error(out.error);
    expect(out.result.rows).toEqual([{channel: 'Shopee', product: 'Yoghurt Cubes 50g', revenue: 1200, units: 12}]);
    expect(out.result.meta.caveats.join(' ')).toMatch(/LOWER BOUND/);
  });
  it('merges the same title across windows', () => {
    const out = shapeProductHistory({product: 'chews'}, ROWS, '2026-10-21', false);
    if ('error' in out) throw new Error(out.error);
    expect(out.result.rows).toEqual([{channel: 'Shopee', product: 'Joint Chews', revenue: 900, units: 9}]);
  });
  it('adds a together row when several titles match', () => {
    const out = shapeProductHistory({product: 'joint'}, ROWS, '2026-10-21', false);
    if ('error' in out) throw new Error(out.error);
    expect(out.result.rows.at(-1)).toMatchObject({product: 'All matching products together', revenue: 1400, units: 14});
  });
  it('gives no figure (and says so) for a product in no top list', () => {
    const out = shapeProductHistory({product: 'Dental Sticks'}, ROWS, '2026-10-21', false);
    if ('error' in out) throw new Error(out.error);
    expect(out.result.rows).toEqual([]);
    expect(out.result.meta.caveats.join(' ')).toMatch(/not in the top-5/);
  });
  it('needs a product name', () => {
    expect(shapeProductHistory({product: ' '}, ROWS, '2026-10-21', false)).toHaveProperty('error');
  });
});
