import type {BoxmeProduct, BoxmeWarehouse, BoxmeStockRow, BoxmeDailyRow, BoxmeLotRow, BoxmeSyncRun} from './boxme-inventory-compute';

// Demo data for the BoxMe (Online) channel when the Supabase env is absent.
// SKUs, names, prices, the warehouse and expiry dates come from a real BoxMe API
// dry run (8 Oct 2026); stock levels are that day's figures, and the 21-day
// history is synthetic so the "Lasts" column has something to show.

const RAW: [sku: string, name: string, price: number, stock: number, damaged: number, expiry: string | null][] = [
  ['ZMYFDJRKDCKPER01', 'Zoomy! Super Duo Bites Duck Pear', 329, 44, 0, '2027-02-28'],
  ['ZMYFDJRKCHKCAR01', 'Zoomy! Super Duo Bites Chicken Carrot', 329, 43, 0, '2027-02-28'],
  ['ZMYFDJRKDCKCAR01', 'Zoomy! Super Duo Bites Duck Carrot', 329, 43, 0, '2027-02-28'],
  ['ZMYFDJRKDCKWHL01', 'Zoomy! Tasty Treats Duck Jerky', 279, 55, 0, '2027-02-28'],
  ['ZMYFDJRKCHKWHL01', 'Zoomy! Tasty Treats Chicken Jerky', 279, 50, 0, '2027-02-28'],
  ['ZMYFDFDRLMBLVR01', 'Zoomy! Freeze-Dried Lamb Liver Cubes', 219, 143, 0, '2027-05-22'],
  ['ZMYFDMEATCHKWHL01', 'Zoomy! Meaty Treats Chicken', 349, 319, 0, '2027-04-15'],
  ['ZMYFDMEATBEFWHL01', 'Zoomy! Meaty Treats Beef', 349, 293, 0, '2027-04-15'],
  ['ZMYFDMEATSLMWHL01', 'Zoomy! Meaty Treats Salmon', 349, 187, 0, '2027-04-15'],
  ['ZMYFDMEATDCKWHL01', 'Zoomy! Meaty Treats Duck', 349, 76, 0, '2027-04-15'],
  ['ZMYFDFDRCGRCUB01', 'Zoomy! Freeze-Dried Cat Grass Cubes', 229, 269, 0, '2027-05-22'],
  ['ZMYFDFDRCGRSTK01', 'Zoomy! Freeze-Dried Cat Grass Stick', 155, 510, 0, '2027-05-22'],
  ['ZMYFDFDRSLMWHL01', 'Zoomy! Freeze-Dried Salmon Steak', 299, 0, 0, null],
  ['ZMYFDFDRDCKBRT01', 'Zoomy! Freeze-Dried Duck Breast Cubes', 149, 1073, 0, '2027-05-22'],
  ['ZMYFDFDRCHKLVR01', 'Zoomy! Freeze-Dried Chicken Liver Cubes', 149, 292, 0, '2027-05-22'],
  ['ZMYFDFDRBEFLVR01', 'Zoomy! Freeze-Dried Beef Liver Cubes', 149, 877, 2, '2027-05-22'],
  ['ZMYFDFDRCHKBRT01', 'Zoomy! Freeze-Dried Chicken Breast Cubes', 149, 1015, 0, '2027-05-22'],
  ['ZMYFDFDRCAPWHL01', 'Zoomy! Freeze-Dried Capelin', 299, 251, 0, '2027-05-22'],
  ['ZMYFDFDRSLMCUB01', 'Zoomy! Freeze-Dried Salmon Cubes', 219, 215, 0, '2027-05-22'],
  ['ZMYFDFDRYOGWHL01', 'Zoomy! Freeze-Dried Yoghurt Cubes', 279, 1063, 25, '2027-05-22'],
];
const PICKUP = '452620';

export const MOCK_BOXME_WAREHOUSES: BoxmeWarehouse[] = [{pickup_id: PICKUP, warehouse_code: 'BMPH_PDC', pickup_name: 'PDC - ONLINE'}];

export const MOCK_BOXME_PRODUCTS: BoxmeProduct[] = RAW.map(([seller_sku, name, sale_price]) => ({
  seller_sku, name, active: true, sale_price, min_quantity: 0, expiry_threshold: 60, image_url: null,
}));

/** Build the time-relative parts (runs, stock, lots, history) against `now`. */
export function mockBoxmeFeed(now: Date) {
  const startedAt = new Date(now.getTime() - 2.5 * 3_600_000).toISOString();
  const runs: BoxmeSyncRun[] = [{
    id: 1, started_at: startedAt, finished_at: new Date(Date.parse(startedAt) + 20_000).toISOString(), status: 'ok',
    skus_seen: RAW.length, skus_written: RAW.length - 1, error: null, key_expires_at: '2027-10-07T00:00:00Z',
  }];
  const stock: BoxmeStockRow[] = RAW.filter((r) => r[3] > 0).map(([seller_sku, , , s, dmg], i) => {
    const awaiting = i % 4 === 0 ? 2 : 0;
    return {
      seller_sku, pickup_id: PICKUP, stock: s, awaiting, reserved: 0, available: Math.max(0, s - awaiting),
      incoming: seller_sku === 'ZMYFDMEATDCKWHL01' ? 120 : 0, damaged_stock: dmg, damaged_available: dmg, synced_at: startedAt,
    };
  });
  const lots: BoxmeLotRow[] = RAW.filter((r) => r[3] > 0 && r[5]).map(([seller_sku, , , s, , exp]) => ({
    seller_sku, warehouse_code: 'BMPH_PDC', batch_lot: '', expire_date: exp as string, quantity: s, synced_at: startedAt,
  }));
  // 21 days of history: each SKU sells a steady, SKU-specific number of units a day.
  const daily: BoxmeDailyRow[] = [];
  for (const [i, [seller_sku, , , s]] of RAW.entries()) {
    if (s <= 0) continue;
    const perDay = 1 + (i % 5) * 1.5;
    for (let d = 21; d >= 0; d--) {
      const date = new Date(now.getTime() + 8 * 3_600_000 - d * 86_400_000).toISOString().slice(0, 10);
      const qty = Math.round(s + perDay * d);
      daily.push({snapshot_date: date, seller_sku, pickup_id: PICKUP, stock: qty, available: qty});
    }
  }
  return {runs, stock, lots, daily};
}
