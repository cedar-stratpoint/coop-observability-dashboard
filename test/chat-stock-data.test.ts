import {describe, expect, it} from 'vitest';
import {loadStockData, type StockReadClient} from '../src/chat/read/stock-data';

type Row = Record<string, unknown>;
function fakeClient(tables: Record<string, Row[]>): StockReadClient {
  return {
    from(rel: string) {
      return {
        select() {
          let rows = [...(tables[rel] ?? [])];
          const b = {
            order: () => b,
            range: (f: number, t: number) => { rows = rows.slice(f, t + 1); return b; },
            eq: (c: string, v: string) => { rows = rows.filter((r) => r[c] === v); return b; },
            gte: (c: string, v: string) => { rows = rows.filter((r) => String(r[c]) >= v); return b; },
            limit: (n: number) => { rows = rows.slice(0, n); return b; },
            then: <T>(res: (x: {data: Row[]; error: null}) => T) => Promise.resolve({data: rows, error: null}).then(res),
          };
          return b;
        },
      };
    },
  } as unknown as StockReadClient;
}

describe('loadStockData (registry role views)', () => {
  it('reads stock, names, 60-day sales and the saved config through the ro_role views', async () => {
    const s = await loadStockData(fakeClient({
      coop_chat_stock_by_location: [{product_id: 'P1', location: 'event', stock: 12}],
      coop_chat_products: [{product_id: 'P1', name: 'Chicken Jerky'}],
      coop_chat_sale_movements: [
        {id: 1, product_id: 'P1', delta: -28, reason: 'sale', created_at: '2026-09-20T02:00:00Z'},
        {id: 2, product_id: 'P1', delta: -5, reason: 'sale', created_at: '2026-06-01T02:00:00Z'},
      ],
      coop_chat_stock_config: [{key: 'stock_forecast_config', value: {threshold: 5}}],
    }), 'ro_role', new Date('2026-09-28T04:00:00Z'));
    expect(s?.byLocation).toEqual([{product_id: 'P1', location: 'event', stock: 12}]);
    expect(s?.names).toEqual({P1: 'Chicken Jerky'});
    expect(s?.sales).toEqual([{product_id: 'P1', qty: 28, day: '2026-09-20'}]);
    expect(s?.config.threshold).toBe(5);
  });
  it('a failed read degrades to null (sales metrics keep working)', async () => {
    const broken = {from() { throw new Error('down'); }} as unknown as StockReadClient;
    expect(await loadStockData(broken, 'ro_role', new Date())).toBeNull();
  });
});
