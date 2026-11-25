import {beforeEach, describe, expect, it, vi} from 'vitest';

// The reader end to end on stand-in data: how the three sources become marks, and that a
// role limited to some stores never sees another store's lines, counts or totals.

const h = vi.hoisted(() => ({
  index: {} as Record<string, string[]>,
  counts: {} as Record<string, Record<string, [number | null, number | null, number | null, number | null, string | null]>>,
  history: {} as Record<string, Record<string, number[]>>,
  loaded: new Set<string>(),
  po: null as null | {id: string; fileName: string; activatedAt: string | null; items: Set<string>},
  askedStores: [] as Array<string[] | null>,
}));

vi.mock('server-only', () => ({}));
vi.mock('../src/nichido-client', () => ({
  nichidoConfigured: () => true,
  nichidoDb: () => ({
    rpc: async (fn: string, args: {p_stores?: string[] | null}) => {
      if (fn === 'audit_count_index') return {data: h.index, error: null};
      h.askedStores.push(args.p_stores ?? null);
      return {data: Object.fromEntries(Object.entries(h.counts).filter(([s]) => !args.p_stores || args.p_stores.includes(s))), error: null};
    },
  }),
}));
vi.mock('../src/pos-fetch-paginate', () => ({fetchAllRows: async () => ['1', '2', '3'].map((c) => ({store_code: c, name: `STORE ${c}`}))}));
vi.mock('../src/goldline-ref-data', () => ({
  getGlCatalog: async () =>
    [
      ['FBPP01', 'sku1'],
      ['EXT193', 'sku2'],
      ['FP01201', 'sku3'],
      ['MUR', null],
    ].map(([item_code, sku_code]) => ({item_code, sku_code, product_line: 'Line', variant: item_code, hidden: false, retired_at: null})),
}));
vi.mock('../src/goldline-forecast-data', () => ({
  forecastHistory: async () => h.history,
  forecastMonths: async (_c: string, months: string[]) => months.map((m) => ({month: m, loaded: h.loaded.has(m.slice(0, 7)), units: 0, unlinked_units: 40})),
}));
vi.mock('../src/goldline-po-form-data', () => ({getActivePoSet: async () => h.po, shadeOf: () => ''}));

import {auditData, auditExport, productAuditData} from '../src/goldline-audit-data';

const MONTH = new Date().toISOString().slice(0, 7);

beforeEach(() => {
  h.index = {[MONTH]: ['1', '2']};
  h.counts = {
    '1': {FBPP01: [5, 1, 1, 1, 'v1'], EXT193: [null, 2, null, 4, 'v1']}, // ending written; shelf counts only
    '2': {EXT193: [null, null, null, null, 'v1']}, // nothing written
  };
  h.history = {'1': {FBPP01: [3], EXT193: [2], FP01201: [4]}, '2': {EXT193: [1]}, '3': {EXT193: [9]}};
  h.loaded = new Set([MONTH]);
  h.po = {id: 'x', fileName: 'po.xlsx', activatedAt: null, items: new Set(['FBPP01'])};
  h.askedStores = [];
});

const at = (rows: Array<{store: string; item_code: string; reco: string}>) => Object.fromEntries(rows.map((r) => [`${r.store}:${r.item_code}`, r.reco]));

describe('marks from the three sources', () => {
  it('one store: YYY, YYX and YXX, each with its recommendation', async () => {
    const d = await auditData('goldline', {store: '1'});
    expect(at(d.rows)).toEqual({'1:FBPP01': 'Keep', '1:EXT193': 'Retire, sell through', '1:FP01201': 'Send to accounting'});
    expect(d.summary).toMatchObject({ok: 1, phasing_out: 1, accounting: 1, unknown: 0});
    // On hand: the written ending wins; with none, the shelf counts add up (as on the product page).
    expect(Object.fromEntries(d.rows.map((r) => [r.item_code, r.onHand]))).toEqual({FBPP01: 5, EXT193: 6, FP01201: null});
  });

  it('YYX across all stores finds only the real one; Y?X finds the stores with no count or a blank', async () => {
    const yyx = await auditData('goldline', {store: 'all', q: 'YYX'});
    expect(yyx.rows.map((r) => `${r.store}:${r.item_code}`)).toEqual(['1:EXT193']);
    const yqx = await auditData('goldline', {store: 'all', q: 'Y?X'});
    expect(yqx.rows.map((r) => `${r.store}:${r.item_code}:${r.why}`).sort()).toEqual(['2:EXT193:blank', '3:EXT193:no_count']);
    expect(yqx.coverage).toMatchObject({storesSold: 3, storesCounted: 2, unlinkedUnits: 40});
  });

  it('a month with no sales recommends nothing', async () => {
    h.loaded = new Set();
    const d = await auditData('goldline', {store: '1'});
    expect(d.rows.length).toBeGreaterThan(0);
    expect(d.summary.needsAction).toBe(0);
    expect(d.rows.every((r) => r.state === 'unknown')).toBe(true);
    expect(d.query.state).toBe('unknown');
  });

  it('no PO form in use recommends nothing', async () => {
    h.po = null;
    expect((await auditData('goldline', {store: '1'})).rows.every((r) => r.state === 'unknown')).toBe(true);
  });
});

describe('the store picker', () => {
  it('opens on every store, and flags the stores with a form', async () => {
    const d = await auditData('goldline', {});
    expect(d.selected?.code).toBe('all');
    expect(d.stores.map((s) => `${s.code}:${s.counted}`)).toEqual(['1:true', '2:true', '3:false']);
    expect((await auditData('goldline', {store: 'nope'})).selected?.code).toBe('all');
  });
});

describe('a role limited to some stores', () => {
  it('sees only its stores, whatever it asks for', async () => {
    const d = await auditData('goldline', {store: 'all'}, ['2']);
    expect(d.stores.map((s) => s.code)).toEqual(['2']);
    expect(d.rows.every((r) => r.store === '2')).toBe(true);
    expect(d.coverage).toEqual({loaded: true, storesSold: 1, storesCounted: 1, unlinkedUnits: 0});
    const asked = await auditData('goldline', {store: '1'}, ['2']); // another store's code in the URL
    expect(asked.selected?.code).toBe('all');
    expect(asked.rows.every((r) => r.store === '2')).toBe(true);
    expect(h.askedStores.flat()).not.toContain('1'); // never even read
  });
  it('in the CSV and By product too', async () => {
    const out = await auditExport('goldline', {store: 'all', q: 'EXT193'}, ['2']);
    expect(out!.rows.map((r) => r.store)).toEqual(['2']);
    const p = await productAuditData('goldline', {}, ['2']);
    expect(p.storeCount).toBe(1);
    expect(p.rows.every((r) => r.stores === 1)).toBe(true);
  });
  it('with no stores assigned sees nothing, not everything', async () => {
    expect(await auditData('goldline', {store: 'all'}, [])).toMatchObject({rows: [], stores: [], selected: null});
    expect(await auditExport('goldline', {store: 'all'}, [])).toBeNull();
    expect((await productAuditData('goldline', {}, [])).rows).toEqual([]);
  });
});
