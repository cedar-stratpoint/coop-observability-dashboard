import 'server-only';
import {nichidoDb} from './nichido-client';

/** One sales row with its units, as sales_units() returns it. */
export type SalesUnitsRow = {store_code: string; sku_code: string; period_start: string; period_end: string; units: number | null};

/** Sales rows with their units. Units are encrypted at rest with the money
 *  (supabase/nichido/s3_sales_units_encryption.sql), so they can't be selected from
 *  `sales` directly; sales_units() decrypts the matching rows and returns them as one
 *  jsonb array (no PostgREST row cap, one decrypt per call). Every filter is optional:
 *  fromStart / fromEnd keep rows whose period_start / period_end is on or after it. */
export async function salesUnits(
  companyId: string,
  filter: {fromStart?: string; fromEnd?: string; stores?: string[] | null; skus?: string[] | null},
): Promise<SalesUnitsRow[]> {
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
