import {describe, it, expect} from 'vitest';
import {METRICS, METRIC_IDS, sharesOf} from '../src/chat/metrics-registry';
import type {MetricId} from '../src/chat/result-types';

const ALL: MetricId[] = ['offline_revenue', 'offline_orders', 'offline_aov', 'top_products', 'payment_mix', 'event_rollup', 'pet_mix', 'bundle_sales', 'bundle_picks', 'stock_on_hand', 'stock_cover'];

describe('METRICS registry', () => {
  it('declares exactly the nine order metrics and the two stock metrics, keyed by their id', () => {
    expect([...METRIC_IDS].sort()).toEqual([...ALL].sort());
    expect(Object.keys(METRICS).sort()).toEqual([...ALL].sort());
    for (const id of ALL) expect(METRICS[id].id).toBe(id);
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(METRICS)).toBe(true);
    expect(Object.isFrozen(METRIC_IDS)).toBe(true);
    for (const id of ALL) {
      const d = METRICS[id];
      expect(Object.isFrozen(d), id).toBe(true);
      expect(Object.isFrozen(d.dimensions), id).toBe(true);
      expect(Object.isFrozen(d.measures), id).toBe(true);
      expect(Object.isFrozen(d.profile), id).toBe(true);
      for (const m of d.measures) expect(Object.isFrozen(m), `${id}.${m.key}`).toBe(true);
    }
    expect(() => {
      (METRICS as Record<string, unknown>).extra = 1;
    }).toThrow();
  });

  for (const id of ALL) {
    describe(id, () => {
      const d = METRICS[id];

      it('has a label and a one-line description', () => {
        expect(d.label.length).toBeGreaterThan(0);
        expect(d.description.length).toBeGreaterThan(0);
        expect(d.description).not.toContain('\n');
      });

      it('declares every measure with a non-empty one-line method, and a valid kind and unit', () => {
        expect(d.measures.length).toBeGreaterThan(0);
        const keys = d.measures.map((m) => m.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const m of d.measures) {
          expect(m.label.length, m.key).toBeGreaterThan(0);
          expect(m.method.trim().length, `${m.key} method`).toBeGreaterThan(0);
          expect(m.method, m.key).not.toContain('\n');
          expect(['measured', 'allocated', 'derived']).toContain(m.kind);
          expect(['PHP', 'count', 'units', 'ratio']).toContain(m.unit);
        }
      });

      it('has a default measure and a default dimension that it declares', () => {
        expect(d.measures.map((m) => m.key)).toContain(d.defaultMeasure);
        expect(d.dimensions.map((x) => x.key)).toContain(d.defaultDimension);
      });

      it('has a closed, unique dimension list, never "default"', () => {
        const keys = d.dimensions.map((x) => x.key);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys).not.toContain('default');
        for (const x of d.dimensions) expect(['aggregate', 'category', 'series', 'matrix']).toContain(x.shape);
      });

      it('has consistent flags and profile', () => {
        if (d.supportsCompare) expect(d.dimensions.some((x) => x.shape === 'aggregate' || x.shape === 'category')).toBe(true);
        expect(d.profile.headlineColumns.length).toBeGreaterThan(0);
        expect(['compare', 'trend', 'composition', 'single', 'detail']).toContain(d.profile.job);
        expect(typeof d.compute).toBe('function');
      });
    });
  }

  it('states the documented methods and kinds', () => {
    const find = (id: MetricId, key: string) => METRICS[id].measures.find((m) => m.key === key);
    expect(find('offline_revenue', 'revenue')?.method).toBe('Sum of order totals, completed (not voided) orders only');
    expect(find('offline_aov', 'aov')).toMatchObject({kind: 'derived', method: 'Revenue divided by number of orders, derived; empty when there are no orders'});
    expect(find('bundle_picks', 'revenue')).toMatchObject({kind: 'allocated', method: "Each bundle's paid price is split across its picks in proportion to each pick's list price on the day it sold (an allocation, not a receipt)"});
    expect(find('bundle_picks', 'list_value')).toMatchObject({kind: 'derived', method: 'The picks valued at their list price on the day they sold'});
    expect(find('bundle_picks', 'units')?.kind).toBe('measured');
  });

  it('declares the dimensions and measures of the brief', () => {
    const dims = (id: MetricId) => METRICS[id].dimensions.map((x) => x.key);
    const measures = (id: MetricId) => METRICS[id].measures.map((x) => x.key);
    for (const id of ['offline_revenue', 'offline_orders', 'offline_aov'] as const) expect(dims(id)).toEqual(['none', 'day', 'week']);
    for (const id of ['top_products', 'payment_mix', 'event_rollup', 'pet_mix'] as const) expect(dims(id)).toEqual(['none']);
    expect(dims('bundle_sales')).toEqual(['none', 'pet_type', 'bundle', 'bundle_by_pet']);
    expect(dims('bundle_picks')).toEqual(['sku', 'sku_by_pet', 'bundle_by_sku']);
    expect(measures('offline_revenue')).toEqual(['revenue']);
    expect(measures('offline_orders')).toEqual(['orders']);
    expect(measures('offline_aov')).toEqual(['aov']);
    expect(measures('top_products')).toEqual(['revenue', 'units']);
    expect(measures('bundle_picks')).toEqual(['revenue', 'list_value', 'units']);
    expect(measures('bundle_sales')).toEqual(['revenue', 'orders']);
  });

  it('supports the pet filter everywhere except pet_mix', () => {
    const orders = ALL.filter((id) => !id.startsWith('stock_')); // stock is "as of now": no pet or event filter
    for (const id of orders) expect(METRICS[id].supportsPet, id).toBe(id !== 'pet_mix');
    for (const id of orders) expect(METRICS[id].supportsEvent, id).toBe(true);
    for (const id of ['stock_on_hand', 'stock_cover'] as const) expect([METRICS[id].supportsPet, METRICS[id].supportsEvent, METRICS[id].supportsCompare]).toEqual([false, false, false]);
  });
});

describe('sharesOf', () => {
  it('rounds to one decimal and is null (never 0) when there is nothing to share', () => {
    expect(sharesOf([75, 25])).toEqual([75, 25]);
    expect(sharesOf([800, 650, 150, 100, 80])[0]).toBe(44.9);
    expect(sharesOf([0, 0])).toEqual([null, null]);
    expect(sharesOf([])).toEqual([]);
  });

  it('always adds to 100.0 within the 0.1 reconcile tolerance, whatever the values', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let n = 1; n <= 25; n++) {
      for (let k = 0; k < 20; k++) {
        const values = Array.from({length: n}, () => Math.round(rnd() * 100000) / 100);
        const total = (sharesOf(values) as number[]).reduce((s, v) => s + v, 0);
        expect(Math.abs(total - 100), `${n} values`).toBeLessThanOrEqual(0.1 + 1e-9);
      }
    }
    for (const n of [3, 7, 9, 13, 19]) expect(Math.abs((sharesOf(Array(n).fill(1)) as number[]).reduce((s, v) => s + v, 0) - 100)).toBeLessThanOrEqual(0.1 + 1e-9);
  });
});
