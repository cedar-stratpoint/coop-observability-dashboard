import {redirect} from 'next/navigation';
import {getDataContext} from '@/src/active-context';
import {getPoDates} from '@/src/goldline-po-data';
import {GoldlineOrderDates} from '@/components/analyst/goldline-orders';

export const dynamic = 'force-dynamic';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

// /stock/orders — Goldline purchase orders (F12), step one: the days POs were made, a
// month at a time (added up in the database). ?month=YYYY-MM picks the month (default: the
// newest month with POs). A date opens /stock/orders/date/YYYY-MM-DD; the old ?date= link
// redirects there. Company + store-scope fenced in the loader.
export default async function Page(props: {searchParams: Promise<{date?: string; month?: string}>}) {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Pick a company you belong to to see its purchase orders.</p>
      </div>
    );
  }
  const sp = await props.searchParams;
  if (sp.date && ISO_DAY.test(sp.date)) redirect(`/stock/orders/date/${sp.date}`);
  const {configured, dates} = await getPoDates(ctx.companyId, ctx.storeScope ?? null);
  const month = sp.month && MONTH.test(sp.month) ? sp.month : dates[0]?.date.slice(0, 7) || null;
  return <GoldlineOrderDates data={{configured, dates, month}} />;
}
