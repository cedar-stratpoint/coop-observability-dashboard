import {requireZoomyData} from '@/src/active-context';
import {getDigests} from '@/src/data';
import {getPosOrders} from '@/src/pos-sales';
import {crmConfigured, getCrmOrders} from '@/src/crm-data';
import {phDay} from '@/src/custom-range';
import {buildSalesRange, firstDigestDay, offlineInput} from '@/src/sales-range';
import {SalesRangeView} from '@/components/analyst/sales-range-view';

export const dynamic = 'force-dynamic'; // reflect the latest archive and live orders
export const metadata = {title: 'Sales range · Coop'};

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

// A source that fails must never take the page down: that channel says so and the rest still render.
async function soft<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

// Sales over any dates (`?from=&to=` or `?span=all`), built from the stored weekly digests, live CRM orders and POS orders.
// Separate from the weekly Sales page (`/?channel=all`), which is unchanged.
export default async function Page(props: {searchParams: Promise<Record<string, string | string[] | undefined>>}) {
  await requireZoomyData(); // Zoomy-only, like the Sales overview
  const sp = await props.searchParams;
  const digests = await getDigests();
  const todayDay = phDay(Date.now());
  const [pos, crm] = await Promise.all([soft(getPosOrders), crmConfigured() ? soft(getCrmOrders) : Promise.resolve(null)]);
  const view = buildSalesRange({
    span: {from: one(sp.from), to: one(sp.to), span: one(sp.span)},
    digests,
    website: crm ? {orders: crm, asOf: new Date().toISOString()} : null,
    offline: offlineInput(pos),
    firstDay: firstDigestDay(digests) ?? todayDay,
    todayDay,
  });
  return <SalesRangeView view={view} />;
}
