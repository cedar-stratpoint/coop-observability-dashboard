import {notFound} from 'next/navigation';
import {getDataContext} from '@/src/active-context';
import {getRestockItem} from '@/src/goldline-restock-item-data';
import {manilaDate} from '@/src/goldline-supply';
import {GoldlineRestockItem} from '@/components/analyst/goldline-restock-item';

export const dynamic = 'force-dynamic';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// /stock/restock/[...item] — Goldline Restock, one product: its last 12 months of POS Sales
// Data, then the run's months forecast from last year's same months. ?store= picks a store
// (none = every store in view added up); ?asOf=YYYY-MM-DD previews a run on another date.
// Company + store-scope fenced in getRestockItem; an unknown item is a 404.
export default async function Page(props: {params: Promise<{item: string[]}>; searchParams: Promise<{store?: string; asOf?: string}>}) {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Pick a company you belong to to see its restock.</p>
      </div>
    );
  }
  // Catch-all: item codes can contain "/" (e.g. 24/7SEPMM), linked as %2F but possibly
  // split into segments on the way in. Rejoin, decode safely, and let the DB decide.
  const {item: parts} = await props.params;
  let itemCode: string;
  try {
    itemCode = parts.map((p) => decodeURIComponent(p)).join('/').trim();
  } catch {
    notFound();
  }
  if (!itemCode || itemCode.length > 80) notFound();
  const {store, asOf} = await props.searchParams;
  const today = manilaDate();
  const runDate = asOf && ISO_DAY.test(asOf) && !Number.isNaN(Date.parse(asOf)) ? asOf : today;

  const data = await getRestockItem(ctx.companyId, itemCode, runDate, store ?? null, ctx.storeScope ?? null);
  if (!data) notFound();
  return <GoldlineRestockItem data={{...data, runDate, today, preview: runDate !== today}} />;
}
