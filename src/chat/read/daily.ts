import type {PagedResult} from '../../pos-fetch-paginate';
import {dailyRowsToDigests, type DailySalesRow} from '../../daily-sales-digests';
import type {RollupDigest} from '../../period-rollup';
import {DAILY_COLUMNS, dailyRelationForMode, type ChatReadMode} from './relations';

// The chat's OWN reader of the per-day marketplace sales (backend marketplace_daily_sales), used by get_channel_report. It takes an
// INJECTED client (the daily client, which the guard limits to the one daily relation), like read/digest.ts. No server-only, no next/*,
// no supabase-js import: pure and unit tested.

interface DailyReadBuilder extends PromiseLike<PagedResult> {
  order(column: string, options?: {ascending?: boolean}): DailyReadBuilder;
  range(from: number, to: number): DailyReadBuilder;
}
export interface DailyReadClient {
  from(relation: string): {select(columns: string): DailyReadBuilder};
}

/** PostgREST returns at most 1000 rows per request, so the read pages. */
export const DAILY_PAGE = 1000;
/** A cap, far above the table's size (two rows a day: about 730 a year). */
export const DAILY_MAX_PAGES = 10;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function toRow(raw: unknown): DailySalesRow | null {
  if (!isRecord(raw) || (raw.channel !== 'shopee' && raw.channel !== 'lazada') || typeof raw.day !== 'string') return null;
  return {
    day: raw.day,
    channel: raw.channel,
    revenue: Number(raw.revenue),
    orders: Number(raw.orders),
    units: Number(raw.units),
    window_from: String(raw.window_from ?? ''),
    window_to: String(raw.window_to ?? ''),
    captured_at: String(raw.captured_at ?? ''),
  };
}

/** Every saved day, oldest first. A row whose shape is unusable is dropped, not guessed at. Throws when a read fails. */
export async function readDailyRows(client: DailyReadClient, mode: ChatReadMode): Promise<DailySalesRow[]> {
  const out: DailySalesRow[] = [];
  for (let page = 0; page < DAILY_MAX_PAGES; page += 1) {
    const {data, error} = await client
      .from(dailyRelationForMode(mode))
      .select(DAILY_COLUMNS)
      .order('day', {ascending: true})
      .range(page * DAILY_PAGE, (page + 1) * DAILY_PAGE - 1);
    if (error) throw new Error(`daily sales read failed: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows.map(toRow).filter((r): r is DailySalesRow => r !== null));
    if (rows.length < DAILY_PAGE) break;
  }
  return out;
}

/** The saved days as digests carrying `daily`, for the rollup (see src/daily-sales-digests.ts). */
export async function readDailyDigests(client: DailyReadClient, mode: ChatReadMode): Promise<RollupDigest[]> {
  return dailyRowsToDigests(await readDailyRows(client, mode));
}
