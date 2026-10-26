import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {getFlagsData} from '@/src/goldline-flags-data';
import {GoldlineFlags} from '@/components/analyst/goldline-flags';

export const dynamic = 'force-dynamic';

// Flag queue and adjustments (Goldline · F7, F5). Store-scoped roles see their stores only.
export default async function Page() {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Pick a company you belong to to see its flags.</p>
      </div>
    );
  }
  const scope = Array.isArray(ctx.storeScope) ? ctx.storeScope : null;
  const data = await getFlagsData(ctx.companyId, scope);
  return <GoldlineFlags company={ctx.companyId} data={data} canEdit={canEditData(ctx.role)} />;
}
