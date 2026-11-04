import {getDataContext} from '@/src/active-context';
import {auditData} from '@/src/goldline-audit-data';
import {AuditMatrix} from '@/components/analyst/audit-matrix';

export const dynamic = 'force-dynamic';

// Reconciliation audit (Phase 4, NICH-17): per SKU per store, counted-in-form vs
// sold-in-Watsons, with the action. Scoped to the active company like the rest of the
// Goldline surface.
export default async function Page(props: {searchParams: Promise<{store?: string; month?: string}>}) {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">The reconciliation audit is scoped to a company. Pick one you belong to.</p>
      </div>
    );
  }
  const sp = await props.searchParams;
  const data = await auditData(ctx.companyId, {store: sp.store ?? null, month: sp.month ?? null});
  return <AuditMatrix data={data} />;
}
