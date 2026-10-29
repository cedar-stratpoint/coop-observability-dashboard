import {getDataContext} from '@/src/active-context';
import {getSkuActivity} from '@/src/goldline-sku-links-data';
import {SkuActivityPage} from '@/components/analyst/goldline-sku-activity';

export const dynamic = 'force-dynamic';

// SKU linking's full activity trail (Goldline). Read-only: who decided, remarked, noted or undid what.
export default async function Page() {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Pick a company you belong to to see its SKU linking activity.</p>
      </div>
    );
  }
  return <SkuActivityPage events={await getSkuActivity(ctx.companyId)} />;
}
