import {notFound} from 'next/navigation';
import {getDataContext} from '@/src/active-context';
import {listPurchaseOrders} from '@/src/goldline-po-data';
import {GoldlineOrdersOfDay} from '@/components/analyst/goldline-orders';

export const dynamic = 'force-dynamic';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// /stock/orders/date/YYYY-MM-DD — Goldline purchase orders (F12), step two: one day's POs,
// one per store, filtered by status and a store search. Only that day's POs are read.
// Company + store-scope fenced in the loader; a day with no POs the role can see is a 404.
export default async function Page(props: {params: Promise<{date: string}>}) {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Pick a company you belong to to see its purchase orders.</p>
      </div>
    );
  }
  const {date} = await props.params;
  if (!ISO_DAY.test(date) || Number.isNaN(Date.parse(date))) notFound();
  const rows = await listPurchaseOrders(ctx.companyId, date, ctx.storeScope ?? null);
  if (rows.length === 0) notFound();
  return <GoldlineOrdersOfDay data={{date, rows}} />;
}
