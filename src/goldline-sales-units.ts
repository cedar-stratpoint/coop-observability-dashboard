import 'server-only';
import {createHash} from 'node:crypto';
import {gunzipSync, gzipSync} from 'node:zlib';
import {nichidoDb} from './nichido-client';
import {cachedSalesView} from './goldline-ref-data';

/** One sales row with its units, as sales_units() returns it. */
export type SalesUnitsRow = {store_code: string; sku_code: string; period_start: string; period_end: string; units: number | null};

type SalesUnitsFilter = {fromStart?: string; fromEnd?: string; stores?: string[] | null; skus?: string[] | null};

// Cached entries are kept gzipped and only up to this size: the data cache takes at most
// 2 MB an entry (and throws over it in dev). A bigger result is read fresh every time.
const CACHE_MAX_CHARS = 1_500_000;

const listKey = (xs: string[] | null | undefined) =>
  xs ? createHash('sha1').update([...xs].sort().join(',')).digest('base64url') : '*';

async function readSalesUnits(companyId: string, filter: SalesUnitsFilter): Promise<SalesUnitsRow[]> {
  const res = await nichidoDb().rpc('sales_units', {
    p_company: companyId,
    p_from_start: filter.fromStart ?? null,
    p_from_end: filter.fromEnd ?? null,
    p_stores: filter.stores ?? null,
    p_skus: filter.skus ?? null,
  });
  if (res.error) throw new Error(`sales_units failed: ${res.error.message}`);
  return (res.data ?? []) as SalesUnitsRow[];
}

/** Sales rows with their units. Units are encrypted at rest with the money
 *  (supabase/nichido/s3_sales_units_encryption.sql), so they can't be selected from
 *  `sales` directly; sales_units() decrypts the matching rows and returns them as one
 *  jsonb array (no PostgREST row cap, one decrypt per call). Every filter is optional:
 *  fromStart / fromEnd keep rows whose period_start / period_end is on or after it.
 *
 *  Cached like the other sales reads (cachedSalesView: under the committed sales files,
 *  expired by a sales write), since the inventory board, product page, audit and flags
 *  each ran it on every load. */
export async function salesUnits(companyId: string, filter: SalesUnitsFilter): Promise<SalesUnitsRow[]> {
  let read: SalesUnitsRow[] | null = null;
  const packed = await cachedSalesView(
    companyId,
    ['sales-units', filter.fromStart ?? '', filter.fromEnd ?? '', listKey(filter.stores), listKey(filter.skus)],
    async () => {
      read = await readSalesUnits(companyId, filter);
      const z = gzipSync(JSON.stringify(read)).toString('base64');
      return z.length <= CACHE_MAX_CHARS ? z : null;
    },
    ['sales'],
  );
  if (packed) return JSON.parse(gunzipSync(Buffer.from(packed, 'base64')).toString('utf8')) as SalesUnitsRow[];
  return read ?? readSalesUnits(companyId, filter);
}
