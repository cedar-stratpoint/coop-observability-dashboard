import {getDataContext} from '@/src/active-context';
import {productAuditData} from '@/src/goldline-audit-data';
import {AuditProducts} from '@/components/analyst/audit-products';

export const dynamic = 'force-dynamic';

// Reconciliation · By product (NICH-17): every counted store in a month, per product.
export default async function Page(props: {searchParams: Promise<{month?: string}>}) {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">The reconciliation is scoped to a company. Pick one you belong to.</p>
      </div>
    );
  }
  const sp = await props.searchParams;
  const data = await productAuditData(ctx.companyId, {month: sp.month ?? null});
  // Keyed by month: a new month opens on its own most urgent state.
  return <AuditProducts key={data.month ?? ''} data={data} />;
}
