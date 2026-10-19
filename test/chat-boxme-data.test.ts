import {describe, expect, it} from 'vitest';
import {loadBoxmeData} from '../src/chat/read/boxme-data';
import type {StockReadClient} from '../src/chat/read/stock-data';

// B2 (plan 2026-10-19-ask-coop-inventory-plan.md): Ask Coop reads the BoxMe feed through the registry views with the page's columns
// and mapping; a failed read is null (the chat then says BoxMe is not connected), never zeros.
type Row = Record<string, unknown>;
function fake(rows: Record<string, Row[]>, failOn?: string) {
  const reads: {relation: string; columns: string}[] = [];
  const client = {
    from(relation: string) {
      return {
        select(columns: string) {
          reads.push({relation, columns});
          const result = {data: failOn === relation ? null : (rows[relation] ?? []), error: failOn === relation ? {message: 'relation does not exist'} : null};
          const b = {order: () => b, eq: () => b, gte: () => b, range: () => b, limit: () => b, then: (res: (v: typeof result) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej)};
          return b;
        },
      };
    },
  } as unknown as StockReadClient;
  return {client, reads};
}
const NOW = new Date('2026-10-19T03:00:00Z');

describe('loadBoxmeData', () => {
  it('reads the six coop_chat_boxme_* views (ro_role) and maps rows like the Inventory page', async () => {
    const {client, reads} = fake({
      coop_chat_boxme_products: [{seller_sku: 'P1', name: 'Chicken Jerky', active: true, sale_price: '250', min_quantity: 5, expiry_threshold: null, image_url: null}],
      coop_chat_boxme_stock: [{seller_sku: 'P1', pickup_id: '7', stock: 30, awaiting: 0, reserved: 4, available: 26, incoming: 10, damaged_stock: 1, damaged_available: 0, synced_at: '2026-10-19T01:31:00Z'}],
      coop_chat_boxme_sync_runs: [{id: 9, started_at: '2026-10-19T01:30:00Z', finished_at: '2026-10-19T01:31:00Z', status: 'ok', skus_seen: 20, skus_written: 19}],
    });
    const feed = await loadBoxmeData(client, 'ro_role', NOW);
    expect([...new Set(reads.map((r) => r.relation))].sort()).toEqual([
      'coop_chat_boxme_products', 'coop_chat_boxme_stock', 'coop_chat_boxme_stock_daily', 'coop_chat_boxme_stock_lots', 'coop_chat_boxme_sync_runs', 'coop_chat_boxme_warehouses',
    ]);
    expect(reads.find((r) => r.relation === 'coop_chat_boxme_sync_runs')?.columns).not.toMatch(/error|key_expires_at/);
    expect(feed?.products[0]).toMatchObject({seller_sku: 'P1', sale_price: 250, min_quantity: 5});
    expect(feed?.stock[0]).toMatchObject({available: 26, reserved: 4, incoming: 10, damaged_stock: 1});
    expect(feed?.runs[0]).toMatchObject({status: 'ok', error: null, key_expires_at: null});
  });

  it('guarded_service reads the boxme_* tables with the same columns', async () => {
    const {client, reads} = fake({});
    await loadBoxmeData(client, 'guarded_service', NOW);
    expect(reads.every((r) => r.relation.startsWith('boxme_'))).toBe(true);
  });

  it('missing views (SQL not applied) or a failed read is null, never an empty feed', async () => {
    expect(await loadBoxmeData(fake({}, 'coop_chat_boxme_sync_runs').client, 'ro_role', NOW)).toBeNull();
    expect(await loadBoxmeData(fake({}, 'coop_chat_boxme_stock').client, 'ro_role', NOW)).toBeNull();
  });
});
