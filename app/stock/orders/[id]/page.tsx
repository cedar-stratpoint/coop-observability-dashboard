import {notFound} from 'next/navigation';
import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {getPurchaseOrder} from '@/src/goldline-po-data';
import {GoldlinePurchaseOrder} from '@/components/analyst/goldline-po';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// /stock/orders/[id] — one Goldline purchase order (F12), laid out like Nichido's paper
// form, with the line checks and the received section. Company + store-scope fenced in
// getPurchaseOrder; an unknown PO, or one outside the role's stores, is a 404.
export default async function Page(props: {params: Promise<{id: string}>}) {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Pick a company you belong to to see its purchase orders.</p>
      </div>
    );
  }
  const {id} = await props.params;
  if (!UUID.test(id)) notFound();
  const po = await getPurchaseOrder(ctx.companyId, id, ctx.storeScope ?? null);
  if (!po) notFound();
  return <GoldlinePurchaseOrder data={{...po, company: ctx.companyId, canEdit: canEditData(ctx.role)}} />;
}
