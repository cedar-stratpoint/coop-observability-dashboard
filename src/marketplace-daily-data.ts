import 'server-only';
import {unstable_cache} from 'next/cache';
import type {SupabaseClient} from '@supabase/supabase-js';
import {posClient, usingPosMock} from './pos-data';
import {fetchAllRows} from './pos-fetch-paginate';
import type {DailySalesRow} from './daily-sales-digests';

/**
 * `marketplace_daily_sales` (backend-owned, supabase/marketplace_daily_sales.sql in zoomy-observability): one row per PH day per
 * Shopee or Lazada channel, written by every digest run. Read with the service role, server-side only (RLS on, no policies).
 * Soft by design: mock mode, a missing table (the SQL not applied yet) or a failed read gives no rows, and the Sales page falls
 * back to the stored digests' own per-day figures.
 */
const COLUMNS = 'day,channel,revenue,orders,units,window_from,window_to,captured_at';

/** The rows, oldest day first. Throws on a read error (the cached wrapper turns that into "no rows"). */
export async function readDailyRows(supabase: SupabaseClient): Promise<DailySalesRow[]> {
  const rows = await fetchAllRows('marketplace_daily_sales', (from, to) => supabase.from('marketplace_daily_sales').select(COLUMNS).order('day', {ascending: true}).order('channel', {ascending: true}).range(from, to));
  return (rows as Record<string, unknown>[]).map((r) => ({
    day: String(r.day),
    channel: r.channel as DailySalesRow['channel'],
    revenue: Number(r.revenue),
    orders: Number(r.orders),
    units: Number(r.units),
    window_from: String(r.window_from),
    window_to: String(r.window_to),
    captured_at: String(r.captured_at),
  }));
}

const readCached = unstable_cache(
  async (): Promise<DailySalesRow[]> => {
    try {
      return await readDailyRows(posClient());
    } catch (error) {
      console.warn(`marketplace_daily_sales read failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  },
  ['marketplace-daily-sales'],
  {revalidate: 300, tags: ['digest-archive']}, // the batch revalidates this tag after a digest run, like the digests
);

export const getMarketplaceDaily = (): Promise<DailySalesRow[]> => (usingPosMock() ? Promise.resolve([]) : readCached());
