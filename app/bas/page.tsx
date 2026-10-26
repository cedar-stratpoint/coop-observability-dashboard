import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {getBaDirectory} from '@/src/goldline-ba-data';
import {GoldlineBas} from '@/components/analyst/goldline-bas';

export const dynamic = 'force-dynamic';

// BA list (Goldline · A1): which BA covers which store, so a form with no BA name still
// counts against the right BA. Store-scoped roles see their stores only.
export default async function Page() {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Pick a company you belong to to see its BAs.</p>
      </div>
    );
  }
  const scope = Array.isArray(ctx.storeScope) ? ctx.storeScope : null;
  const data = await getBaDirectory(ctx.companyId, scope);
  return <GoldlineBas company={ctx.companyId} data={data} canEdit={canEditData(ctx.role)} />;
}
