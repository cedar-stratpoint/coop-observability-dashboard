import 'server-only';
import {getDigests} from './data';
import {getPosOrders} from './pos-sales';
import {crmConfigured, getCrmOrders} from './crm-data';
import {phDay} from './custom-range';
import {dailyRowsToDigests} from './daily-sales-digests';
import {getMarketplaceDaily} from './marketplace-daily-data';
import {buildSalesRange, firstDigestDay, offlineInput, resolveSpan, type SalesRangeView, type SpanRequest} from './sales-range';
import {getShopeeAdsWeeks, getShopeeSkuWeeks} from './shopee-weekly-data';
import {adsWeeksToDigests, skuCoverageNotes, skuWeeksToDigests} from './shopee-weekly-digests';
import type {DigestArchiveRow} from './types';

// A source that fails must never take the page down: that channel says so and the rest still render.
async function soft<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/**
 * Reads the stored digests, live CRM orders and POS orders and builds the Sales page's range view (any dates, or all time).
 * Pass the digests the page already read to avoid a second read.
 */
export async function loadSalesRange(span: SpanRequest, digests?: DigestArchiveRow[]): Promise<SalesRangeView> {
  const rows = digests ?? (await getDigests());
  const todayDay = phDay(Date.now());
  const [pos, crm, daily, adsWeeks, skuWeeks] = await Promise.all([soft(getPosOrders), crmConfigured() ? soft(getCrmOrders) : Promise.resolve(null), soft(getMarketplaceDaily), soft(getShopeeAdsWeeks), soft(getShopeeSkuWeeks)]);
  const dailyDigests = dailyRowsToDigests(daily ?? []);
  const first = [firstDigestDay(rows), firstDigestDay(dailyDigests)].filter((d): d is string => d !== null).sort()[0] ?? todayDay;
  // Imported weekly Shopee ads and SKU reports feed ad spend, ROAS and top products; the coverage note is worked out for the dates the page will show.
  const dates = resolveSpan(span, {firstDay: first, todayDay});
  const weeklyDigests = [...adsWeeksToDigests(adsWeeks ?? []), ...skuWeeksToDigests(skuWeeks ?? [])];
  return buildSalesRange({
    span,
    digests: rows,
    dailyDigests,
    website: crm ? {orders: crm, asOf: new Date().toISOString()} : null,
    offline: offlineInput(pos),
    firstDay: first,
    todayDay,
    weeklyDigests,
    weeklyNotes: skuCoverageNotes(skuWeeks ?? [], daily ?? [], dates.fromDay, dates.toDay),
  });
}
