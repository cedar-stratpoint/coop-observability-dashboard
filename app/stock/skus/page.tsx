import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {getSkuLinkData} from '@/src/goldline-sku-links-data';
import {GoldlineSkuLinks} from '@/components/analyst/goldline-sku-links';

export const dynamic = 'force-dynamic';

// Watsons SKU links (Goldline). Company-wide: a store-scoped role sees it but can't change it.
export default async function Page() {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Pick a company you belong to to see its SKU links.</p>
      </div>
    );
  }
  const data = await getSkuLinkData(ctx.companyId);
  const canEdit = canEditData(ctx.role) && !Array.isArray(ctx.storeScope);
  return <GoldlineSkuLinks company={ctx.companyId} data={data} canEdit={canEdit} />;
}
