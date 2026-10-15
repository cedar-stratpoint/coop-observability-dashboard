import {describe, it, expect} from 'vitest';
import {buildCoverage, describeData, phtDate, UNAVAILABLE} from '../src/chat/coverage';
import {METRICS, METRIC_IDS} from '../src/chat/metrics-registry';
import type {MetricData} from '../src/chat/result-types';
import type {PosOrder} from '../src/pos-sales-types';

const NOW = new Date('2026-10-01T04:00:00Z');

function ord(id: string, at: string, o: {pet?: PosOrder['pet_type']; status?: string} = {}): PosOrder {
  return {
    id, client_uuid: id, subtotal: 100, discount: null, total: 100, oversold: false, device_id: null, payment_method: 'cash',
    customer_handle: null, status: o.status ?? 'completed', remarks: null, created_at: at, edited_at: null, event_id: null,
    pet_type: o.pet ?? null, items: [],
  };
}
const data = (over: Partial<MetricData> = {}): MetricData => ({
  source: 'live',
  orders: [
    ord('a', '2026-09-12T16:30:00Z', {pet: 'dog'}), // PHT Sep 13
    ord('b', '2026-09-20T10:00:00+08:00'),
    ord('c', '2026-09-27T10:00:00+08:00', {pet: 'cat'}),
    ord('v', '2026-08-01T10:00:00+08:00', {status: 'voided'}),
  ],
  events: [], prices: [], priceChanges: [], bulkReads: [], ...over,
});

describe('buildCoverage', () => {
  it('counts non-voided orders, untagged share and PHT dates', () => {
    const c = buildCoverage(data());
    expect(c).toMatchObject({source: 'live', orders: 3, untaggedOrders: 1, untaggedShare: 33.3, dataFrom: '2026-09-13', dataTo: '2026-09-27', priceChangesSeen: false, eventsCount: 0});
  });

  it('handles empty data with no NaN', () => {
    const c = buildCoverage(data({orders: []}));
    expect(c).toMatchObject({orders: 0, untaggedShare: null, dataFrom: null, dataTo: null});
    expect(JSON.stringify(c)).not.toMatch(/NaN/);
  });

  it('only voided orders counts as empty', () => {
    expect(buildCoverage(data({orders: [ord('v', '2026-08-01T10:00:00+08:00', {status: 'voided'})]})).orders).toBe(0);
  });

  it('carries the mock source and price changes', () => {
    const c = buildCoverage(data({source: 'mock', priceChanges: [{product_id: 'p', old_price: 1, new_price: 2, changed_at: '2026-09-01T00:00:00Z'}]}));
    expect(c.source).toBe('mock');
    expect(c.priceChangesSeen).toBe(true);
  });
});

describe('describeData unavailable list', () => {
  it('Explore on: nothing is called "Not exposed" or "not queryable yet"', () => {
    const r = describeData({metric: 'all'}, data(), NOW, true) as {unavailable: {what: string; why: string}[]};
    const text = r.unavailable.map((u) => `${u.what} ${u.why}`).join(' ');
    expect(text).not.toMatch(/Not exposed|not queryable yet/i);
    expect(r.unavailable.find((u) => /Shopee/.test(u.what))?.why).toBe('Only in the stored digests (get_digest).');
  });

  it('Explore off: Customer-level data is still listed as not exposed', () => {
    const r = describeData({metric: 'all'}, data(), NOW) as {unavailable: {what: string; why: string}[]};
    expect(r.unavailable.find((u) => u.what === 'Customer-level data')?.why).toMatch(/Not exposed/);
  });
});

describe('describeData', () => {
  it('lists every metric for all', () => {
    const r = describeData({metric: 'all'}, data(), NOW);
    if ('error' in r) throw new Error(r.error);
    expect(r.metrics.map((m) => m.id)).toEqual([...METRIC_IDS]);
    expect(r.today).toBe('2026-10-01');
    expect(r.coverage).toMatchObject({from: '2026-09-13', to: '2026-09-27', orders: 3});
  });

  it('lists only the asked metric, with aov under offline_aov and registry flags', () => {
    const r = describeData({metric: 'offline_aov'}, data(), NOW);
    if ('error' in r) throw new Error(r.error);
    expect(r.metrics).toHaveLength(1);
    expect(r.metrics[0].measures.map((m) => m.key)).toContain('aov');
    for (const id of METRIC_IDS) {
      const d = describeData({metric: id}, data(), NOW);
      if ('error' in d) throw new Error(d.error);
      expect(d.metrics[0].supports).toEqual({pet: METRICS[id].supportsPet, event: METRICS[id].supportsEvent, compare: METRICS[id].supportsCompare});
    }
  });

  it('returns an error listing the ids for an unknown metric', () => {
    for (const bad of ['nope', '', undefined, 5]) {
      const r = describeData({metric: bad as string}, data(), NOW);
      expect('error' in r && METRIC_IDS.every((id) => r.error.includes(id))).toBe(true);
    }
  });

  it('always lists what is unavailable', () => {
    const r = describeData({metric: 'pet_mix'}, data({orders: []}), NOW);
    if ('error' in r) throw new Error(r.error);
    expect(r.unavailable).toEqual([...UNAVAILABLE]);
    const what = r.unavailable.map((u) => u.what).join('|');
    for (const w of ['Traffic', 'Meta ads', 'Shopee', 'Lazada', 'Website', 'Customer-level', 'before the first order']) expect(what).toContain(w);
    expect(r.coverage.note).toMatch(/no order data/);
  });

  it('marks mock data in the note', () => {
    const r = describeData({metric: 'all'}, data({source: 'mock'}), NOW);
    if ('error' in r) throw new Error(r.error);
    expect(r.coverage.note).toMatch(/sample data/);
  });

  it('phtDate uses Philippine time', () => {
    expect(phtDate(new Date('2026-09-30T17:00:00Z'))).toBe('2026-10-01');
    expect(phtDate(new Date('2026-09-30T15:59:00Z'))).toBe('2026-09-30');
  });
});
