import {notFound} from 'next/navigation';
import {getDataContext} from '@/src/active-context';
import {getProductData} from '@/src/goldline-product-data';
import {productView} from '@/src/goldline-product';
import {GoldlineProductView} from '@/components/analyst/goldline-product-view';

export const dynamic = 'force-dynamic';

// /stock/[...item] — Goldline product page: one item's sales and stock, month by month — one store
// (?store=) or all of the caller's stores added up (no ?store=). Company + store-scope
// fenced in getProductData; an item with no catalog row and no counts is a 404.
export default async function Page(props: {params: Promise<{item: string[]}>; searchParams: Promise<{store?: string}>}) {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Pick a company you belong to to see its products.</p>
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
  const {store: requested} = await props.searchParams;

  const data = await getProductData(ctx.companyId, itemCode, ctx.storeScope ?? null);
  if (!data) notFound();

  const view = productView(data.item, data.stores, requested);
  return <GoldlineProductView data={view} />;
}
