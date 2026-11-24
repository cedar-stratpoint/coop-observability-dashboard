import {getDataContext} from '@/src/active-context';
import {auditData, type AuditParams} from '@/src/goldline-audit-data';
import {AuditMatrix} from '@/components/analyst/audit-matrix';

export const dynamic = 'force-dynamic';

// Reconciliation · By store (NICH-17): per product per store (or every store), counted vs
// sold vs on the PO form, with the recommendation. Scoped to the active company, and to the
// role's stores when it is limited to some.
export default async function Page(props: {searchParams: Promise<Record<string, string | string[] | undefined>>}) {
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
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : null);
  const params: AuditParams = {store: one('store'), month: one('month'), state: one('state'), q: one('q'), sort: one('sort'), dir: one('dir'), page: one('page')};
  const data = await auditData(ctx.companyId, params, ctx.storeScope ?? null);
  // Keyed by store and month: a new selection starts from its own query.
  return <AuditMatrix key={`${data.selected?.code ?? ''}|${data.selected?.month ?? ''}`} data={data} />;
}
