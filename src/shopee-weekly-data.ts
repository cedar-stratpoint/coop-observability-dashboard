import 'server-only';
import {unstable_cache} from 'next/cache';
import {posClient, usingPosMock} from './pos-data';
import {fetchAllRows} from './pos-fetch-paginate';
import type {AdsWeekRow, SkuWeekRow} from './shopee-weekly-digests';

/**
 * `marketplace_ads_weekly` and `marketplace_sku_weekly` (views over the imported Shopee weekly reports, supabase/shopee_weekly_reports.sql):
 * the rows of the newest accepted import for each week. Service role, server side only (RLS on, no policies). Soft by design: mock mode, a missing
 * view (the SQL not applied yet) or a failed read gives no rows, and the Sales page falls back to the stored digests.
 */
const readAds = unstable_cache(
  async (): Promise<AdsWeekRow[]> => {
    try {
      const sb = posClient();
      const rows = await fetchAllRows('marketplace_ads_weekly', (a, b) => sb.from('marketplace_ads_weekly').select('period_from,period_to,captured_at,seq,gmv,expense').order('period_from').order('period_to').order('seq').range(a, b));
      return rows.map((r) => ({period_from: String(r.period_from), period_to: String(r.period_to), captured_at: String(r.captured_at), gmv: Number(r.gmv), expense: Number(r.expense)}));
    } catch (error) {
      console.warn(`marketplace_ads_weekly read failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  },
  ['marketplace-ads-weekly'],
  {revalidate: 300, tags: ['digest-archive']}, // the import API revalidates this tag after an apply
);

const readSku = unstable_cache(
  async (): Promise<SkuWeekRow[]> => {
    try {
      const sb = posClient();
      const rows = await fetchAllRows('marketplace_sku_weekly', (a, b) => sb.from('marketplace_sku_weekly').select('period_from,period_to,captured_at,seq,product,variation_id,sales_confirmed,units_confirmed').order('period_from').order('period_to').order('seq').range(a, b));
      return rows.map((r) => ({period_from: String(r.period_from), period_to: String(r.period_to), captured_at: String(r.captured_at), product: String(r.product), variation_id: r.variation_id === null ? null : String(r.variation_id), sales_confirmed: Number(r.sales_confirmed), units_confirmed: Number(r.units_confirmed)}));
    } catch (error) {
      console.warn(`marketplace_sku_weekly read failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  },
  ['marketplace-sku-weekly'],
  {revalidate: 300, tags: ['digest-archive']},
);

export const getShopeeAdsWeeks = (): Promise<AdsWeekRow[]> => (usingPosMock() ? Promise.resolve([]) : readAds());
export const getShopeeSkuWeeks = (): Promise<SkuWeekRow[]> => (usingPosMock() ? Promise.resolve([]) : readSku());
