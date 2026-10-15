// Loads the registry stock metrics' input (Train 3 Task 8) through the guarded chat read client: stock per location, product names,
// sale movements of the forecast window and the saved forecast config. Explicit columns, paged, ordered by a unique key. Never throws:
// a failed read is null, and the stock metrics say so; the sales metrics are unaffected.
import {fetchAllRows} from '../../pos-fetch-paginate';
import {FORECAST_WINDOW_DAYS} from '../../pos-forecast-compute';
import {manilaDayKey} from '../../pos-sales-compute';
import {parseStockConfig} from '../../pos-stock-config';
import type {StockData} from '../result-types';
import {relationsForMode, type ChatReadMode} from './relations';

type Row = Record<string, unknown>;
interface StockReadBuilder extends PromiseLike<{data: Row[] | null; error: {message: string} | null}> {
  order(column: string, opts?: {ascending?: boolean}): StockReadBuilder;
  eq(column: string, value: string): StockReadBuilder;
  gte(column: string, value: string): StockReadBuilder;
  range(from: number, to: number): StockReadBuilder;
  limit(n: number): StockReadBuilder;
}
/** The slice of the chat read client this loader uses (supabase-js through the guarded fetch in production). */
export interface StockReadClient {
  from(relation: string): {select(columns: string): StockReadBuilder};
}

export async function loadStockData(client: StockReadClient, mode: ChatReadMode, now: Date): Promise<StockData | null> {
  try {
    const {tables, columns} = relationsForMode(mode);
    const since = new Date(now.getTime() - FORECAST_WINDOW_DAYS * 86_400_000).toISOString();
    const [byLocation, products, sales, settings] = await Promise.all([
      fetchAllRows(tables.stock, (from, to) => client.from(tables.stock).select(columns.stock).order('product_id', {ascending: true}).order('location', {ascending: true}).range(from, to)),
      fetchAllRows(tables.products, (from, to) => client.from(tables.products).select(columns.products).order('product_id', {ascending: true}).range(from, to)),
      fetchAllRows(tables.saleMovements, (from, to) => client.from(tables.saleMovements).select(columns.saleMovements).eq('reason', 'sale').gte('created_at', since).order('id', {ascending: true}).range(from, to)),
      // an async wrapper: a synchronous throw here must reject this one promise, not leave the others unhandled
      (async () => client.from(tables.stockConfig).select(columns.stockConfig).eq('key', 'stock_forecast_config').limit(1))(),
    ]);
    if (settings.error) return null;
    return {
      byLocation: byLocation.map((r) => ({product_id: String(r.product_id), location: String(r.location), stock: Number(r.stock ?? 0)})),
      names: Object.fromEntries(products.map((p) => [String(p.product_id), String(p.name ?? p.product_id)])),
      sales: sales.map((m) => ({product_id: String(m.product_id), qty: Math.abs(Number(m.delta ?? 0)), day: manilaDayKey(String(m.created_at))})),
      config: parseStockConfig(settings.data?.[0]?.value),
      asOf: now.toISOString(),
    };
  } catch {
    return null;
  }
}
