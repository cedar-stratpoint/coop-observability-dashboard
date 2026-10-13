import {describe, it, expect} from 'vitest';
import {
  syncInfo, currentRows, salesSpeed, boxmeStatus, buildBoxmeInventory, daysUntil, cleanName, filterBoxmeRows,
  type BoxmeSyncRun, type BoxmeDailyRow, type BuildInput,
} from '../src/boxme-inventory-compute';
import {DEFAULT_FORECAST_CONFIG} from '../src/pos-forecast-compute';

const NOW = new Date('2026-10-09T02:00:00Z'); // 10:00 Manila, 9 Oct
const RUN_START = '2026-10-08T23:30:00Z';

const run = (p: Partial<BoxmeSyncRun>): BoxmeSyncRun => ({
  id: 1, started_at: RUN_START, finished_at: '2026-10-08T23:30:20Z', status: 'ok',
  skus_seen: 20, skus_written: 20, error: null, key_expires_at: '2027-10-07T00:00:00Z', ...p,
});

describe('syncInfo', () => {
  it('is fresh after a recent ok run and reports key days left', () => {
    const s = syncInfo([run({})], NOW);
    expect(s.state).toBe('fresh');
    expect(s.skus).toBe(20);
    expect(s.lastGoodStartedAt).toBe(RUN_START);
    expect(s.keyDaysLeft).toBe(362);
  });

  it('is never with no runs, failed when the latest run failed, stale after 26h', () => {
    expect(syncInfo([], NOW).state).toBe('never');
    const failed = syncInfo([run({id: 2, started_at: '2026-10-09T01:00:00Z', finished_at: '2026-10-09T01:00:05Z', status: 'failed', error: 'boom'}), run({})], NOW);
    expect(failed.state).toBe('failed');
    expect(failed.error).toBe('boom');
    expect(failed.lastGoodStartedAt).toBe(RUN_START); // last good data still shown
    expect(syncInfo([run({started_at: '2026-10-07T23:30:00Z', finished_at: '2026-10-07T23:30:20Z'})], NOW).state).toBe('stale');
  });

  it('ignores a run still in progress and flags partial runs', () => {
    expect(syncInfo([run({id: 3, started_at: '2026-10-09T01:59:00Z', finished_at: null, status: 'running'}), run({})], NOW).state).toBe('fresh');
    expect(syncInfo([run({status: 'partial', error: 'lots: boxme 500'})], NOW).state).toBe('partial');
  });
});

describe('currentRows', () => {
  it('keeps only rows from the latest good run', () => {
    const rows = [{synced_at: RUN_START, k: 'now'}, {synced_at: '2026-10-01T23:30:00Z', k: 'old'}];
    expect(currentRows(rows, RUN_START).map((r) => r.k)).toEqual(['now']);
    expect(currentRows(rows, null)).toEqual([]);
  });
});

describe('salesSpeed', () => {
  const day = (d: string, stock: number, pickup = 'P'): BoxmeDailyRow => ({snapshot_date: d, seller_sku: 'A', pickup_id: pickup, stock, available: stock});

  it('needs 7 days of span before estimating', () => {
    expect(salesSpeed([day('2026-10-01', 100), day('2026-10-03', 90)])).toEqual({soldPerDay: null, historyDays: 2});
    expect(salesSpeed([])).toEqual({soldPerDay: null, historyDays: 0});
  });

  it('counts only drops, ignores restocks, sums warehouses per day', () => {
    const rows = [
      day('2026-10-01', 60), day('2026-10-01', 40, 'Q'), // 100
      day('2026-10-04', 70), day('2026-10-04', 10, 'Q'), // 80: -20
      day('2026-10-06', 200), //                             200: restock, ignored
      day('2026-10-08', 186), //                             186: -14
    ];
    expect(salesSpeed(rows)).toEqual({soldPerDay: 34 / 7, historyDays: 7});
  });
});

describe('boxmeStatus', () => {
  it('out at zero, low at or under threshold or under 14 days of cover', () => {
    expect(boxmeStatus(0, 10, null)).toBe('out');
    expect(boxmeStatus(10, 10, null)).toBe('low');
    expect(boxmeStatus(500, 10, 13)).toBe('low');
    expect(boxmeStatus(500, 10, 40)).toBe('healthy');
    expect(boxmeStatus(500, 10, null)).toBe('healthy');
  });
});

describe('daysUntil / cleanName', () => {
  it('counts Manila calendar days', () => {
    expect(daysUntil('2026-10-09', NOW)).toBe(0);
    expect(daysUntil('2026-12-08', NOW)).toBe(60);
  });
  it('drops the brand prefix', () => {
    expect(cleanName('Zoomy! Meaty Treats Beef')).toBe('Meaty Treats Beef');
  });
});

describe('buildBoxmeInventory', () => {
  const base: BuildInput = {
    now: NOW,
    config: DEFAULT_FORECAST_CONFIG, // threshold 10
    runs: [run({})],
    warehouses: [{pickup_id: '452620', warehouse_code: 'BMPH_PDC', pickup_name: 'PDC - ONLINE'}],
    products: [
      {seller_sku: 'ZMYFDMEATBEFWHL01', name: 'Zoomy! Meaty Treats Beef', active: true, sale_price: 349, min_quantity: 0, expiry_threshold: 60, image_url: null},
      {seller_sku: 'ZMYFDFDRSLMWHL01', name: 'Zoomy! Freeze-Dried Salmon Steak', active: true, sale_price: 299, min_quantity: 0, expiry_threshold: 60, image_url: null},
      {seller_sku: 'ZMYFDNEW01', name: 'Zoomy! New Thing', active: true, sale_price: 1, min_quantity: 50, expiry_threshold: null, image_url: null},
      {seller_sku: 'ZMYOLD', name: 'Old', active: false, sale_price: 1, min_quantity: 0, expiry_threshold: null, image_url: null},
    ],
    stock: [
      {seller_sku: 'ZMYFDMEATBEFWHL01', pickup_id: '452620', stock: 300, awaiting: 5, reserved: 2, available: 293, incoming: 0, damaged_stock: 1, damaged_available: 0, synced_at: RUN_START},
      {seller_sku: 'ZMYFDNEW01', pickup_id: '452620', stock: 30, awaiting: 0, reserved: 0, available: 30, incoming: 100, damaged_stock: 0, damaged_available: 0, synced_at: RUN_START},
      // Stale row from an older run: must not count.
      {seller_sku: 'ZMYFDFDRSLMWHL01', pickup_id: '452620', stock: 9, awaiting: 0, reserved: 0, available: 9, incoming: 0, damaged_stock: 0, damaged_available: 0, synced_at: '2026-10-01T23:30:00Z'},
    ],
    daily: [],
    lots: [
      {seller_sku: 'ZMYFDMEATBEFWHL01', warehouse_code: 'BMPH_PDC', batch_lot: '', expire_date: '2026-11-20', quantity: 40, synced_at: RUN_START},
      {seller_sku: 'ZMYFDMEATBEFWHL01', warehouse_code: 'BMPH_PDC', batch_lot: '', expire_date: '2027-04-15', quantity: 260, synced_at: RUN_START},
      {seller_sku: 'ZMYFDNEW01', warehouse_code: 'BMPH_PDC', batch_lot: '', expire_date: '9999-12-31', quantity: 30, synced_at: RUN_START},
    ],
    pos: [
      {product_id: 'ZMYFDMEATBEFWHL01', name: 'Meaty Treats Beef', category: 'Meaty Treats', active: true, office: 20, event: 15},
      {product_id: 'ZMYFDFDRSLMWHL01', name: 'Freeze-Dried Salmon Steak', category: 'Freeze Dried', active: true, office: 0, event: 4},
      {product_id: 'ZMYFDFDRBEFBLU01', name: 'Freeze-Dried Beef Blueberry', category: 'Freeze Dried', active: true, office: 0, event: 11},
      {product_id: 'ZMYGONE', name: 'Gone', category: null, active: false, office: 0, event: 0},
    ],
  };

  const r = buildBoxmeInventory(base);
  const bySku = Object.fromEntries(r.rows.map((x) => [x.sku, x]));

  it('lists active BoxMe products only, with POS names and categories', () => {
    expect(r.rows.map((x) => x.sku).sort()).toEqual(['ZMYFDFDRSLMWHL01', 'ZMYFDMEATBEFWHL01', 'ZMYFDNEW01']);
    expect(bySku.ZMYFDMEATBEFWHL01).toMatchObject({name: 'Meaty Treats Beef', category: 'Meaty Treats', offline: 35, inPos: true});
    expect(bySku.ZMYFDNEW01).toMatchObject({name: 'New Thing', inPos: false, offline: null});
  });

  it('treats a SKU with no current stock row as out (stale rows ignored)', () => {
    expect(bySku.ZMYFDFDRSLMWHL01).toMatchObject({available: 0, status: 'out', byWarehouse: []});
  });

  it('uses BoxMe min_quantity as the threshold when set', () => {
    expect(bySku.ZMYFDNEW01).toMatchObject({threshold: 50, status: 'low'});
    expect(bySku.ZMYFDMEATBEFWHL01).toMatchObject({threshold: 10, status: 'healthy'});
  });

  it('finds the next expiry and lists lots inside the window, skipping no-expiry lots', () => {
    expect(bySku.ZMYFDMEATBEFWHL01.nextExpiry).toEqual({date: '2026-11-20', daysLeft: 42, quantity: 40, soon: true});
    expect(bySku.ZMYFDNEW01.nextExpiry).toBeNull();
    expect(r.expiring).toEqual([{sku: 'ZMYFDMEATBEFWHL01', name: 'Meaty Treats Beef', warehouse_code: 'BMPH_PDC', batch_lot: '', date: '2026-11-20', daysLeft: 42, quantity: 40}]);
  });

  it('totals, summary and the SKU match panels', () => {
    expect(r.totals).toEqual({available: 323, awaiting: 5, reserved: 2, incoming: 100, damaged: 1, stock: 330});
    expect(r.summary).toEqual({healthy: 1, low: 1, out: 1, expiring: 1, total: 3});
    expect(r.posOnly.map((p) => p.product_id)).toEqual(['ZMYFDFDRBEFBLU01']);
    expect(r.boxmeOnly).toEqual(['ZMYFDNEW01']);
    expect(bySku.ZMYFDMEATBEFWHL01.byWarehouse[0]).toMatchObject({label: 'BMPH_PDC', available: 293});
  });

  it('filterBoxmeRows by line, status, expiring and search', () => {
    expect(filterBoxmeRows(r.rows, {line: 'Meaty Treats'}).map((x) => x.sku)).toEqual(['ZMYFDMEATBEFWHL01']);
    expect(filterBoxmeRows(r.rows, {status: 'out'}).map((x) => x.sku)).toEqual(['ZMYFDFDRSLMWHL01']);
    expect(filterBoxmeRows(r.rows, {status: 'expiring'}).map((x) => x.sku)).toEqual(['ZMYFDMEATBEFWHL01']);
    expect(filterBoxmeRows(r.rows, {search: 'new'}).map((x) => x.sku)).toEqual(['ZMYFDNEW01']);
  });
});
