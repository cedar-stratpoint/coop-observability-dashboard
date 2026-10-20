import 'server-only';
import {getDigests} from './data';
import {getPosOrders} from './pos-sales';
import {crmConfigured, getCrmOrders} from './crm-data';
import {phDay} from './custom-range';
import {buildSalesRange, firstDigestDay, offlineInput, type SalesRangeView, type SpanRequest} from './sales-range';
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
  const [pos, crm] = await Promise.all([soft(getPosOrders), crmConfigured() ? soft(getCrmOrders) : Promise.resolve(null)]);
  return buildSalesRange({
    span,
    digests: rows,
    website: crm ? {orders: crm, asOf: new Date().toISOString()} : null,
    offline: offlineInput(pos),
    firstDay: firstDigestDay(rows) ?? todayDay,
    todayDay,
  });
}
